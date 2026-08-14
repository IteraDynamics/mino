import type { QueryResultRow } from "pg";
import type { HumanApprovalEmitter, HumanApprovalEvent } from "./approval-emitter.js";

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_BASE_BACKOFF_MS = 5_000;
const DEFAULT_MAX_BACKOFF_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 12;

export interface ApprovalNotificationSqlClient {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ readonly rows: R[]; readonly rowCount: number | null }>;
}

export interface ApprovalNotificationWorkerOptions {
  readonly batchSize?: number;
  readonly leaseMs?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly maxAttempts?: number;
}

export interface ApprovalNotificationRunResult {
  readonly claimed: number;
  readonly delivered: number;
  readonly deferred: number;
  readonly deadLettered: number;
  readonly expired: number;
}

interface ClaimedApprovalRow extends QueryResultRow {
  id: string;
  decisionId: string;
  requestId: string;
  organizationId: string;
  userId: string;
  agentId: string;
  mandateId: string;
  merchantDomain: string;
  checkoutSessionId: string | null;
  amountMinor: string;
  currency: string;
  requiredSignatures: number;
  createdAt: Date;
  expiresAt: Date;
  notificationAttempts: number;
}

/**
 * Durable approval notification delivery backed by the ApprovalRequest row itself.
 *
 * Creating an ApprovalRequest is therefore also the durable outbox write: no second
 * database row or network call must succeed before the request path can return. The
 * delivery state lives under approvalData.notification and workers claim rows with
 * FOR UPDATE SKIP LOCKED so multiple workers can run safely.
 */
export class ApprovalNotificationOutboxWorker {
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxAttempts: number;

  public constructor(
    private readonly sql: ApprovalNotificationSqlClient,
    private readonly emitter: HumanApprovalEmitter,
    options: ApprovalNotificationWorkerOptions = {},
  ) {
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

    assertPositive(this.batchSize, "batch size");
    assertPositive(this.leaseMs, "lease duration");
    assertPositive(this.baseBackoffMs, "base backoff");
    assertPositive(this.maxBackoffMs, "maximum backoff");
    assertPositive(this.maxAttempts, "maximum attempts");
    if (this.maxBackoffMs < this.baseBackoffMs) {
      throw new Error("Approval notification maximum backoff cannot be lower than base backoff");
    }
  }

  public async runOnce(workerId: string, now: Date): Promise<ApprovalNotificationRunResult> {
    if (!workerId.trim()) {
      throw new Error("Approval notification worker ID is required");
    }

    const claimed = await this.claim(workerId.trim(), now);
    let delivered = 0;
    let deferred = 0;
    let deadLettered = 0;
    let expired = 0;

    for (const row of claimed) {
      if (now >= row.expiresAt) {
        await this.expire(row.id, workerId, now);
        expired += 1;
        continue;
      }

      try {
        await this.emitter.emit(toEvent(row));
        await this.markDelivered(row.id, workerId, now);
        delivered += 1;
      } catch {
        if (row.notificationAttempts >= this.maxAttempts) {
          await this.markDeadLetter(row.id, workerId, now, "DELIVERY_ATTEMPTS_EXHAUSTED");
          deadLettered += 1;
        } else {
          await this.defer(row, workerId, now);
          deferred += 1;
        }
      }
    }

    return {
      claimed: claimed.length,
      delivered,
      deferred,
      deadLettered,
      expired,
    };
  }

  private async claim(workerId: string, now: Date): Promise<ClaimedApprovalRow[]> {
    const leaseExpiresAt = new Date(now.getTime() + this.leaseMs);
    const result = await this.sql.query<ClaimedApprovalRow>(
      `with candidates as (
         select ar."id"
           from "ApprovalRequest" ar
          where ar."status" = 'PENDING'
            and (
              ar."approvalData"->'notification' is null
              or coalesce(ar."approvalData"->'notification'->>'status', 'PENDING') = 'PENDING'
              or (
                ar."approvalData"->'notification'->>'status' = 'LEASED'
                and nullif(ar."approvalData"->'notification'->>'leaseExpiresAt', '')::timestamptz <= $2
              )
            )
            and (
              ar."approvalData"->'notification'->>'nextAttemptAt' is null
              or nullif(ar."approvalData"->'notification'->>'nextAttemptAt', '')::timestamptz <= $2
            )
          order by ar."createdAt" asc
          for update skip locked
          limit $1
       ), claimed as (
         update "ApprovalRequest" ar
            set "approvalData" = coalesce(ar."approvalData", '{}'::jsonb) || jsonb_build_object(
              'notification',
              jsonb_build_object(
                'status', 'LEASED',
                'attempts', coalesce((ar."approvalData"->'notification'->>'attempts')::int, 0) + 1,
                'leaseOwner', $3::text,
                'leaseExpiresAt', $4::timestamptz,
                'lastAttemptAt', $2::timestamptz
              )
            )
           from candidates c
          where ar."id" = c."id"
        returning ar.*,
          (ar."approvalData"->'notification'->>'attempts')::int as "notificationAttempts"
       )
       select * from claimed order by "createdAt" asc`,
      [this.batchSize, now, workerId, leaseExpiresAt],
    );
    return result.rows;
  }

