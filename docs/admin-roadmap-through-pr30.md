# Administrative roadmap through PR #30

This document records the intended sequence for Mino's administrative control plane from the completion of PR #23 through the first web console in PR #30.

The sequence is deliberate. PRs #24-#26 complete the core administrative configuration plane. PRs #27-#29 add governance, operating workflows, and audit/operations visibility. PR #30 places the first customer-facing web console over those already-governed APIs.

This roadmap is the authoritative planning sequence through PR #30 unless a later explicit roadmap change replaces it. It is not a license to collapse multiple slices into one PR or to weaken the security boundaries already implemented.

## Sequence

| PR | Planned slice | Purpose |
| --- | --- | --- |
| #23 | Audited administrative agent lifecycle | Complete machine-identity lifecycle controls. |
| #24 | Policy management | Make policy configuration safely writable and version-aware. |
| #25 | Merchant administration | Make the registered merchant trust boundary safely administrable. |
| #26 | Mandate issuance and revocation | Expose the first administrative grant/removal of agent economic authority. |
| #27 | High-risk administrative-change governance | Add four-eyes/separation-of-duties controls above sensitive mutations. |
| #28 | Transaction and approval administrative APIs | Give authorized operators organization-scoped visibility and governed approval actions. |
| #29 | Audit and operations APIs | Expose safe audit verification and operational investigation surfaces. |
| #30 | First web console | Provide a customer-facing administrative UI over the completed control-plane APIs. |

## Invariants carried through every slice

The following rules are cumulative and remain binding throughout this roadmap:

- Administrative authentication remains cryptographic and separate from Mino authorization. A valid external identity is not sufficient without an active organization-local membership and the exact required Mino permission.
- Every administrative route is organization-scoped before governed state is materialized. Cross-tenant fetch-and-filter behavior is not acceptable.
- Route handlers authorize narrow permissions, not role names.
- Successful administrative mutations commit governed state and their signed `AdminAuditLog` receipt atomically in one PostgreSQL transaction.
- Replay/no-op behavior must not manufacture duplicate administrative audit history.
- Administrative audit remains independently sequenced from transaction audit and independently checkpoint-retained outside PostgreSQL.
- Secret material, raw bearer tokens, private keys, merchant credentials, and raw agent public-key bodies do not enter response or audit projections unless a future design explicitly establishes a safe reason and boundary.
- Monetary values remain exact minor-unit integers/strings across database and HTTP boundaries; JavaScript floating-point money is not introduced.
- Existing transaction-path safety remains authoritative: merchant-authoritative checkout state, mandate validation, deterministic policy evaluation, Redis reservation controls, durable reservation/payment state, approval revalidation, and reconciliation are not bypassed by administrative APIs.
- Production schema changes, when required, use committed Prisma migrations and the existing migration/runtime authority split.
- Each PR receives focused unit/integration coverage, real PostgreSQL coverage for durable invariants, production-composition coverage where relevant, and an exact-head green GitHub verification gate before merge.
- New administrative convenience must fail closed rather than create a second source of truth for identity, policy, merchant, mandate, approval, payment, or audit state.

## PR #23 — Audited administrative agent lifecycle

**Status: implementation complete; current merge slice.**

PR #23 completes post-enrollment agent identity control:

- organization-scoped single-agent detail;
- explicit `agent.suspend`, `agent.reactivate`, and `agent.rotate_key` authority;
- immediate suspension enforcement through the same active-agent resolution used by mandate/key verification;
- explicit reactivation rather than implicit status recovery;
- atomic Ed25519 key rotation that makes the previous key ID unusable for new requests;
- terminal `REVOKED` semantics;
- replay-safe lifecycle operations without duplicate audit receipts; and
- safe public-key fingerprints rather than raw key material in administrative/audit projections.

Agent identity remains separate from economic authority. Enrollment, suspension/reactivation, and key rotation do not issue a spend mandate.

## PR #24 — Policy management

**Goal:** turn the existing read-only policy inventory into a governed version-aware policy administration surface.

Expected scope:

- organization-scoped policy detail;
- create a policy/version using `policy.create`;
- activate a policy version using `policy.activate`;
- deactivate a policy version using `policy.deactivate`;
- preserve exact `BIGINT` monetary semantics and the existing policy fields for merchant scope, category restrictions, approval mode, velocity, cross-merchant burst, budget, and rolling daily limits;
- reject malformed, internally inconsistent, or organization-mismatched policy input before mutation;
- atomically append signed administrative receipts for actual policy transitions; and
- verify policy changes against the same production policy/mandate resolution paths used by transaction authorization.

### Versioning rule

