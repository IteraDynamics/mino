# Production runtime composition

Mino has a concrete application composition root for running the implemented control-plane modules as one service.

## Startup

`src/server.ts` loads environment configuration, constructs the production dependency graph, and starts Fastify. Startup is fail-closed: PostgreSQL, Redis, and Prisma connectivity are checked before the application is returned, and malformed or missing security configuration causes startup to fail rather than substituting insecure defaults.

The compiled service starts with:

```bash
npm run build
npm start
```

## Required configuration

The production configuration loader reads:

- `DATABASE_URL` — PostgreSQL connection URL.
- `REDIS_URL` — Redis connection URL.
- `MINO_ISSUER` — HTTPS issuer identity used by Mino-signed artifacts.
- `MINO_MANDATE_PUBLIC_KEYS_B64_JSON` — JSON object mapping mandate signing key IDs to base64-encoded PEM public keys.
- `MINO_DELEGATION_SIGNING_KEY_ID` and `MINO_DELEGATION_PRIVATE_KEY_B64` — active delegation assertion signing key.
- `MINO_AUDIT_SIGNING_KEY_ID` and `MINO_AUDIT_PRIVATE_KEY_B64` — active audit signing key.
- `MINO_AUDIT_PUBLIC_KEYS_B64_JSON` — JSON object containing current and historical audit verification keys.
- `MINO_APPROVAL_RESOLUTION_SECRET` — HMAC secret for authenticated approval resolution callbacks.
- `MINO_APPROVAL_WEBHOOK_URL` — HTTPS destination for approval-required notifications.
- `MINO_APPROVAL_WEBHOOK_SECRET` — HMAC secret for approval notification delivery.
- `MINO_MERCHANT_CREDENTIALS_JSON` — optional JSON object mapping `organizationId:merchantId` to a server-side `Bearer ...` credential used by autonomous payment reconciliation.

Optional HTTP settings:

- `MINO_HOST` — defaults to `0.0.0.0`.
- `MINO_PORT` — defaults to `3000`.

The current configuration mechanism is intentionally a concrete application boundary, not a claim that environment variables are the final enterprise secret-management solution. Production deployment should supply these values through a secret manager/KMS/vault or equivalent deployment control rather than checking private keys or credentials into source control.

## Concrete dependency graph

`createProductionApplication()` constructs and connects:

- PostgreSQL and Prisma
- Redis
- Prisma-backed mandate, merchant, policy, and agent-key repositories
- mandate-token verification
- signed agent-request verification and Redis nonce replay protection
- the deterministic policy evaluator
- atomic Redis spend reservations
- durable human approvals and authenticated approval callbacks
- durable approval-notification outbox delivery
- durable payment outcomes
- autonomous payment reconciliation with server-side merchant credentials
- unresolved-payment operational monitoring
- the tamper-evident PostgreSQL audit ledger and verifier
- ACP merchant forwarding
- delegation assertions

Private signing keys are supplied by configuration providers and are not persisted into Mino's transactional tables.

## Background workers

The production server starts two independent non-overlapping worker loops after HTTP startup:

- approval notification delivery
- payment outcome reconciliation

Each loop schedules its next run only after the previous run settles. Slow work therefore cannot create overlapping runs inside one process. PostgreSQL leases remain the cross-process concurrency boundary, so multiple Mino instances can run the workers at the same time without intentionally claiming the same payment or approval work.

On `SIGTERM` or `SIGINT`, new loop iterations are stopped and any in-flight runs are allowed to settle before Redis, Prisma, and PostgreSQL resources are closed.

## Payment reconciliation operations

The payment reconciler continuously claims unresolved `UNKNOWN` outcomes and stale `FORWARDING` outcomes, refreshes the Redis reconciliation hold, obtains server-side merchant credentials, and queries merchant-authoritative checkout state. It does not blindly repeat payment submission.

A read-only `PaymentReconciliationMonitor` separately summarizes operational state. The default warning thresholds are:

- unresolved payment age of at least five minutes
- eight or more reconciliation attempts

The server emits structured logs containing unresolved count, stale count, high-attempt count, oldest unresolved age, and oldest outcome ID. Outcomes still inside the normal recovery window are informational; stale or high-attempt outcomes produce warnings. Worker failures produce error logs.

These logs are intended to be routed by deployment infrastructure into metrics, SIEM, paging, or alert systems. Mino does not claim a built-in PagerDuty, Slack, or vendor-specific operational-alert transport in this slice.

## Readiness and liveness

`GET /healthz` reports that the HTTP process is alive.

`GET /readyz` checks the dependencies required for transaction processing. It returns `200 {"status":"ready"}` only when PostgreSQL, Redis, and Prisma can all be reached; otherwise it returns HTTP 503.

An unresolved payment does not make the HTTP data plane unready. Payment uncertainty is instead held safely by reconciliation state and surfaced through the operational monitor.

## Shutdown

The server handles `SIGTERM` and `SIGINT`. Worker loops are stopped and drained before Fastify, Redis, Prisma, and the PostgreSQL pool are closed. The application close operation is idempotent so repeated shutdown signals do not attempt to tear the same resources down twice.

## Verification boundary

The production-composition integration test uses real PostgreSQL, Redis, Prisma repositories, mandate signatures, agent signatures, nonce replay protection, spend reservation state, payment outcome persistence, and audit-chain verification. It drives a payment through the actual Fastify route stack.

The payment reconciliation monitor is separately exercised against real PostgreSQL, including healthy empty state, stale/high-attempt unresolved outcomes, oldest-age calculation, and exclusion of terminal outcomes. The non-overlapping scheduler has unit coverage for overlap prevention, error containment, and shutdown draining.

The only intentionally replaced boundary in the production-composition test is the external merchant network call, which is supplied as a deterministic `ACPMerchantClient` test double. Merchant protocol behavior remains covered separately by the ACP adapter and proxy tests.

## Still intentionally outside this slice

Remaining productionization work includes:

- managed secret-vault/KMS integration and key-rotation operations
- external retention for signed audit checkpoints in a separate trust domain
- vendor-specific metrics/alert transports, tracing, and operational dashboards
- broader ACP endpoint coverage and customer-facing administrative surfaces
