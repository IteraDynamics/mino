# Mino

Mino is a policy, authorization, and security control plane for agentic commerce. It sits between autonomous agents and external checkout/payment protocols, evaluates delegated spending mandates, enforces machine-actor safety controls, and emits an auditable decision before payment authorization can proceed.

## Current MVP slice

This repository currently contains the initial domain contracts, a Prisma 7 PostgreSQL schema/configuration, and the deterministic policy evaluation kernel.

### Policy evaluator invariants

- Money is represented in integer minor units; JavaScript floating-point values are not used for authorization arithmetic.
- Mandates are identity-bound to organization, user, and agent.
- Merchant domains use boundary-aware matching; `shop.example.com` may match `example.com`, while `example.com.evil.test` does not.
- Unknown cart categories fail closed.
- Restricted categories, identity failures, merchant failures, velocity violations, and invalid FX data are hard security blocks and cannot be overridden by human approval.
- Per-transaction and rolling-daily spending-limit breaches may escalate to `PENDING_HUMAN_APPROVAL` only when the mandate uses `DUAL_SIGNATURE_SLACK`.
- Rolling spend includes already-reserved spend to prevent concurrency oversubscription.
- Cross-currency checks require a valid point-in-time FX quote. Conversion uses integer arithmetic and ceiling rounding so FX rounding can never undercount authorization spend.
- Only an `ALLOW` decision is eligible for a downstream delegation assertion.

## Approval mode semantics

For the MVP, `approvalMode` is the disposition for **otherwise-approvable spending-limit breaches**:

- `AUTO_APPROVE`: compliant transactions are automatic; spend-limit breaches are blocked.
- `DUAL_SIGNATURE_SLACK`: compliant transactions are automatic; spend-limit breaches are held for dual human approval.
- `HARD_BLOCK`: compliant transactions are automatic; spend-limit breaches are explicitly hard-blocked.

Security failures are never routed to human override.

## Development

```bash
npm install
npm run prisma:generate
npm run prisma:validate
npm test
npm run typecheck
```

## Next slice

The next implementation layer is the orchestration/proxy boundary:

1. Mandate-token authentication and Ed25519 verification.
2. Redis-backed atomic velocity checks and spend reservations.
3. ACP adapter -> normalized `CheckoutIntent`.
4. Structured Decision API and OpenAPI specification.
5. Signed short-lived outbound delegation assertions.
6. Append-only audit persistence.
