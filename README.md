# Mino

Mino is a policy, authorization, and security control plane for agentic commerce. It sits between autonomous agents and external checkout/payment protocols, evaluates delegated spending mandates, enforces machine-actor safety controls, and emits an auditable decision before payment authorization can proceed.

## Implemented MVP security path

The current branch contains the policy kernel plus the ACP proxy/security and payment-reconciliation slices:

1. **Spend mandate** — Mino issues/verifies compact Ed25519-signed mandate tokens. The bearer token only carries identity/delegation references; the immutable server-side mandate snapshot remains authoritative and raw token values are never persisted.
2. **Agent identity proof** — payment-facing requests carry an Ed25519 request signature bound to method, path, timestamp, nonce, mandate-token JTI digest, ACP version, idempotency key, and canonical body digest. Nonces are claimed in Redis to reject replay.
3. **Merchant registry boundary** — agents select a server-registered merchant ID, never an arbitrary forwarding URL. Merchant targets must use HTTPS and the configured base URL hostname must match the registered domain.
4. **ACP adapter** — Mino is pinned to the current stable ACP checkout snapshot (`API-Version: 2026-04-17`). It normalizes merchant-authoritative `CheckoutSession` state into a protocol-independent `CheckoutIntent`.
5. **Policy evaluation** — identity, merchant, category, currency, per-transaction limits, rolling daily allowance, velocity, and cross-merchant burst policy are evaluated with fail-closed semantics.
6. **Atomic authorization reservation** — Redis Lua performs idempotency, machine-velocity, cross-merchant burst, rolling-spend, and allowance reservation checks atomically in a mandate-local Redis Cluster hash slot.
7. **Delegation assertion** — only a final `ALLOW` can mint a short-lived Ed25519 assertion bound to the agent, user, mandate, decision, merchant, amount, currency, request, checkout digest, and idempotency-key digest.
8. **Durable payment outcome** — before payment dispatch, Mino persists a PostgreSQL `PaymentOutcome` and extends the Redis reservation from its short authorization TTL into a reconciliation hold.
9. **Reconciliation-safe completion** — merchant 2xx commits spend; clearly definitive 4xx releases it. Transport loss, 409/422, and 5xx are treated as unknown outcomes and keep allowance reserved. Same-idempotency retries reconcile from the merchant-authoritative CheckoutSession and never blindly send a second payment.
10. **Human approval webhook** — `PENDING_HUMAN_APPROVAL` emits an HMAC-SHA256-signed webhook event suitable for a Slack/SMS approval bridge.
11. **Audit boundary** — proxy decisions are emitted to an `AuditSink`. Payment credentials and authorization material are recursively redacted before audit persistence.

## ACP trust boundary

Mino deliberately does **not** authorize against prices supplied by the agent. For checkout completion it first retrieves the merchant's current ACP `CheckoutSession` and evaluates the returned line items, product categories, and cart totals. The payment completion request is never forwarded unless that authoritative state receives `ALLOW` and Redis successfully reserves allowance.

Once payment dispatch begins, absence of a response is not interpreted as failure. Mino keeps the allowance held until success or failure is proven. A retry with the same idempotency key either replays a terminal durable result or uses the latest merchant CheckoutSession to reconcile the unresolved outcome without forwarding another payment. See `docs/payment-outcome-reconciliation.md`.

The MVP exposes:

```text
POST /v1/acp/:merchantId/checkout_sessions
POST /v1/acp/:merchantId/checkout_sessions/:checkoutSessionId/complete
```

The request body remains ACP-compatible. Mino-specific delegation and agent-proof material lives in headers. See `openapi/mino.openapi.yaml`.

## Policy evaluator invariants

- Money is represented in integer minor units; JavaScript floating-point values are not used for policy authorization arithmetic.
- Mandates are identity-bound to organization, user, and agent.
- Merchant domains use boundary-aware matching; `shop.example.com` may match `example.com`, while `example.com.evil.test` does not.
- Unknown cart categories fail closed.
- Restricted categories, identity failures, merchant failures, velocity violations, and invalid FX data are hard security blocks and cannot be overridden by human approval.
- Per-transaction and rolling-daily spending-limit breaches may escalate to `PENDING_HUMAN_APPROVAL` only when the mandate uses `DUAL_SIGNATURE_SLACK`.
- Rolling spend includes already-reserved spend to prevent concurrency oversubscription.
- Cross-currency checks require a valid point-in-time FX quote. Conversion uses integer arithmetic and ceiling rounding so FX rounding can never undercount authorization spend.
- Only an `ALLOW` decision is eligible for a downstream delegation assertion.

## Redis data model

Authorization keys use a Redis Cluster hash tag per mandate:

```text
mino:v1:auth:{mandateId}:committed
mino:v1:auth:{mandateId}:reservations
mino:v1:auth:{mandateId}:attempts
mino:v1:auth:{mandateId}:idem:<idempotencyKey>
mino:v1:auth:{mandateId}:reservation:<reservationId>
```

The Lua boundary currently restricts authorization amounts to JavaScript's exact safe-integer range before converting to Lua numbers. This is vastly above practical payment sizes while preserving exact comparison semantics. A payment that has crossed the merchant-dispatch boundary receives a longer reconciliation hold so the reservation cannot silently age out while its outcome is unknown.

## Development

```bash
npm install
npm run prisma:generate
npm run prisma:validate
npm test
npm run typecheck
```

With PostgreSQL and Redis available, the verification gate also runs the integration suite:

```bash
npm run test:integration
```

## Next implementation slice

- Add a background payment-outcome reconciliation worker with server-side merchant credential retrieval; request-driven reconciliation is implemented, but unresolved outcomes must not depend on an agent retry.
- Persist `ApprovalRequest` state before webhook delivery and add approval-resolution APIs.
- Implement the PostgreSQL `AuditSink` with event signing/tamper evidence.
- Add merchant/mandate/agent-key Prisma repositories and application wiring.
- Expand ACP proxy coverage to retrieve/update/cancel while keeping only payment-bearing operations behind spend reservation.
