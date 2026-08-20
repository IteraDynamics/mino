# Mino roadmap through PR #30, with governance completion

This document preserves the planned sequencing after PR #23 so future work does not have to be reconstructed from conversation history.

The roadmap is a sequencing and architecture contract, not a frozen endpoint specification. Each pull request should still begin by reconciling the intended slice with the current schema, runtime, and preceding merged head.

## Implementation status

The originally requested implementation sequence through PR #30 is complete. The deliberately deferred high-risk administrative change-governance slice originally planned as roadmap PR #27 is implemented by GitHub PR #39.

Implemented:

- #23 — audited administrative agent lifecycle;
- #24 — policy management;
- #25 — merchant administration;
- #26 — mandate issuance and revocation;
- roadmap #27 — high-risk administrative change governance / durable four-eyes separation of duties, implemented by GitHub PR #39;
- #28 — transaction and approval administrative APIs;
- #29 — audit and operations APIs;
- #30 — first web console.

GitHub PR #27 itself was a short-lived draft of the transaction/approval work and was closed unmerged solely to preserve the requested repository numbering for PR #28. It must not be interpreted as implementation of the roadmap #27 governance slice. The actual implementation is GitHub PR #39.

The bounded four-eyes layer applies to authority-creating/enabling mutations selected by the roadmap: mandate issuance and policy activation. Other administrative mutations remain direct RBAC unless separately governed by design; authority-removing actions such as mandate revocation and policy deactivation deliberately remain available without waiting for a second administrator.

## Governing implementation rules

The following rules carry across every administrative slice:

- build each PR from the current merged `main` and keep the scope narrow;
- require the GitHub verification gate to pass on the exact head that will be merged;
- reuse the pinned-issuer administrative JWT boundary and exact organization-local RBAC rather than introducing parallel authentication or authorization paths;
- authorize narrow permissions, not role names, at route boundaries;
- keep administrative authority separate from agent spending authority;
- make every actual governed administrative mutation and its signed `AdminAuditLog` receipt commit in one PostgreSQL transaction;
- preserve replay-safe/idempotent behavior where retries are meaningful and never manufacture duplicate administrative audit history for no-op replays;
- keep administrative and transaction audit chains independently sequenced and independently verifiable;
- retain administrative audit checkpoints outside the PostgreSQL trust boundary using the existing retention mechanism;
- expose fingerprints, identifiers, and safe projections rather than raw key material, credentials, bearer tokens, upstream secrets, or other sensitive configuration;
- fail closed on tenant mismatch, stale/inactive resources, malformed state, ambiguous authority, and incomplete persistence;
- make security-sensitive administrative state changes effective at the same durable source of truth consumed by the transaction path;
- do not weaken merchant-authoritative payment outcome handling, reconciliation, spend reservation, approval revalidation, or other existing transaction invariants to make the admin plane easier to operate.

## Phase 1 — complete the administrative configuration plane

### PR #24 — Policy management

Add governed policy creation and lifecycle management on top of the existing organization-scoped policy inventory.

Planned scope:

- read a single policy/version with safe lossless monetary projections;
- create policy drafts using `policy.create`;
- define new versions instead of silently rewriting historical policy meaning in place;
- modify the configurable limits and controls represented by the policy model, including budget, rolling daily limit, merchant/vendor scope, restricted categories, approval mode, velocity, and cross-merchant controls;
- activate and deactivate policy versions through the narrow `policy.activate` and `policy.deactivate` permissions;
- validate currency, `BIGINT` minor-unit values, arrays/scopes, thresholds, and bounded integer controls before persistence;
- make activation/deactivation semantics deterministic and safe for existing mandates that already snapshot a policy version;
- atomically append a signed administrative change receipt for every actual create/version/activation transition.

Critical boundary:

Policy administration defines reusable governance configuration. It does not itself grant an agent spending authority. Existing mandates remain the durable authority binding a user, agent, policy snapshot, scope, and expiry.

