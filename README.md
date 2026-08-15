# Mino

Mino is a policy, authorization, approval, and security control plane for agentic commerce. It sits between autonomous agents and external checkout/payment protocols, evaluates delegated spending mandates, enforces machine-actor safety controls, and emits an auditable decision before payment authorization can proceed.

## Implemented security and reliability path

1. **Spend mandates** — Mino verifies compact Ed25519-signed mandate tokens while the immutable server-side mandate snapshot remains authoritative. Raw mandate tokens are not persisted.
2. **Agent identity proof** — agent requests carry an Ed25519 signature bound to method, exact path, timestamp, nonce, mandate-token JTI digest, ACP version, idempotency value, and canonical body digest. Redis nonce claims reject replay.
3. **Merchant registry boundary** — agents select a server-registered merchant ID, never an arbitrary forwarding URL. Merchant targets must be active HTTPS endpoints whose configured hostname matches the registered domain.
4. **ACP stable-version pin** — the checkout integration is pinned to `API-Version: 2026-04-17`.
5. **Merchant-authoritative checkout evaluation** — payment authorization uses the merchant's current ACP `CheckoutSession`, not agent-supplied price assertions.
6. **Deterministic policy evaluation** — identity, merchant, category, currency, per-transaction limits, rolling daily allowance, velocity, and cross-merchant burst controls fail closed.
7. **Atomic authorization reservation** — Redis Lua performs idempotency, machine-velocity, cross-merchant burst, rolling-spend, and allowance reservation checks atomically in a mandate-local hash slot.
8. **Durable reservation mirror** — an accepted Redis reservation is mirrored into PostgreSQL before the request can advance toward payment dispatch.
9. **Durable human approval** — approvable soft spend-limit decisions are persisted as transaction-bound `ApprovalRequest` records before external notification.
10. **Concurrency-safe approval voting** — PostgreSQL row locks make dual approval, rejection, duplicate votes, and expiration deterministic under concurrency.
11. **Authenticated approval bridge** — approval reads/votes require timestamped HMAC-SHA256 authentication bound to method, exact path, approver identity, and body digest.
12. **Approval revalidation** — an approved retry refetches merchant-authoritative checkout state and re-runs current policy and machine controls. Hard blocks are never human-overridable.
13. **Delegation assertions** — only a final `ALLOW` can mint a short-lived Ed25519 payment delegation assertion bound to the exact transaction context.
14. **Durable payment outcomes** — before merchant dispatch, Mino persists `PaymentOutcome` and extends the short reservation into a reconciliation hold.
15. **Reconciliation-safe completion** — merchant 2xx commits spend; clearly definitive 4xx releases it. Transport loss, 409/422, and 5xx remain unresolved and keep allowance held. Same-idempotency retries reconcile rather than blindly sending a second payment.
16. **Autonomous payment reconciliation** — unresolved outcomes are leased with `FOR UPDATE SKIP LOCKED`, refreshed in Redis, queried from merchant-authoritative state with server-side credentials, and retried with bounded backoff.
17. **Durable approval-notification delivery** — pending approval requests act as a PostgreSQL-backed outbox. Delivery is at-least-once with stable event IDs, leasing, bounded retry/backoff, and dead-letter behavior.
18. **Tamper-evident audit ledger** — sanitized decisions are stored in per-organization SHA-256 chains with sequence numbers and Ed25519 signatures. Verification detects mutation, reordering, gaps, broken links, and invalid signatures.
19. **Independent audit-checkpoint retention** — signed audit-chain heads can be exported to a separately operated HTTPS/HMAC retention bridge using deterministic event IDs for safe at-least-once delivery.
20. **Managed secret inputs and audit-key rotation** — sensitive runtime inputs can come from mounted secret files. Startup validates Ed25519 key material and preserves historical audit public keys across controlled rotation.
21. **Redis cold-loss reconstruction** — complete Redis loss is detectable through a per-mandate reconstruction marker. Mino rebuilds recent committed spend, active reservations, unresolved-payment holds, and velocity facts from durable PostgreSQL state before spending can continue.
22. **Continuous operational recovery** — production continuously schedules approval delivery, payment reconciliation, reconciliation monitoring, and audit-checkpoint retention on non-overlapping process-local loops.
23. **Authenticated ACP lifecycle control** — agents can retrieve, update, and cancel permitted merchant checkouts through the same active-mandate, signed-request, registered-merchant boundary without entering spend reservation or payment delegation.
24. **Operational metrics** — an optional, separately authenticated `/metrics` endpoint exposes low-cardinality Prometheus-compatible durable-state gauges without customer or transaction IDs as labels.
25. **Hardened container runtime** — the production image runs non-root with a healthcheck; the reference Compose deployment uses read-only application filesystems, dropped capabilities, `no-new-privileges`, private PostgreSQL/Redis networking, runtime-mounted secrets, Redis authentication, AOF persistence, and `noeviction`.
26. **Versioned database migrations** — committed Prisma migration history is the governed production/CI schema path. A separate short-lived migration image runs `prisma migrate deploy`, and the reference application service cannot start until migration succeeds.
27. **Administrative identity and RBAC foundation** — administrative humans are represented separately from spending-beneficiary users using stable external `(issuer, subject)` identities, organization-local memberships, durable role assignments, and a centralized fail-closed permission authorizer. Built-in role meanings are deterministic code-reviewed permission bundles rather than mutable database definitions.

