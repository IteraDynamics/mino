# Production runtime composition

Mino now has a concrete application composition root for running the implemented control-plane modules as one service.

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
- durable payment outcomes
- the tamper-evident PostgreSQL audit ledger and verifier
- ACP merchant forwarding
- delegation assertions
- the autonomous payment reconciler with server-side merchant credentials

Private signing keys are supplied by configuration providers and are not persisted into Mino's transactional tables.

## Readiness and liveness

`GET /healthz` reports that the HTTP process is alive.

`GET /readyz` checks the dependencies required for transaction processing. It returns `200 {"status":"ready"}` only when PostgreSQL, Redis, and Prisma can all be reached; otherwise it returns HTTP 503.

This distinguishes a running process from a service that is actually able to handle controlled commerce traffic.

## Shutdown

The server handles `SIGTERM` and `SIGINT` and closes Fastify, Redis, Prisma, and the PostgreSQL pool. The application close operation is idempotent so repeated shutdown signals do not attempt to tear the same resources down twice.

## Verification boundary

The production-composition integration test uses real PostgreSQL, Redis, Prisma repositories, mandate signatures, agent signatures, nonce replay protection, spend reservation state, payment outcome persistence, and audit-chain verification. It drives a payment through the actual Fastify route stack.

The only intentionally replaced boundary in that test is the external merchant network call, which is supplied as a deterministic `ACPMerchantClient` test double. Merchant protocol behavior remains covered separately by the ACP adapter and proxy tests.

## Still intentionally outside this slice

This milestone makes Mino a coherently assembled runnable service, but it is not the end of productionization. Remaining operational work includes:

- a managed secret-vault/KMS integration and key-rotation operations
- an outbox/retry worker for approval notification delivery
- a continuously scheduled process/loop around the already-constructed background payment reconciler
- external retention for signed audit checkpoints in a separate trust domain
- metrics, alerts, tracing, and operational dashboards
- broader ACP endpoint coverage and customer-facing administrative surfaces