  private async markDelivered(approvalRequestId: string, workerId: string, now: Date): Promise<void> {
    const result = await this.sql.query(
      `update "ApprovalRequest"
          set "approvalData" = coalesce("approvalData", '{}'::jsonb) || jsonb_build_object(
            'notification',
            (coalesce("approvalData"->'notification', '{}'::jsonb) - 'leaseOwner' - 'leaseExpiresAt' - 'nextAttemptAt') ||
            jsonb_build_object('status', 'DELIVERED', 'deliveredAt', $3::timestamptz)
          )
        where "id" = $1::uuid
          and "approvalData"->'notification'->>'status' = 'LEASED'
          and "approvalData"->'notification'->>'leaseOwner' = $2::text`,
      [approvalRequestId, workerId, now],
    );
    if (result.rowCount !== 1) {
      throw new Error("Approval notification delivery lease was lost before completion");
    }
  }

  private async defer(row: ClaimedApprovalRow, workerId: string, now: Date): Promise<void> {
    const exponent = Math.max(0, row.notificationAttempts - 1);
    const delay = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** exponent);
    const nextAttemptAt = new Date(now.getTime() + delay);
    const result = await this.sql.query(
      `update "ApprovalRequest"
          set "approvalData" = coalesce("approvalData", '{}'::jsonb) || jsonb_build_object(
            'notification',
            (coalesce("approvalData"->'notification', '{}'::jsonb) - 'leaseOwner' - 'leaseExpiresAt') ||
            jsonb_build_object(
              'status', 'PENDING',
              'nextAttemptAt', $3::timestamptz,
              'lastErrorCode', 'DELIVERY_FAILED'
            )
          )
        where "id" = $1::uuid
          and "approvalData"->'notification'->>'status' = 'LEASED'
          and "approvalData"->'notification'->>'leaseOwner' = $2::text`,
      [row.id, workerId, nextAttemptAt],
    );
    if (result.rowCount !== 1) {
      throw new Error("Approval notification delivery lease was lost before deferral");
    }
  }

  private async markDeadLetter(
    approvalRequestId: string,
    workerId: string,
    now: Date,
    reason: string,
  ): Promise<void> {
    const result = await this.sql.query(
      `update "ApprovalRequest"
          set "approvalData" = coalesce("approvalData", '{}'::jsonb) || jsonb_build_object(
            'notification',
            (coalesce("approvalData"->'notification', '{}'::jsonb) - 'leaseOwner' - 'leaseExpiresAt' - 'nextAttemptAt') ||
            jsonb_build_object('status', 'DEAD_LETTER', 'deadLetteredAt', $3::timestamptz, 'lastErrorCode', $4::text)
          )
        where "id" = $1::uuid
          and "approvalData"->'notification'->>'status' = 'LEASED'
          and "approvalData"->'notification'->>'leaseOwner' = $2::text`,
      [approvalRequestId, workerId, now, reason],
    );
    if (result.rowCount !== 1) {
      throw new Error("Approval notification delivery lease was lost before dead-lettering");
    }
  }

  private async expire(approvalRequestId: string, workerId: string, now: Date): Promise<void> {
    const result = await this.sql.query(
      `update "ApprovalRequest"
          set "status" = 'EXPIRED',
              "resolvedAt" = coalesce("resolvedAt", $3::timestamptz),
              "approvalData" = coalesce("approvalData", '{}'::jsonb) || jsonb_build_object(
                'notification',
                (coalesce("approvalData"->'notification', '{}'::jsonb) - 'leaseOwner' - 'leaseExpiresAt' - 'nextAttemptAt') ||
                jsonb_build_object(
                  'status', 'DEAD_LETTER',
                  'deadLetteredAt', $3::timestamptz,
                  'lastErrorCode', 'APPROVAL_EXPIRED_BEFORE_DELIVERY'
                )
              )
        where "id" = $1::uuid
          and "approvalData"->'notification'->>'status' = 'LEASED'
          and "approvalData"->'notification'->>'leaseOwner' = $2::text`,
      [approvalRequestId, workerId, now],
    );
    if (result.rowCount !== 1) {
      throw new Error("Approval notification delivery lease was lost before expiry");
    }
  }
}

function toEvent(row: ClaimedApprovalRow): HumanApprovalEvent {
  return {
    eventId: row.id,
    approvalRequestId: row.id,
    type: "mino.approval.required",
    createdAt: row.createdAt.toISOString(),
    decisionId: row.decisionId,
    requestId: row.requestId,
    organizationId: row.organizationId,
    userId: row.userId,
    agentId: row.agentId,
    mandateId: row.mandateId,
    merchantDomain: row.merchantDomain,
    ...(row.checkoutSessionId ? { checkoutSessionId: row.checkoutSessionId } : {}),
    amountMinor: row.amountMinor,
    currency: row.currency,
    approvalMode: row.requiredSignatures >= 2 ? "DUAL_SIGNATURE_SLACK" : "HUMAN_APPROVAL",
    expiresAt: row.expiresAt.toISOString(),
  };
}

function assertPositive(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Approval notification ${label} must be a positive integer`);
  }
}