## ACP trust boundary

Mino deliberately does **not** authorize payment against prices supplied by the agent. Checkout completion first retrieves the merchant's current ACP `CheckoutSession` and evaluates its line items, categories, and totals. The payment request is never forwarded unless that authoritative state receives a final `ALLOW` and allowance is successfully reserved.

Human approval does not weaken this boundary. A pending payment is not forwarded. After approval, the agent must retry the same idempotency key and exact payment request; Mino refetches the current merchant checkout and re-runs the current mandate and machine controls. Only the same reviewed soft-limit breach may become `ALLOW`.

Once payment dispatch begins, absence of a merchant response is not interpreted as failure. Mino keeps allowance held until success or definitive failure is proven. The background reconciler applies the same merchant-authoritative recovery independently of an agent retry. See `docs/payment-outcome-reconciliation.md`.

Retrieve, update, and cancel are **control operations, not payment authority**. They require a valid active mandate, signed agent request, pinned ACP version, registered active HTTPS merchant, and mandate-approved merchant domain/vendor scope. They do not create spend reservations, approvals, payment outcomes, or delegation assertions. See `docs/acp-checkout-lifecycle.md`.

## HTTP surface

```text
POST /v1/acp/:merchantId/checkout_sessions
GET  /v1/acp/:merchantId/checkout_sessions/:checkoutSessionId
POST /v1/acp/:merchantId/checkout_sessions/:checkoutSessionId
POST /v1/acp/:merchantId/checkout_sessions/:checkoutSessionId/cancel
POST /v1/acp/:merchantId/checkout_sessions/:checkoutSessionId/complete

GET  /v1/approvals/:approvalRequestId
POST /v1/approvals/:approvalRequestId/votes

GET  /healthz
GET  /readyz
GET  /metrics   # optional; dedicated Bearer credential required
```

The ACP request body remains protocol-compatible. Mino-specific mandate and agent-proof material lives in headers. Approval bridge endpoints use separate timestamped HMAC authentication. See `openapi/mino.openapi.yaml`.

The administrative RBAC foundation does **not** yet add customer-facing admin HTTP routes. Future admin endpoints must first cryptographically establish a trusted external issuer/subject and then request the narrow permission required for the exact organization and operation; an email header or single global admin API key is not an administrative identity mechanism.

## Administrative authorization boundary

Administrative authority is separate from agent spending authority. The existing `User` model represents a person on whose behalf an agent may spend; it does not make that person an administrator. `AdminPrincipal` represents an externally authenticated human administrative identity and is keyed by stable `(issuer, subject)`. Email and display name are metadata only.

An administrator must have an `ACTIVE` organization membership before any role grant is considered. Suspended or disabled principals, missing memberships, suspended or removed memberships, organization mismatches, and missing permissions fail closed. A membership in one tenant is never substituted for another.

The initial built-in roles are `ORGANIZATION_OWNER`, `SECURITY_ADMIN`, `FINANCE_MANAGER`, `AGENT_MANAGER`, `APPROVER`, and `AUDITOR`. Roles grant narrow permissions such as `agent.rotate_key`, `policy.activate`, `mandate.issue`, `approval.vote`, and `audit.verify`. Route handlers should authorize permissions rather than branching directly on role names.

Separation of duties begins in the role catalog: `FINANCE_MANAGER` can administer relevant policy/mandate controls but does not automatically receive `approval.vote`; `APPROVER` can vote on human approval but does not thereby gain policy activation or mandate issuance authority. Future bounded resource scopes and four-eyes governance for especially sensitive administrative transitions are intended to layer above this deterministic RBAC substrate rather than becoming an arbitrary customer-authored ABAC expression language. See `docs/admin-authorization.md`.

## Human approval invariants

