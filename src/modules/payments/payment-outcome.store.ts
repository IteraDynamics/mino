import type { QueryResultRow } from "pg";

export enum PaymentOutcomeStatus {
  FORWARDING = "FORWARDING",
  UNKNOWN = "UNKNOWN",
  SUCCEEDED = "SUCCEEDED",
  FAILED_DEFINITIVE = "FAILED_DEFINITIVE",
}

export interface StoredMerchantResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface PaymentOutcomeRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly mandateId: string;
  readonly reservationId: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly merchantId: string;
  readonly merchantDomain: string;
  readonly checkoutSessionId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly status: PaymentOutcomeStatus;
  readonly upstreamStatus?: number;
  readonly response?: StoredMerchantResponse;
  readonly lastErrorCode?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly forwardedAt?: Date;
  readonly resolvedAt?: Date;
  readonly lastReconciledAt?: Date;
  readonly reconcileAttempts?: number;
  readonly nextReconcileAt?: Date;
  readonly reconciliationLeaseOwner?: string;
  readonly reconciliationLeaseExpiresAt?: Date;
}

export interface BeginPaymentOutcomeInput {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly mandateId: string;
  readonly reservationId: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly merchantId: string;
  readonly merchantDomain: string;
  readonly checkoutSessionId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly now: Date;
}

export enum BeginPaymentOutcomeKind {
  CREATED = "CREATED",
  EXISTING = "EXISTING",
  CONFLICT = "CONFLICT",
}

export interface BeginPaymentOutcomeResult {
  readonly kind: BeginPaymentOutcomeKind;
  readonly outcome: PaymentOutcomeRecord;
}

export interface ClaimPaymentOutcomesInput {
  readonly workerId: string;
  readonly now: Date;
  readonly limit: number;
  readonly leaseMs: number;
  readonly forwardingGraceMs: number;
}

export interface DeferPaymentOutcomeInput {
  readonly workerId: string;
  readonly now: Date;
  readonly nextAttemptAt: Date;
  readonly errorCode: string;
  readonly upstreamStatus?: number;
}

export interface PaymentOutcomeStore {
  getByIdempotency(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<PaymentOutcomeRecord | undefined>;
  begin(input: BeginPaymentOutcomeInput): Promise<BeginPaymentOutcomeResult>;
  markUnknown(
    outcomeId: string,
    args: { readonly upstreamStatus?: number; readonly errorCode?: string; readonly now: Date },
  ): Promise<PaymentOutcomeRecord>;
  markSucceeded(
    outcomeId: string,
    response: StoredMerchantResponse,
    now: Date,
  ): Promise<PaymentOutcomeRecord>;
  markDefinitiveFailure(
    outcomeId: string,
    response: StoredMerchantResponse,
    now: Date,
  ): Promise<PaymentOutcomeRecord>;
  markReconciled(outcomeId: string, now: Date): Promise<PaymentOutcomeRecord>;
}

export interface ReconciliationPaymentOutcomeStore extends PaymentOutcomeStore {
  claimForReconciliation(input: ClaimPaymentOutcomesInput): Promise<PaymentOutcomeRecord[]>;
  deferReconciliation(
    outcomeId: string,
    input: DeferPaymentOutcomeInput,
  ): Promise<PaymentOutcomeRecord>;
}

export interface SqlClient {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ readonly rows: R[]; readonly rowCount: number | null }>;
}

interface PaymentOutcomeRow extends QueryResultRow {
  id: string;
  organizationId: string;
  userId: string;
  agentId: string;
  mandateId: string;
  reservationId: string;
  idempotencyKey: string;
  requestDigest: string;
  merchantId: string;
  merchantDomain: string;
  checkoutSessionId: string;
  amountMinor: string;
  currency: string;
  status: PaymentOutcomeStatus;
  upstreamStatus: number | null;
  responseBody: unknown | null;
  responseHeaders: unknown | null;
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
  forwardedAt: Date | null;
  resolvedAt: Date | null;
  lastReconciledAt: Date | null;
  reconcileAttempts: number;
  nextReconcileAt: Date | null;
  reconciliationLeaseOwner: string | null;
  reconciliationLeaseExpiresAt: Date | null;
}

export class PostgresPaymentOutcomeStore implements ReconciliationPaymentOutcomeStore {
  public constructor(private readonly sql: SqlClient) {}

