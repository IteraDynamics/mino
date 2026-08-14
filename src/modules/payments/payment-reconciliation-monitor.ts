import type { QueryResultRow } from "pg";

const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;
const DEFAULT_HIGH_ATTEMPT_THRESHOLD = 8;

export interface PaymentReconciliationMonitorSqlClient {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ readonly rows: R[]; readonly rowCount: number | null }>;
}

export interface PaymentReconciliationMonitorOptions {
  readonly staleAfterMs?: number;
  readonly highAttemptThreshold?: number;
}

export interface PaymentReconciliationOperationalSnapshot {
  readonly observedAt: Date;
  readonly unresolved: number;
  readonly stale: number;
  readonly highAttempt: number;
  readonly oldestAgeMs: number;
  readonly oldestOutcomeId?: string;
}

interface OperationalSnapshotRow extends QueryResultRow {
  unresolved: string;
  stale: string;
  highAttempt: string;
  oldestCreatedAt: Date | null;
  oldestOutcomeId: string | null;
}

/**
 * Read-only operational view over unresolved payment outcomes.
 *
 * This deliberately does not mutate reconciliation state. Deployments can route the
 * structured snapshot emitted by the production server into their existing logging,
 * metrics, paging, or SIEM stack without coupling payment safety to any alert vendor.
 */
export class PaymentReconciliationMonitor {
  private readonly staleAfterMs: number;
  private readonly highAttemptThreshold: number;

  public constructor(
    private readonly sql: PaymentReconciliationMonitorSqlClient,
    options: PaymentReconciliationMonitorOptions = {},
  ) {
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.highAttemptThreshold = options.highAttemptThreshold ?? DEFAULT_HIGH_ATTEMPT_THRESHOLD;
    assertPositiveInteger(this.staleAfterMs, "stale threshold");
    assertPositiveInteger(this.highAttemptThreshold, "high-attempt threshold");
  }

  public async snapshot(now: Date): Promise<PaymentReconciliationOperationalSnapshot> {
    const staleBefore = new Date(now.getTime() - this.staleAfterMs);
    const result = await this.sql.query<OperationalSnapshotRow>(
      `with unresolved as (
         select "id", "createdAt", "reconcileAttempts"
           from "PaymentOutcome"
          where "status" in ('FORWARDING', 'UNKNOWN')
       ), oldest as (
         select "id", "createdAt"
           from unresolved
          order by "createdAt" asc, "id" asc
          limit 1
       )
       select
         count(*)::text as "unresolved",
         count(*) filter (where u."createdAt" <= $1::timestamptz)::text as "stale",
         count(*) filter (where u."reconcileAttempts" >= $2::int)::text as "highAttempt",
         (select o."createdAt" from oldest o) as "oldestCreatedAt",
         (select o."id" from oldest o) as "oldestOutcomeId"
       from unresolved u`,
      [staleBefore, this.highAttemptThreshold],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("Payment reconciliation operational snapshot query returned no row");
    }

    const oldestAgeMs = row.oldestCreatedAt
      ? Math.max(0, now.getTime() - row.oldestCreatedAt.getTime())
      : 0;

    return {
      observedAt: now,
      unresolved: parseCount(row.unresolved, "unresolved"),
      stale: parseCount(row.stale, "stale"),
      highAttempt: parseCount(row.highAttempt, "high-attempt"),
      oldestAgeMs,
      ...(row.oldestOutcomeId ? { oldestOutcomeId: row.oldestOutcomeId } : {}),
    };
  }
}

export function paymentReconciliationNeedsAttention(
  snapshot: PaymentReconciliationOperationalSnapshot,
): boolean {
  return snapshot.stale > 0 || snapshot.highAttempt > 0;
}

function parseCount(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${label} payment reconciliation count`);
  }
  return parsed;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Payment reconciliation ${label} must be a positive integer`);
  }
}