- Creating a durable `ApprovalRequest` also creates the durable need to notify a human; transaction requests do not depend on an approval webhook being online.
- Approval notification delivery is at-least-once. Downstream bridges must deduplicate the stable approval-request/event ID; Mino does not claim exactly-once webhook delivery.
- Failed notification attempts persist bounded internal error codes rather than raw external exception text or response secrets.
- A reused organization/idempotency key with a changed raw request digest is a conflict.
- `DUAL_SIGNATURE_SLACK` requires distinct approver identities. Replaying the same approver/same decision is idempotent; changing a prior vote is rejected.
- Any `REJECT` vote terminally rejects the request. Expired requests cannot accept late votes.
- Approval never overrides restricted categories, identity/merchant failures, mandate revocation/expiry, velocity, cross-merchant burst, or invalid FX state.
- Daily-limit approval binds the reviewed prior-spend snapshot. Increased exposure before retry makes the approval stale.
- Temporary reservations are released while approval is pending so an exact approved retry must reserve current allowance again.

## Audit-integrity invariants

- Sensitive-field redaction is repeated defensively before hashing and persistence.
- Each organization has an independent monotonic audit sequence serialized by its locked `AuditChainHead` row.
- Every audit row includes the previous digest and an Ed25519 signature over its persisted integrity state.
- Historical verification resolves the row's signing-key ID, allowing safe key rotation without invalidating older records.
- Internal mutation, reordering, middle deletion, sequence gaps, chain-link changes, and signature corruption are detectable.
- The mutable PostgreSQL chain head is operational serialization state, not an independent trust anchor.
- Signed checkpoints are exported to a separate retention boundary so deletion of the newest database suffix can be detected against independently retained proof.
- The ledger is therefore described as **tamper-evident**, not magically immutable against a database superuser. See `docs/audit-integrity.md`.

## Operational metrics

Metrics are opt-in. Production registers `GET /metrics` only when exactly one dedicated credential source is configured:

```text
MINO_METRICS_BEARER_TOKEN
MINO_METRICS_BEARER_TOKEN_FILE
```

The endpoint exposes fixed-enum durable-state gauges for audit decisions, approval states, payment outcomes, spend reservations, unresolved payments, oldest unresolved-payment age, and audit-chain organization coverage. It intentionally omits organization, user, agent, merchant, request, payment, reservation, checkout, idempotency, credential, and monetary identifiers as metric labels.

Metrics-query failure returns 503 only to the scrape request and does not participate in authorization or transaction readiness. See `docs/operational-metrics.md`.

## Redis recovery boundary

Authorization state uses mandate-local Redis keys. Redis remains the atomic concurrency boundary for new reservations, while accepted reservations are durably mirrored into PostgreSQL before a transaction can advance.

After **complete Redis state loss**, the missing reconstruction marker forces Mino to rebuild recent committed spend, active reservations, unresolved holds, and recent velocity facts from durable PostgreSQL state before proceeding. The production wrapper checks the marker before and after authorization operations, so Redis disappearing during an operation fails the request closed.

This is not a claim to detect arbitrary selective eviction while the reconstruction marker survives. The reference Redis deployment therefore uses `maxmemory-policy noeviction`, AOF persistence, authentication, and private networking. See `deploy/redis.conf` and `deploy/README.md`.

## Production runtime

Build and run the compiled service directly with:

```bash
npm run build
npm start
```

Production startup validates critical data stores, keys, and security configuration. `GET /healthz` is process liveness; `GET /readyz` checks PostgreSQL, Prisma, and Redis connectivity. `SIGTERM`/`SIGINT` trigger idempotent graceful shutdown that drains worker activity before closing dependencies.

The hardened container reference is documented in `deploy/README.md`. Its startup dependency is:

```text
PostgreSQL healthy
       ↓
short-lived migration image: prisma migrate deploy
       ↓ success only
long-running Mino service may start
```

The long-running runtime image does not carry Prisma migration history or the Prisma CLI executable. The migration image receives only the database credential needed for schema work; it does not receive Redis, merchant, signing-key, approval, audit-retention, or metrics credentials.

## Database migration governance

Production and CI provision schema from committed history:

```bash
npm run prisma:migrate:deploy
npm run prisma:migrate:status
```

CI starts from an empty PostgreSQL database, applies every committed migration, verifies migration status, diffs the migrated live database back against `prisma/schema.prisma`, and then runs the complete application test suite.

Databases that existed before migration history must **not** blindly run the baseline CREATE statements. They require the documented backup, drift check, and one-time `prisma migrate resolve --applied` baseline procedure. See `docs/database-migrations.md`.

## Development

```bash
npm install
npm run prisma:generate
npm run prisma:validate
npm run prisma:migrate:deploy
npm run typecheck
npm run test:unit
npm run test:integration
```

The GitHub verification gate additionally builds the runtime and migration container targets, verifies their authority split, executes the migration image with a mounted datasource secret, and validates security-relevant Compose properties.

## Next implementation slice

The next product-level slice is the **cryptographically authenticated administrative request boundary plus first narrowly permissioned management APIs**. HTTP authentication must establish a trusted external issuer/subject before the centralized admin authorizer is invoked; subsequent agent, policy, merchant, mandate, membership, and audit surfaces should request explicit organization-local permissions rather than relying on a global administrator credential.