  public async getByIdempotency(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<PaymentOutcomeRecord | undefined> {
    const result = await this.sql.query<PaymentOutcomeRow>(
      `select *
         from "PaymentOutcome"
        where "organizationId" = $1::uuid
          and "idempotencyKey" = $2`,
      [organizationId, idempotencyKey],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  public async begin(input: BeginPaymentOutcomeInput): Promise<BeginPaymentOutcomeResult> {
    const inserted = await this.sql.query<PaymentOutcomeRow>(
      `insert into "PaymentOutcome" (
         "id", "organizationId", "userId", "agentId", "mandateId",
         "reservationId", "idempotencyKey", "requestDigest", "merchantId",
         "merchantDomain", "checkoutSessionId", "amountMinor", "currency",
         "status", "forwardedAt", "createdAt", "updatedAt"
       ) values (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         $6, $7, $8, $9, $10, $11, $12::bigint, $13,
         'FORWARDING', $14, $14, $14
       )
       on conflict ("organizationId", "idempotencyKey") do nothing
       returning *`,
      [
        input.id,
        input.organizationId,
        input.userId,
        input.agentId,
        input.mandateId,
        input.reservationId,
        input.idempotencyKey,
        input.requestDigest,
        input.merchantId,
        input.merchantDomain,
        input.checkoutSessionId,
        input.amountMinor.toString(10),
        input.currency.toUpperCase(),
        input.now,
      ],
    );

    const created = inserted.rows[0];
    if (created) {
      return { kind: BeginPaymentOutcomeKind.CREATED, outcome: mapRow(created) };
    }

    const existing = await this.getByIdempotency(input.organizationId, input.idempotencyKey);
    if (!existing) {
      throw new Error("Payment outcome uniqueness conflict could not be reloaded");
    }

    return {
      kind:
        existing.requestDigest === input.requestDigest
          ? BeginPaymentOutcomeKind.EXISTING
          : BeginPaymentOutcomeKind.CONFLICT,
      outcome: existing,
    };
  }

  public async markUnknown(
    outcomeId: string,
    args: { readonly upstreamStatus?: number; readonly errorCode?: string; readonly now: Date },
  ): Promise<PaymentOutcomeRecord> {
    return this.updateOne(
      `update "PaymentOutcome"
          set "status" = 'UNKNOWN',
              "upstreamStatus" = coalesce($2, "upstreamStatus"),
              "lastErrorCode" = $3,
              "nextReconcileAt" = $4,
              "reconciliationLeaseOwner" = null,
              "reconciliationLeaseExpiresAt" = null,
              "updatedAt" = $4
        where "id" = $1::uuid
          and "status" in ('FORWARDING', 'UNKNOWN')
      returning *`,
      [outcomeId, args.upstreamStatus ?? null, args.errorCode ?? null, args.now],
      outcomeId,
    );
  }

  public async markSucceeded(
    outcomeId: string,
    response: StoredMerchantResponse,
    now: Date,
  ): Promise<PaymentOutcomeRecord> {
    return this.updateOne(
      `update "PaymentOutcome"
          set "status" = 'SUCCEEDED',
              "upstreamStatus" = $2,
              "responseBody" = $3::jsonb,
              "responseHeaders" = $4::jsonb,
              "lastErrorCode" = null,
              "resolvedAt" = coalesce("resolvedAt", $5),
              "lastReconciledAt" = $5,
              "nextReconcileAt" = null,
              "reconciliationLeaseOwner" = null,
              "reconciliationLeaseExpiresAt" = null,
              "updatedAt" = $5
        where "id" = $1::uuid
          and "status" in ('FORWARDING', 'UNKNOWN', 'SUCCEEDED')
      returning *`,
      [
        outcomeId,
        response.status,
        JSON.stringify(response.body ?? null),
        JSON.stringify(response.headers ?? {}),
        now,
      ],
      outcomeId,
    );
  }

  public async markDefinitiveFailure(
    outcomeId: string,
    response: StoredMerchantResponse,
    now: Date,
  ): Promise<PaymentOutcomeRecord> {
    return this.updateOne(
      `update "PaymentOutcome"
          set "status" = 'FAILED_DEFINITIVE',
              "upstreamStatus" = $2,
              "responseBody" = $3::jsonb,
              "responseHeaders" = $4::jsonb,
              "lastErrorCode" = null,
              "resolvedAt" = coalesce("resolvedAt", $5),
              "lastReconciledAt" = $5,
              "nextReconcileAt" = null,
              "reconciliationLeaseOwner" = null,
              "reconciliationLeaseExpiresAt" = null,
              "updatedAt" = $5
        where "id" = $1::uuid
          and "status" in ('FORWARDING', 'UNKNOWN', 'FAILED_DEFINITIVE')
      returning *`,
      [
        outcomeId,
        response.status,
        JSON.stringify(response.body ?? null),
        JSON.stringify(response.headers ?? {}),
        now,
      ],
      outcomeId,
    );
  }

  public async markReconciled(outcomeId: string, now: Date): Promise<PaymentOutcomeRecord> {
    return this.updateOne(
      `update "PaymentOutcome"
          set "lastReconciledAt" = $2,
              "updatedAt" = $2
        where "id" = $1::uuid
      returning *`,
      [outcomeId, now],
      outcomeId,
    );
  }

  public async claimForReconciliation(
    input: ClaimPaymentOutcomesInput,
  ): Promise<PaymentOutcomeRecord[]> {
    if (!input.workerId.trim()) {
      throw new Error("Reconciliation worker ID is required");
    }
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0 || input.limit > 1000) {
      throw new Error("Reconciliation claim limit must be between 1 and 1000");
    }
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) {
      throw new Error("Reconciliation lease must be a positive integer number of milliseconds");
    }
    if (!Number.isSafeInteger(input.forwardingGraceMs) || input.forwardingGraceMs < 0) {
      throw new Error("Forwarding grace must be a non-negative integer number of milliseconds");
    }

    const staleForwardingBefore = new Date(input.now.getTime() - input.forwardingGraceMs);
    const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
    const result = await this.sql.query<PaymentOutcomeRow>(
      `with candidates as (
         select "id"
           from "PaymentOutcome"
          where "status" in ('UNKNOWN', 'FORWARDING')
            and (
              ("status" = 'UNKNOWN' and ("nextReconcileAt" is null or "nextReconcileAt" <= $1))
              or ("status" = 'FORWARDING' and "updatedAt" <= $2)
            )
            and (
              "reconciliationLeaseExpiresAt" is null
              or "reconciliationLeaseExpiresAt" <= $1
            )
          order by coalesce("nextReconcileAt", "updatedAt"), "createdAt", "id"
          for update skip locked
          limit $3::int
       )
       update "PaymentOutcome" as outcome
          set "reconciliationLeaseOwner" = $4,
              "reconciliationLeaseExpiresAt" = $5,
              "reconcileAttempts" = "reconcileAttempts" + 1,
              "lastReconciledAt" = $1,
              "updatedAt" = $1
         from candidates
        where outcome."id" = candidates."id"
      returning outcome.*`,
      [input.now, staleForwardingBefore, input.limit, input.workerId, leaseExpiresAt],
    );

    return result.rows.map(mapRow);
  }

  public async deferReconciliation(
    outcomeId: string,
    input: DeferPaymentOutcomeInput,
  ): Promise<PaymentOutcomeRecord> {
    if (input.nextAttemptAt.getTime() <= input.now.getTime()) {
      throw new Error("Deferred reconciliation must be scheduled in the future");
    }
    return this.updateOne(
      `update "PaymentOutcome"
          set "status" = 'UNKNOWN',
              "upstreamStatus" = coalesce($3, "upstreamStatus"),
              "lastErrorCode" = $4,
              "nextReconcileAt" = $5,
              "lastReconciledAt" = $2,
              "reconciliationLeaseOwner" = null,
              "reconciliationLeaseExpiresAt" = null,
              "updatedAt" = $2
        where "id" = $1::uuid
          and "status" in ('FORWARDING', 'UNKNOWN')
          and "reconciliationLeaseOwner" = $6
      returning *`,
      [
        outcomeId,
        input.now,
        input.upstreamStatus ?? null,
        input.errorCode,
        input.nextAttemptAt,
        input.workerId,
      ],
      outcomeId,
    );
  }

  private async updateOne(
    statement: string,
    values: unknown[],
    outcomeId: string,
  ): Promise<PaymentOutcomeRecord> {
    const result = await this.sql.query<PaymentOutcomeRow>(statement, values);
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Payment outcome ${outcomeId} cannot make the requested state transition`);
    }
    return mapRow(row);
  }
}

function mapRow(row: PaymentOutcomeRow): PaymentOutcomeRecord {
  const response =
    row.upstreamStatus !== null && row.responseBody !== null
      ? {
          status: row.upstreamStatus,
          body: row.responseBody,
          ...(isStringRecord(row.responseHeaders) ? { headers: row.responseHeaders } : {}),
        }
      : undefined;

  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    agentId: row.agentId,
    mandateId: row.mandateId,
    reservationId: row.reservationId,
    idempotencyKey: row.idempotencyKey,
    requestDigest: row.requestDigest,
    merchantId: row.merchantId,
    merchantDomain: row.merchantDomain,
    checkoutSessionId: row.checkoutSessionId,
    amountMinor: BigInt(row.amountMinor),
    currency: row.currency,
    status: row.status,
    ...(row.upstreamStatus !== null ? { upstreamStatus: row.upstreamStatus } : {}),
    ...(response ? { response } : {}),
    ...(row.lastErrorCode ? { lastErrorCode: row.lastErrorCode } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.forwardedAt ? { forwardedAt: row.forwardedAt } : {}),
    ...(row.resolvedAt ? { resolvedAt: row.resolvedAt } : {}),
    ...(row.lastReconciledAt ? { lastReconciledAt: row.lastReconciledAt } : {}),
    reconcileAttempts: row.reconcileAttempts,
    ...(row.nextReconcileAt ? { nextReconcileAt: row.nextReconcileAt } : {}),
    ...(row.reconciliationLeaseOwner
      ? { reconciliationLeaseOwner: row.reconciliationLeaseOwner }
      : {}),
    ...(row.reconciliationLeaseExpiresAt
      ? { reconciliationLeaseExpiresAt: row.reconciliationLeaseExpiresAt }
      : {}),
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === "string");
}
