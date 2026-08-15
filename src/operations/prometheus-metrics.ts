import type { OperationalMetricsSnapshot } from "./postgres-operational-metrics.js";

export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/**
 * Deterministic, low-cardinality Prometheus exposition.
 *
 * Labels are fixed enums only. Organization, user, agent, merchant, request,
 * payment, reservation, and idempotency identifiers are intentionally absent.
 */
export function renderPrometheusMetrics(snapshot: OperationalMetricsSnapshot): string {
  const lines: string[] = [
    "# HELP mino_audit_decisions Retained durable Mino audit decisions by verdict.",
    "# TYPE mino_audit_decisions gauge",
  ];

  for (const [verdict, count] of Object.entries(snapshot.auditDecisions)) {
    lines.push(`mino_audit_decisions{verdict="${verdict}"} ${count.toString(10)}`);
  }

  lines.push(
    "# HELP mino_approval_requests Current durable approval requests by status.",
    "# TYPE mino_approval_requests gauge",
  );
  for (const [status, count] of Object.entries(snapshot.approvals)) {
    lines.push(`mino_approval_requests{status="${status}"} ${count.toString(10)}`);
  }

  lines.push(
    "# HELP mino_payment_outcomes Current durable payment outcomes by status.",
    "# TYPE mino_payment_outcomes gauge",
  );
  for (const [status, count] of Object.entries(snapshot.payments)) {
    lines.push(`mino_payment_outcomes{status="${status}"} ${count.toString(10)}`);
  }

  lines.push(
    "# HELP mino_spend_reservations Current durable spend reservations by status.",
    "# TYPE mino_spend_reservations gauge",
  );
  for (const [status, count] of Object.entries(snapshot.spendReservations)) {
    lines.push(`mino_spend_reservations{status="${status}"} ${count.toString(10)}`);
  }

  lines.push(
    "# HELP mino_unresolved_payments Durable payments whose merchant outcome is still unresolved.",
    "# TYPE mino_unresolved_payments gauge",
    `mino_unresolved_payments ${snapshot.unresolvedPayments.toString(10)}`,
    "# HELP mino_oldest_unresolved_payment_age_seconds Age of the oldest unresolved payment outcome.",
    "# TYPE mino_oldest_unresolved_payment_age_seconds gauge",
    `mino_oldest_unresolved_payment_age_seconds ${snapshot.oldestUnresolvedPaymentAgeSeconds}`,
    "# HELP mino_audit_organizations Organizations with an audit-chain head.",
    "# TYPE mino_audit_organizations gauge",
    `mino_audit_organizations ${snapshot.auditOrganizations.toString(10)}`,
    "# HELP mino_metrics_snapshot_timestamp_seconds Unix timestamp represented by this database snapshot.",
    "# TYPE mino_metrics_snapshot_timestamp_seconds gauge",
    `mino_metrics_snapshot_timestamp_seconds ${Math.floor(snapshot.capturedAt.getTime() / 1000)}`,
  );

  return `${lines.join("\n")}\n`;
}