### PR #25 — Merchant administration

Add governed registration and lifecycle management for merchant endpoints.

Planned scope:

- register organization-local merchants using `merchant.manage`;
- manage external merchant identity, domain, optional vendor ID, active state, and server routing configuration;
- preserve exact organization scoping and stable merchant identity;
- validate HTTPS/domain routing boundaries so administration cannot turn the merchant registry into an arbitrary forwarding proxy;
- expose only safe merchant projections to administrators;
- keep merchant credentials outside the merchant database record and outside administrative API responses;
- make activation/deactivation or routing changes immediately authoritative for subsequent merchant resolution;
- atomically append signed administrative change receipts for actual merchant mutations.

Critical boundary:

Merchant administration controls which merchant endpoints Mino may resolve. It does not bypass mandate merchant/vendor scope, policy checks, ACP version pinning, agent authentication, or payment authorization.

### PR #26 — Mandate issuance and revocation

Complete the configuration plane by allowing authorized administrators to grant and remove delegated spending authority.

Planned scope:

- organization-scoped mandate detail/inventory through `mandate.read`;
- issue mandates through `mandate.issue` only for active organization-local resources;
- bind issuance to the intended user, agent, policy version/snapshot, merchant/vendor scope, currency, limits, controls, and expiration;
- preserve the existing durable mandate snapshot as the server-side source of truth rather than trusting client-supplied token claims;
- preserve deterministic signed-token/JTI binding semantics and avoid duplicate authority on equivalent retries;
- revoke through `mandate.revoke` and make revocation immediately fail closed in the existing transaction-path mandate resolver;
- keep expired/revoked authority terminal unless a new mandate is explicitly issued;
- atomically commit mandate issuance/revocation and the signed administrative receipt.

Critical boundary:

This is the first administrative slice that can grant economic authority. It must therefore preserve all existing runtime policy, reservation, approval, audit, payment-outcome, and reconciliation controls; issuance cannot be an administrative bypass around them.

## Phase 2 — complete the administrative governance and operating loop

### Roadmap PR #27 — High-risk administrative change governance

**Status: implemented by GitHub PR #39.**

The implemented slice layers explicit governance above RBAC for a bounded set of security-sensitive administrative changes.

Implemented scope:

- `mandate.issue` and `policy.activate` enter a durable governance proposal flow rather than mutating immediately in the production administrative composition;
- the proposal is bound to the exact requested mutation, organization, and target/precondition digest;
- the proposer cannot approve their own proposal;
- approval requires a distinct administrator who currently holds the same underlying narrow mutation permission;
- proposal creation and same-vote retries are deterministic and replay-safe; changed reuse conflicts;
- rejection and expiry are terminal, and changed target/authority state becomes `STALE` rather than being silently accepted;
- the explicit apply step revalidates the applying principal, original proposer, distinct approver, and current target state before mutating;
- the eventual mutation, governance applied transition, and signed administrative evidence commit in one PostgreSQL transaction;
- mandate bearer tokens are minted only during successful apply and are returned once rather than stored in governance state;
- `governance.read` exposes the durable queue without independently granting mutation authority;
- the web console has a separate governance view and no longer represents these two mutations as direct-RBAC actions.

Critical boundary:

This remains a bounded governance layer above deterministic RBAC, not a customer-authored arbitrary ABAC/expression engine. It remains distinct from transaction-level human spend approvals, whose invariants and trust boundary are different. Authority-removing mutations such as `mandate.revoke` and `policy.deactivate` remain direct so an authorized administrator can fail closed immediately.

### PR #28 — Transaction and approval administrative APIs

Expose the existing durable transaction and human-approval state to properly authorized administrators without giving them unsafe ways to rewrite economic truth.

Planned scope:

