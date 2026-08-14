# Mino MVP Verification Gate

This gate must stay green before the authorization core is treated as stable enough for additional payment-bearing features.

## Required commands

```bash
npm install
npm run prisma:validate
npm run prisma:generate
npm run typecheck
npm run test:unit
npm run test:integration
```

`test:integration` expects PostgreSQL and Redis. The repository CI workflow supplies both services and runs `prisma db push` before the integration suite. Integration files run sequentially because the Redis suites intentionally share and reset one test database.

## Invariants under test

### Atomic allowance

Fifty concurrent $5 reservation attempts against a $100 rolling allowance must yield exactly twenty reservations and never more than $100 of active reserved spend.

### Idempotency

Concurrent retries carrying the same idempotency key and the same request digest must collapse to one reservation. Reusing the key with a different digest must fail with `IDEMPOTENCY_CONFLICT`.

### Reservation lifecycle

Commit and release are idempotent. A reservation whose authorization TTL has expired can never be committed later, even if its detail record still exists for reconciliation.

### Machine velocity

Per-minute transaction limits and cross-merchant burst limits are enforced inside the same Redis atomic boundary used for spend reservation.

### Signed delegation boundary

Real Ed25519 keys are generated in the integration suite. Tests cover mandate signature verification, server-side token-JTI binding, expiry, request-body/path/idempotency binding, and Redis-backed nonce replay rejection.

### Merchant-authoritative checkout state

The proxy integration suite verifies that stale agent cart expectations cannot override the merchant's current ACP checkout session. Restricted merchant state blocks before reservation or payment forwarding.

### Merchant result lifecycle

A successful merchant completion commits the reservation. A definite non-2xx response releases it. Human-approval decisions do not reserve allowance or forward payment.

### PostgreSQL control-plane schema

The integration suite verifies that Prisma can materialize the control-plane tables and that critical uniqueness constraints exist for mandate-token JTI digests and organization-scoped spend idempotency.

### Policy latency

After warm-up, 5,000 pure policy evaluations are sampled and p99 must remain below the MVP 50 ms evaluation budget.

## Unresolved production gates

The suite intentionally leaves the ambiguous merchant outcome as a visible `todo`: the merchant may process payment while the response is lost. Before production use Mino needs durable reconciliation/final-response idempotency for that case. Additional production gates are durable human-approval revalidation, cryptographically tamper-evident audit persistence, and full hot-path latency measurements including Redis and signature verification.