Historical effective policy state must remain explainable. The preferred model is version creation rather than silently rewriting an already-governing policy snapshot in place. Existing mandates continue to carry their bound policy version/snapshot semantics; policy administration must not retroactively rewrite signed or persisted historical authorization facts.

### Exit condition

An authorized administrator can safely create and control policy versions through the admin plane, while transaction authorization remains deterministic, replay-safe, and historically attributable.

## PR #25 — Merchant administration

**Goal:** make Mino's registered merchant trust boundary safely configurable through the administrative plane.

Expected scope:

- organization-scoped merchant detail;
- create/register merchant endpoints using `merchant.manage`;
- update permitted merchant metadata/configuration without exposing secrets;
- activate and deactivate merchant endpoints explicitly;
- preserve the existing rule that agents select a server-registered merchant ID and can never supply an arbitrary forwarding URL;
- validate HTTPS/base-URL/domain consistency and organization ownership before commit;
- preserve safe inventory projections that omit internal upstream details where they are not required by the caller;
- make merchant deactivation effective immediately for new agent requests; and
- commit each actual merchant mutation atomically with its signed administrative receipt.

### Trust-boundary rule

Merchant administration configures the server-side allowlisted destination boundary. It must not become a generic proxy-registration endpoint, credential-return API, or path for agents to nominate arbitrary network destinations.

### Exit condition

Authorized administrators can manage the merchant registry without weakening SSRF/network-destination protections or leaking upstream credentials/configuration unnecessarily.

## PR #26 — Mandate issuance and revocation

**Goal:** expose the first administrative API that can deliberately grant or remove an agent's economic authority.

Expected scope:

- organization-scoped mandate list/detail via `mandate.read`;
- issue a mandate using `mandate.issue`;
- revoke a mandate using `mandate.revoke`;
- issuance binds an active organization-local user, active agent, and eligible policy/version;
- issuance snapshots the policy-governed monetary, merchant, category, approval, velocity, and cross-merchant controls already represented by `AgentMandate`;
- preserve deterministic signed-token semantics and store only the existing durable token/JTI integrity facts rather than raw reusable mandate tokens;
- define bounded validity/expiry behavior and reject invalid temporal windows;
- revocation becomes effective immediately for new authorization attempts;
- exact issuance/revocation retries are replay-safe; conflicting retries fail closed; and
- every actual mandate transition and signed administrative receipt commit atomically.

### Economic-authority rule

PR #26 is intentionally later than agent, policy, and merchant administration because a mandate is the object that connects machine identity to spend authority. Identity management alone must continue to grant zero spending power.

### Exit condition

Mino has a complete administrative configuration plane for the core chain:

`administrator -> agent identity -> policy -> merchant boundary -> mandate -> transaction authorization`

## PR #27 — High-risk administrative-change governance

**Goal:** add separation-of-duties/four-eyes control above mutations whose compromise can materially change security or economic authority.

Expected scope:

- introduce a durable administrative-change approval/request primitive distinct from transaction `ApprovalRequest` state;
- bind each request to the exact organization, actor, requested action, resource, canonical request digest, and proposed state transition;
- require distinct authorized administrative principals for request and approval where the governed action demands separation of duties;
- prevent the initiating actor from satisfying a two-person control alone;
- support deterministic expiry, rejection, duplicate-vote/retry handling, and terminal resolution;
- revalidate authorization and the proposed state transition immediately before execution;
- execute the governed mutation only after the required approval state is satisfied;
- atomically record the final mutation and signed administrative audit receipt; and
- retain enough signed/audited evidence to reconstruct who proposed, approved, and executed the change.

Candidate high-risk transitions include policy activation, mandate issuance, security-sensitive agent recovery/key changes, and other authority-expanding actions selected during implementation. The exact governed-action set should be explicit and code-reviewed rather than implied by generic role power.

### Non-goal

This slice does not introduce an arbitrary customer-authored ABAC/policy language for administrative authorization. It layers bounded governance above the deterministic RBAC substrate already implemented.

### Exit condition

Mino can enforce genuine multi-human control over selected high-risk administrative changes without reusing or weakening transaction-approval semantics.

## PR #28 — Transaction and approval administrative APIs

**Goal:** give authorized operators safe organization-scoped operational visibility into transactions and human approvals, with governed approval actions where appropriate.

Expected scope:

- organization-scoped approval inventory/detail via `approval.read`;
- organization-scoped payment/outcome inventory/detail via `payment.read`;
- safe visibility into relevant mandate, agent, merchant, amount, status, timestamps, reconciliation state, and approval state without exposing credentials or unsanitized upstream material;
- deterministic pagination and bounded query inputs;
- administrative approval voting via `approval.vote` only if the final design can map the authenticated admin principal to the existing distinct-human approval invariant without weakening callback authentication or replay protections;
- preserve approval revalidation: an administrative approval decision never itself forwards payment or bypasses a fresh transaction retry/re-evaluation;
- preserve merchant-authoritative reconciliation and the rule that unresolved payment outcomes cannot be manually declared successful merely for operator convenience.