- organization-scoped read/detail/filter surfaces for durable approval requests and payment/transaction outcomes;
- map access through existing narrow permissions such as `approval.read`, `approval.vote`, and `payment.read`;
- allow governed administrative approval actions only where they can preserve the existing approval invariants, identity requirements, expiry rules, exact-request binding, and revalidation behavior;
- surface reconciliation/pending state clearly without allowing an administrator to mark an unknown payment successful or failed by assertion;
- preserve merchant-authoritative resolution and reservation holds for unresolved payment outcomes;
- avoid exposing sensitive request payload fields, credentials, raw tokens, or merchant secrets.

Critical boundary:

Administrative visibility and approval workflow must not create a manual `force success`, `force release`, or general policy-bypass path. Durable merchant/payment state remains authoritative.

### PR #29 — Audit and operations APIs

Expose the security and operational evidence needed to operate Mino without database access.

Planned scope:

- organization-scoped transaction-audit and administrative-audit reads through `audit.read`;
- explicit chain verification through `audit.verify`;
- surface database-chain verification results and retained-checkpoint verification results without exposing signing private keys or retention secrets;
- expose useful operational state around unresolved payments, reconciliation, approval delivery, audit coverage, and related durable recovery signals;
- keep result schemas bounded and low-risk rather than leaking raw sensitive payloads;
- preserve the distinction between transaction and administrative audit sequence spaces and signature domains.

Critical boundary:

These APIs are observational/verification surfaces. They must not become mutation backdoors into payment outcomes, audit history, chain heads, checkpoints, reservations, or worker state.

## Phase 3 — first customer-facing administrative product

### PR #30 — First web console

Build the first Mino administrative web console on top of the authenticated control-plane APIs.

Implemented scope, including the later PR #39 governance augmentation:

- organization/access context and exact permission-aware navigation;
- agent enrollment and lifecycle management;
- policy management;
- merchant administration;
- mandate issuance/revocation with one-time bearer-token handling;
- transaction/payment and approval visibility;
- transaction approval voting through the existing approval state machine;
- audit verification and operational visibility;
- same-origin first-party assets served by the existing Fastify runtime;
- memory-only use of an externally issued administrative JWT rather than a new Mino browser-session authority;
- a separate durable Governance view for mandate issuance and policy activation;
- one-time mandate token presentation only after a successfully approved and revalidated governance apply.

Console rules:

- the web application receives no hidden authority beyond the API permission model;
- server APIs remain the authorization and validation authority for every operation;
- the browser must not receive Mino private signing keys, merchant credentials, retention secrets, or other server-side secret material;
- unauthorized controls should be absent or disabled for usability, but server-side permission enforcement remains mandatory;
- secret-bearing administrative credentials must not be persisted in browser storage;
- console work should not silently redesign core transaction semantics merely to simplify UI implementation;
- the console must distinguish four-eyes-governed actions from administrative mutations that intentionally remain direct RBAC.

## Roadmap status

| Roadmap PR | Slice | Status |
| --- | --- | --- |
| #23 | Audited administrative agent lifecycle | Implemented |
| #24 | Policy management | Implemented |
| #25 | Merchant administration | Implemented |
| #26 | Mandate issuance and revocation | Implemented |
| #27 | High-risk administrative change governance | **Implemented by GitHub PR #39** |
| #28 | Transaction and approval administrative APIs | Implemented |
| #29 | Audit and operations APIs | Implemented |
| #30 | First web console | Implemented by PR #30; governance workflow augmented by PR #39 |

The originally intended dependency chain was:

```text
agent identity
    -> policy configuration
    -> merchant configuration
    -> delegated mandate authority
    -> high-risk admin governance
    -> transaction/approval operations
    -> audit/operational visibility
    -> web console
```

Implementation intentionally proceeded with #28–#30 while roadmap #27 remained deferred, then returned to complete the missing governance layer as GitHub PR #39. The governance implementation layers above the durable mutation APIs and is consumed by the console; it is not emulated with browser-only approval logic.
