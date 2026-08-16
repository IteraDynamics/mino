# Transaction and approval administrative APIs

Mino exposes an organization-scoped administrative operations surface for durable human approvals and payment outcomes. The surface is intentionally narrower than the underlying persistence models: it is designed for operator visibility and legitimate approval participation without creating a payment override API.

## Authentication and permissions

These routes exist only when trusted administrative JWT issuers are configured. Every request first passes the pinned-issuer JWT boundary and then the exact organization-local permission check.

```text
GET  /v1/admin/organizations/:organizationId/approvals
     approval.read

GET  /v1/admin/organizations/:organizationId/approvals/:approvalRequestId
     approval.read

POST /v1/admin/organizations/:organizationId/approvals/:approvalRequestId/votes
     approval.vote

GET  /v1/admin/organizations/:organizationId/payments
     payment.read

GET  /v1/admin/organizations/:organizationId/payments/:paymentOutcomeId
     payment.read
```

A role that can inspect approval/payment state does not automatically gain `approval.vote`. In the built-in catalog, `FINANCE_MANAGER` and `SECURITY_ADMIN` can inspect the operational state relevant to their responsibilities while `APPROVER` is the narrow role that can participate in a transaction approval vote.

All responses use `Cache-Control: no-store`.

## Approval inventory and detail

Approval inventory is ordered deterministically by:

```text
createdAt DESC, id DESC
```

The opaque cursor encodes that pair. `limit` defaults to 50 and is bounded to 1–100.

Supported approval filters are:

- status
- user ID
- agent ID
- mandate ID
- merchant ID
- created-after timestamp
- created-before timestamp

The response is a safe projection. It includes the durable identities needed to correlate the approval, merchant/domain context, policy version, reason codes, exact minor-unit amount string, signature/vote counts, status, and lifecycle timestamps.

It deliberately does **not** expose:

- the administrative or transaction idempotency key
- the raw request digest
- the requested payment payload
- merchant checkout/session snapshots
- prior-spend snapshots
- arbitrary approval metadata
- bearer credentials or other secrets

Detail responses may include votes. An administrative JWT vote is represented by the stable Mino `AdminPrincipal` identity, while a pre-existing approval-bridge vote remains represented by its bridge approver identity. Vote metadata is not returned.

### Effective expiration

A read is observational. If a persisted `PENDING` request has already passed `expiresAt`, its administrative projection reports `EXPIRED` without mutating PostgreSQL merely because an operator opened a page.

A later attempted vote follows the existing durable approval semantics: the request is materialized as terminal `EXPIRED` and the vote is refused. That expiry transition is not represented as a successful administrative vote and does not manufacture an `approval.vote` audit receipt.

## Administrative approval voting

The vote body is deliberately small:

```json
{
  "decision": "APPROVE",
  "comment": "optional bounded comment"
}
```

No request field can change the transaction, policy, mandate, amount, merchant, approval threshold, or expiry.

Administrative approvers are stored in the existing `ApprovalVote` uniqueness domain using a namespaced stable identity derived from `AdminPrincipal.id`. This makes the distinct-voter rule independent of mutable email/display-name metadata and prevents an administrator from obtaining multiple votes by presenting different JWTs for the same principal.

The administrative vote path preserves the existing approval state machine:

- a pending non-expired request may receive a vote
- `REJECT` is immediately terminal
- `APPROVE` becomes terminal only when the existing required-signature threshold is met
- an exact same-principal/same-decision replay is idempotent
- the same principal cannot change an existing vote
- expired or otherwise terminal approvals refuse new votes

A successful new administrative vote, any resulting approval status transition, and its signed `AdminAuditLog` receipt commit inside one PostgreSQL transaction. A replay/no-op does not append artificial audit history.

The administrative audit binds the actor, permission, approval ID, decision, and request digest. The raw comment is not duplicated into administrative audit state.

## Approval does not equal payment authority

An `APPROVED` approval request is not a direct payment command. The agent must still retry the exact governed transaction path. Mino then refetches merchant-authoritative checkout state and revalidates the active mandate, policy snapshot, merchant scope, amount/context, approval binding, current spend/velocity controls, reservation state, and other hard blocks.

The administrative route therefore participates in the existing human-approval decision; it does not bypass the transaction authorization pipeline.

## Payment outcome inventory and detail

Payment inventory uses the same deterministic recent-first cursor model and supports filters for:

- durable payment status
- user ID
- agent ID
- mandate ID
- merchant ID
- checkout-session ID
- created-after timestamp
- created-before timestamp

Minor-unit amounts remain exact decimal strings.

The safe projection contains durable operator-relevant state such as:

- payment/reservation/mandate identities
- merchant/domain/checkout context
- amount and currency
- durable `PaymentOutcomeStatus`
- upstream HTTP status when known
- bounded internal last-error code
- reconciliation attempt count
- forwarding/resolution/reconciliation timing
- the next scheduled reconciliation time

The derived `reconciliationState` is only an operator-facing summary:

```text
FORWARDING          -> FORWARDING
UNKNOWN             -> PENDING
SUCCEEDED           -> RESOLVED
FAILED_DEFINITIVE   -> RESOLVED
```

The response deliberately omits:

- raw request digest
- idempotency key
- upstream response body
- upstream response headers
- reconciliation lease owner/lease expiration
- merchant credentials
- authorization/delegation bearer material

## No payment override API

PR #28 adds **no** administrative payment mutation route.

An administrator cannot use this surface to:

- mark an unknown payment successful
- mark it definitively failed
- release a spend reservation
- commit spend manually
- force reconciliation completion
- replace merchant-authoritative evidence

`FORWARDING` and `UNKNOWN` outcomes therefore remain held and reconciled by the existing payment-outcome/reconciliation machinery. This preserves the rule that transport ambiguity is not treated as failure and that only merchant-authoritative evidence can resolve uncertain economic state.

## Tenant and data boundary

Every read and vote query includes the route organization ID in PostgreSQL before state is returned or mutated. Cross-organization IDs do not become a global lookup followed by an application-layer filter.

Administrative reads are not transaction audit events. A successful administrative vote is a governed mutation and is written to the separate signed administrative change-audit chain; the transaction audit chain remains a separate integrity domain.

## Relationship to high-risk administrative governance

This surface does not implement the separately planned high-risk administrative change-governance layer. Transaction approval voting is the existing human spend-approval mechanism, not a general mechanism for approving policy, mandate, merchant, identity, or other administrative configuration changes.