### Operational-authority rule

Administrative APIs may expose and govern approved operator actions, but they do not create a manual escape hatch around payment outcome truth, reservation accounting, or policy enforcement.

### Exit condition

Authorized operators can investigate transaction/approval state and perform explicitly governed approval actions without direct database access or transaction-path bypasses.

## PR #29 — Audit and operations APIs

**Goal:** expose the evidence and operational state needed to investigate Mino safely from the administrative plane.

Expected scope:

- organization-scoped transaction-audit reads via `audit.read`;
- organization-scoped administrative-audit reads via `audit.read`;
- explicit chain verification via `audit.verify`;
- retained-checkpoint verification/status sufficient to distinguish database-local consistency from independently retained proof;
- bounded operational summaries for approvals, reservations, unresolved payments, reconciliation state, and audit coverage where useful;
- deterministic pagination/limits for ledger reads;
- sanitized projections that preserve integrity-relevant facts without exposing secret request material;
- verification operations remain observational and cannot mutate the chain they are checking.

### Integrity-claim rule

The API and UI must continue to describe Mino's ledgers as **tamper-evident**, not magically immutable. Independent checkpoint retention strengthens the trust boundary but does not make an attacker controlling both PostgreSQL and the external retention system disappear.

### Exit condition

An authorized auditor/operator can inspect and verify Mino's durable evidence and operating state through supported APIs rather than database access, ad hoc scripts, or log archaeology.

## PR #30 — First web console

**Goal:** place the first customer-facing administrative experience over the completed control-plane APIs.

The console should be deliberately thin. The backend remains the authorization and integrity boundary.

Initial functional areas should cover the surfaces completed by #23-#29:

- organization/access context;
- agents and agent lifecycle;
- policies;
- merchants;
- mandates;
- high-risk administrative change requests/approvals;
- transaction approvals;
- payment/outcome investigation; and
- audit/verification and operational views.

### Console security rules

- no direct database access from the browser;
- no browser-side reimplementation of RBAC, policy enforcement, audit logic, or transaction authorization;
- the UI may hide unavailable actions for usability, but the server must independently authorize every request;
- no private signing keys, merchant credentials, database credentials, retention secrets, or reusable mandate material are delivered to the browser;
- sensitive mutations display the exact organization/resource/action being changed and respect any #27 multi-human governance requirement;
- UI retries must preserve API idempotency/replay semantics rather than inventing client-only success state;
- browser authentication/session integration must preserve the cryptographically authenticated administrative ingress model rather than adding an unauthenticated convenience path.

### Exit condition

Mino has its first usable administrative product surface without moving trust, authority, or durable truth out of the backend control plane.

## Phase boundaries

### PRs #22-#26 — Complete the administrative configuration plane

The configuration phase establishes the objects required to define economic authority safely:

1. agent enrollment;
2. agent lifecycle;
3. policy management;
4. merchant administration; and
5. mandate issuance/revocation.

At the end of #26, an organization can configure the core Mino authority chain through supported audited APIs.

### PRs #27-#29 — Complete the administrative governance and operating loop

The operating phase adds:

1. multi-human governance for dangerous configuration changes;
2. transaction/approval operational APIs; and
3. audit/operations investigation and verification APIs.

At the end of #29, the backend should expose the principal administrative workflows required by a console without requiring direct database access.

### PR #30 — Productize the control plane

Only after the backend authority model is complete enough does Mino add its first web console. This ordering prevents the UI from defining security semantics accidentally or forcing premature backend shortcuts.

## Explicit non-goals through PR #30

Unless deliberately promoted into a future roadmap revision, this sequence does not promise:

- a generic customer-authored administrative ABAC language;
- arbitrary agent-selected merchant destinations;
- direct browser/database coupling;
- manual payment-success overrides for unresolved merchant outcomes;
- bypass of current policy/mandate checks through administrator convenience endpoints;
- storage or display of private signing keys or reusable merchant credentials;
- exactly-once external webhook/checkpoint delivery claims;
- magical immutability claims for PostgreSQL-backed audit chains; or
- a large UI-first rewrite of the backend security model.

## Roadmap change discipline

If implementation evidence shows that a slice must move, split, or gain a prerequisite, update this document explicitly before silently changing the sequence. The important property is not preserving a number at all costs; it is preserving the architectural dependency chain and making roadmap changes reviewable.