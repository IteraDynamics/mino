import type { QueryResultRow } from "pg";

export const APPROVAL_STATUSES = ["PENDING", "APPROVED", "REJECTED", "EXPIRED"] as const;
export const PAYMENT_STATUSES = ["FORWARDING", "UNKNOWN", "SUCCEEDED", "FAILED_DEFINITIVE"] as const;
export const RESERVATION_STATUSES = ["RESERVED", "COMMITTED", "RELEASED", "EXPIRED"] as const;
export const DECISION_VERDICTS = ["ALLOW", "BLOCK", "PENDING_HUMAN_APPROVAL"] as const;

export type ApprovalMetricStatus = (typeof APPROVAL_STATUSES)[number];
export type PaymentMetricStatus = (typeof PAYMENT_STATUSES)[number];
export type ReservationMetricStatus = (typeof RESERVATION_STATUSES)[number];
export type DecisionMetricVerdict = (typeof DECISION_VERDICTS)[number];

export interface OperationalMetricsSqlClient {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ readonly rows: R[]; readonly rowCount: number | null }>;
}

export interface OperationalMetricsSnapshot {
  readonly capturedAt: Date;
  readonly auditDecisions: Readonly<Record<DecisionMetricVerdict, bigint>>;
  readonly approvals: Readonly<Record<ApprovalMetricStatus, bigint>>;
  readonly payments: Readonly<Record<PaymentMetricStatus, bigint>>;
  readonly spendReservations: Readonly<Record<ReservationMetricStatus, bigint>>;
  readonly auditOrganizations: bigint;
  readonly unresolvedPayments: bigint;
  readonly oldestUnresolvedPaymentAgeSeconds: number;
}

interface GroupedCountRow extends QueryResultRow {
  key: string;
  count: string;
}

interface ScalarRow extends QueryResultRow {
  value: string;
}

interface UnresolvedRow extends QueryResultRow {
  count: string;
  oldestAt: Date | null;
}

/**
 * Read-only operational view derived from durable PostgreSQL state.
 *
 * This deliberately does not participate in transaction authorization. A scrape
 * failure can make /metrics unavailable, but it cannot ALLOW/BLOCK a request or
 * mutate payment, approval, reservation, or audit state.
 */
export class PostgresOperationalMetrics {
  public constructor(private readonly sql: OperationalMetricsSqlClient) {}

  public async snapshot(now: Date): Promise<OperationalMetricsSnapshot> {
    const [decisions, approvals, payments, reservations, auditOrganizations, unresolved] =
      await Promise.all([
        this.groupedCounts('select "verdict" as key, count(*)::text as count from "AuditLog" group by "verdict"'),
        this.groupedCounts('select "status" as key, count(*)::text as count from "ApprovalRequest" group by "status"'),
        this.groupedCounts('select "status" as key, count(*)::text as count from "PaymentOutcome" group by "status"'),
        this.groupedCounts('select "status" as key, count(*)::text as count from "SpendReservation" group by "status"'),
        this.sql.query<ScalarRow>('select count(*)::text as value from "AuditChainHead"'),
        this.sql.query<UnresolvedRow>(
          `select count(*)::text as count, min("createdAt") as "oldestAt"
             from "PaymentOutcome"
            where "status" in ('FORWARDING', 'UNKNOWN')`,
        ),
      ]);

    const unresolvedRow = unresolved.rows[0];
    return {
      capturedAt: now,
      auditDecisions: exactCounts(DECISION_VERDICTS, decisions),
      approvals: exactCounts(APPROVAL_STATUSES, approvals),
      payments: exactCounts(PAYMENT_STATUSES, payments),
      spendReservations: exactCounts(RESERVATION_STATUSES, reservations),
      auditOrganizations: parseCount(auditOrganizations.rows[0]?.value ?? "0"),
      unresolvedPayments: parseCount(unresolvedRow?.count ?? "0"),
      oldestUnresolvedPaymentAgeSeconds: unresolvedRow?.oldestAt
        ? Math.max(0, Math.floor((now.getTime() - unresolvedRow.oldestAt.getTime()) / 1000))
        : 0,
    };
  }

  private async groupedCounts(query: string): Promise<ReadonlyMap<string, bigint>> {
    const result = await this.sql.query<GroupedCountRow>(query);
    const counts = new Map<string, bigint>();
    for (const row of result.rows) {
      counts.set(row.key, parseCount(row.count));
    }
    return counts;
  }
}

function exactCounts<const T extends readonly string[]>(
  allowed: T,
  source: ReadonlyMap<string, bigint>,
): Readonly<Record<T[number], bigint>> {
  return Object.fromEntries(allowed.map((key) => [key, source.get(key) ?? 0n])) as Record<
    T[number],
    bigint
  >;
}

function parseCount(value: string): bigint {
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error("Operational metrics query returned an invalid count");
  }
  if (parsed < 0n) {
    throw new Error("Operational metrics query returned a negative count");
  }
  return parsed;
}
