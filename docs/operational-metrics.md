# Operational metrics

Mino exposes an optional Prometheus-compatible operational endpoint derived from durable PostgreSQL state.

## Enabling the endpoint

`GET /metrics` is registered only when exactly one dedicated metrics credential is configured:

- `MINO_METRICS_BEARER_TOKEN`
- `MINO_METRICS_BEARER_TOKEN_FILE`

The token must contain at least 32 non-whitespace characters. The mounted-file form is intended for the same external secret-manager/CSI/sidecar deployment pattern used by Mino's other sensitive runtime inputs.

If neither setting is present, the route is not registered. If both are present, or the configured secret is weak/unreadable, production startup fails rather than guessing which credential is authoritative.

A scrape uses:

```text
Authorization: Bearer <dedicated metrics token>
```

The metrics credential is deliberately separate from agent, merchant, approval, and checkpoint-retention credentials.

## Exported metrics

The initial durable-state surface is intentionally low-cardinality:

- `mino_audit_decisions{verdict=...}` — retained audited decisions by fixed verdict.
- `mino_approval_requests{status=...}` — current durable approvals by fixed status.
- `mino_payment_outcomes{status=...}` — current durable payment outcomes by fixed status.
- `mino_spend_reservations{status=...}` — current durable spend-reservation mirrors by fixed status.
- `mino_unresolved_payments` — current `FORWARDING` + `UNKNOWN` payment outcomes.
- `mino_oldest_unresolved_payment_age_seconds` — age of the oldest unresolved durable payment.
- `mino_audit_organizations` — organizations with a current audit-chain head.
- `mino_metrics_snapshot_timestamp_seconds` — timestamp used for the scrape snapshot.

These are database-derived **gauges**. Even the audited-decision metric is a gauge rather than a Prometheus counter because it represents retained durable rows; a future retention policy could legitimately reduce that row count.

## Cardinality and privacy boundary

Metric labels are fixed Mino enums only. The initial endpoint intentionally does **not** label metrics by:

- organization, user, or agent ID
- merchant or vendor ID
- request or decision ID
- payment-outcome or reservation ID
- idempotency key
- checkout-session ID
- monetary amount
- credentials or tokens

This prevents customer/transaction identifiers from becoming monitoring dimensions and avoids unbounded time-series cardinality.

## Failure isolation

A metrics scrape performs read-only PostgreSQL aggregation. It does not participate in policy evaluation, Redis reservation, approval resolution, payment dispatch, reconciliation, or audit mutation.

If the metrics query fails, that scrape receives HTTP 503 `METRICS_UNAVAILABLE`. The failure does not change transaction readiness and cannot convert an ALLOW to a BLOCK or vice versa.

Authentication failure is rejected before any database metrics query is executed.

## Production composition

The production server loads the optional metrics credential at startup. When configured, the production application creates the read-only PostgreSQL metrics reader and registers the authenticated route. When no credential is configured, `/metrics` is absent rather than anonymously exposed.

The production integration suite starts the real application composition in both modes and verifies that disabled metrics return 404, unauthenticated enabled metrics return 401, and an authenticated scrape returns Prometheus text.

## Scope

This is the provider-neutral baseline for production observability. Prometheus can scrape it directly, and OpenTelemetry/Datadog/CloudWatch or other deployment-specific collectors can consume or bridge it externally.

This slice does not claim distributed tracing, request-latency histograms, alert routing, or a built-in monitoring dashboard. Those are separate operational layers that can be added without coupling monitoring logic to Mino's authorization path.
