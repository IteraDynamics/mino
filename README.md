# Mino

Mino is a policy, authorization, approval, and security control plane for agentic commerce. It sits between autonomous agents and external checkout/payment protocols, evaluates delegated spending mandates, enforces machine-actor safety controls, and emits an auditable decision before payment authorization can proceed.

## Implemented MVP security path

The current branch contains the policy kernel plus the ACP proxy, payment-reconciliation, autonomous reconciliation, and durable human-approval slices:

1. **Spend mandate** — Mino issues/verifies compact Ed25519-signed mandate tokens. The bearer token only carries identity/delegation references; the immutable server-side mandate snapshot remains authoritative and raw token values are never persisted.
2. **Agent identity proof** — payment-facing requests carry an Ed25519 request signature bound to method, path, timestamp, nonce, mandate-token JTI digest, ACP version, idempotency key, and canonical body digest. Nonces are claimed in Redis to reject replay.
3. **Merchant registry boundary** — agents select a server-registered merchant ID, never an arbitrary forwarding URL. Merchant targets must use HTTPS and the configured base URL hostname must match the registered domain.
4. **ACP adapter** — Mino is pinned to the current stable ACP checkout snapshot (`API-Version: 2026-04-17`). It normalizes merchant-authoritative `CheckoutSession` state into a protocol-independent `CheckoutIntent`.
5. **Policy evaluation** — identity, merchant, category, currency, per-transaction limits, rolling daily allowance, velocity, and cross-merchant burst policy are evaluated with fail-closed semantics.
6. **Atomic authorization reservation** — Redis Lua performs idempotency, machine-velocity, cross-merchant burst, rolling-spend, and allowance reservation checks atomically in a mandate-local Redis Cluster hash slot.
7. **Durable human approval** — an approvable soft spend-limit decision is persisted as a PostgreSQL `ApprovalRequest` before notification. The request is bound to organization, user, agent, mandate, policy version, idempotency key, raw payment-request digest, merchant, amount, reviewed reasons, merchant-authoritative checkout snapshot, and relevant spend snapshot.
8. **Concurrency-safe approval votes** — votes are normalized in PostgreSQL with one vote per approver. Resolution holds an `ApprovalRequest` row lock, making dual approval, rejection, duplicate votes, and expiration deterministic under concurrency.
9. **Authenticated approval bridge** — approval read/vote callbacks require a timestamped HMAC-SHA256 signature bound to method, exact path, approver identity, and canonical request-body digest. A caller cannot become an approver merely by supplying a header.
10. **Approval revalidation** — an approved retry refetches merchant-authoritative checkout state and re-runs policy plus Redis machine controls. The grant can cover only the same reviewed transaction/daily spend-limit breach; changed payload/cart/amount/policy, new escalation reasons, increased daily exposure, rejection, or expiry fails closed. Hard blocks are never human-overridable.
11. **Delegation assertion** — only a final `ALLOW` can mint a short-lived Ed25519 assertion bound to the agent, user, mandate, decision, merchant, amount, currency, request, checkout digest, and idempotency-key digest.
12. **Durable payment outcome** — before payment dispatch, Mino persists a PostgreSQL `PaymentOutcome` and extends the Redis reservation from its short authorization TTL into a reconciliation hold.
13. **Reconciliation-safe completion** — merchant 2xx commits spend; clearly definitive 4xx releases it. Transport loss, 409/422, and 5xx are treated as unknown outcomes and keep allowance reserved. Same-idempotency retries reconcile from the merchant-authoritative CheckoutSession and never blindly send a second payment.
14. **Autonomous reconciliation** — unresolved `UNKNOWN` outcomes and stale `FORWARDING` rows are leased from PostgreSQL with `FOR UPDATE SKIP LOCKED`, refreshed in Redis, queried from merchant-authoritative state using server-side credentials, and retried with exponential backoff without depending on an agent retry.
15. **Audit boundary** — proxy decisions are emitted to an `AuditSink`. Payment credentials and authorization material are recursively redacted before audit persistence.

## ACP trust boundary

Mino deliberately does **not** authorize against prices supplied by the agent. For checkout completion it first retrieves the merchant's current ACP `CheckoutSession` and evaluates the returned line items, product categories, and cart totals. The payment completion request is never forwarded unless that authoritative state receives a final `ALLOW` and Redis successfully reserves allowance.

Human approval does not weaken this boundary. A pending payment is not forwarded. After approval, the agent must retry the same idempotency key and exact payment request; Mino refetches the current merchant CheckoutSession and re-runs the current mandate and machine controls. Only the same reviewed soft spend-limit breach may be converted to `ALLOW`.

Once payment dispatch begins, absence of a response is not interpreted as failure. Mino keeps the allowance held until success or failure is proven. A retry with the same idempotency key either replays a terminal durable result or uses the latest merchant CheckoutSession to reconcile the unresolved outcome without forwarding another payment. The background reconciler can perform the same authoritative recovery without an agent retry. See `docs/payment-outcome-reconciliation.md`.

The MVP exposes:

```text
POST /v1/acp/:merchantId/checkout_sessions
POST /v1/acp/:merchantId/checkout_sessions/:checkoutSessionId/complete
GET  /v1/approvals/:approvalRequestId
POST /v1/approvals/:approvalRequestId/votes
```

The ACP request body remains protocol-compatible. Mino-specific delegation and agent-proof material lives in headers. Approval bridge endpoints use separate timestamped HMAC authentication. See `openapi/mino.openapi.yaml`.

## Human approval invariants

- Approval state exists durably before the notification webhook is attempted. Notification delivery is therefore recoverable and may be treated as at-least-once using the stable approval-request/event ID.
- A reused organization/idempotency key with a changed raw request digest is a conflict.
- `DUAL_SIGNATURE_SLACK` requires two distinct approver identities. The same approver/same decision is idempotent; changing a prior vote is rejected.
- Any `REJECT` vote terminally rejects the request. Expired requests cannot accept late votes.
- Approval grants never override restricted categories, merchant/identity failures, mandate revocation/expiry, velocity controls, cross-merchant burst controls, or invalid FX state.
- Transaction-limit approval applies only to the same reviewed transaction-limit breach.
- Daily-limit approval also binds the reviewed prior-spend snapshot. If committed/reserved daily exposure has increased before retry, the approval is stale and payment is blocked.
- Temporary Redis reservations are released while approval is pending. Only the reservation-attempt idempotency entry is cleared so an exact approved retry can reserve again; the durable PostgreSQL ApprovalRequest remains the authoritative replay guard.
- A narrowly scoped approved daily-limit retry may cross the Redis daily cap, but it still cannot bypass velocity or cross-merchant controls.

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

- Implement the PostgreSQL `AuditSink` with cryptographic event signing and tamper evidence.
- Add merchant/mandate/agent-key Prisma repositories and production application wiring.
- Add an explicit delivery/outbox mechanism for approval notifications so webhook delivery can retry independently of the request path.
- Expand ACP proxy coverage to retrieve/update/cancel while keeping only payment-bearing operations behind spend reservation.
