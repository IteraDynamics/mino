# Administrative web console

Mino's administrative web console is a thin same-origin operator interface over the governed administrative APIs. It is intentionally not a second control plane: authentication, organization-local authorization, validation, durable state transitions, signed administrative audit, transaction authorization, payment reconciliation, and four-eyes governance remain backend responsibilities.

## Availability and browser boundary

The console is served by the existing Fastify runtime at:

```text
GET /console
GET /console/
GET /console/styles.css
GET /console/app.js
```

Console routes are registered only when trusted administrative JWT ingress is configured. There is no separate frontend service, CORS origin, third-party JavaScript dependency, independent frontend authorization model, or browser credential store.

For the current concierge pilot flow, an operator connects with the target organization UUID plus an existing signed administrator bearer JWT. The browser calls:

```text
GET /v1/admin/organizations/:organizationId/access
```

A successful response supplies the exact organization-local principal, membership, roles, permissions, and safe enrolled presentation metadata used by the console.

The administrator token exists only in in-memory JavaScript state. It is not written to `localStorage`, `sessionStorage`, cookies, IndexedDB, URLs, HTML data attributes, analytics, or server-side console persistence. Disconnect or page reload clears it. API requests use same-origin paths, `credentials: omit`, `cache: no-store`, and `Referrer-Policy: no-referrer`.

Console assets use restrictive CSP/frame/referrer/content-type/opener/resource/permissions headers. Dynamic API values are written to DOM text nodes rather than executable HTML.

## Human-readable identity without authority drift

The console shows enrolled organization name and administrator display name/email before technical UUIDs when those values exist. Stable organization, principal, and membership IDs remain available for support and audit work.

Human-readable metadata is presentation-only. JWT email/display-name claims do not become Mino profile facts, and changing an enrolled display name or email does not change authorization.

## Guided design-partner setup

PR #42 adds an explicit first-run checklist to the Overview page. It guides the operator through the current pilot path:

```text
beneficiary
    ↓
keyed agent identity
    ↓
active policy
    ↓
active execution / merchant route
    ↓
governed mandate
```

The checklist uses only existing safe administrative reads and exact permissions. It does not create a new readiness authority or reinterpret backend semantics. A step can be shown as ready, next, waiting, unavailable, or unreadable; backend state remains authoritative.

The checklist inspects up to the first 100 visible resources in each relevant inventory and explicitly warns when a list is truncated. It is designed for the deliberately small first-pilot shape, not as a substitute for the full inventory APIs.

## Beneficiaries

A spending beneficiary is a `User`: the person or business user on whose behalf an agent may later receive delegated authority. It is not an administrative principal.

With `beneficiary.read`, the console can list and inspect beneficiaries. Additional narrow permissions are:

- `beneficiary.create` — create an active organization-local beneficiary;
- `beneficiary.suspend` — suspend an active beneficiary.

Creation by itself grants no spending authority. It does not create an agent, policy, mandate, payment credential, or administrator.

Suspension commits with signed administrative audit evidence and immediately removes the beneficiary from the production mandate-resolution path. Historical mandates are not deleted or rewritten; they simply stop resolving for new requests while the beneficiary is inactive.

There is intentionally no beneficiary reactivation control in the current pilot surface. Reactivation could restore still-valid historical mandates, so authority restoration is not treated as a convenience toggle.

## Agents

With `agent.read`, operators can inspect machine identities. Permission-specific controls include:

- `agent.create` — enroll an Ed25519 agent identity;
- `agent.suspend` — suspend an active agent;
- `agent.reactivate` — reactivate a suspended agent;
- `agent.rotate_key` — rotate Ed25519 verification material.

Agent identity management alone does not grant spending authority. Key rotation and agent lifecycle actions remain backend-authorized and signed-audited.

## Policies and human money entry

With `policy.read`, operators can inspect versioned policy configuration. The console exposes existing backend operations for inactive creation/versioning, governed activation, and direct fail-closed deactivation.

Policy activation uses the durable four-eyes administrative governance domain. A distinct currently authorized administrator must approve the exact activation proposal, and apply revalidates authority plus target state before mutation.

PR #42 changes only the **entry experience** for monetary policy limits. Operators now enter values in major currency units, for example:

```text
USD 2500.00
JPY 2500
BHD 12.345
```

The browser converts those strings exactly to the existing backend minor-unit fields:

```text
maxBudgetMinor
rollingDailyLimitMinor
```

Conversion uses decimal-string parsing plus integer/`BigInt` arithmetic. Monetary values are not passed through JavaScript floating-point arithmetic. Supported currency exponents remain explicit: USD/EUR/GBP use 2 decimals, JPY uses 0, and BHD/KWD use 3.

Malformed input, negative values, unsupported currencies, and excess decimal precision are rejected before submission. Changing the selected currency does **not** perform foreign-exchange conversion; the operator must review both monetary values explicitly in the newly selected currency.

Persisted minor-unit values continue to be the backend source of truth and are rendered back into exact human major-unit form for policy versioning.

## Execution / merchant routing

With `merchant.read`, operators can inspect registered merchant endpoints. `merchant.manage` permits existing inactive registration/configuration plus activation/deactivation.

The console never receives merchant/provider credentials. Current pilot setup uses the production merchant routing boundary as the concrete execution-route step. Generic provider onboarding remains a later customer-driven pilot slice rather than a client-side abstraction invented here.

## Mandates and four-eyes governance

With `mandate.read`, operators can inspect delegated authority. `mandate.issue` creates a governance proposal rather than an active mandate.

The mandate proposal UI now selects an **active human-readable beneficiary**, active keyed agent, and active policy version from safe inventories instead of requiring the operator to paste a beneficiary UUID. Stable IDs remain the values submitted to the backend.

A distinct currently authorized administrator must approve the exact mandate proposal. Approval alone does not create authority. During explicit apply, Mino revalidates the proposer, distinct approver, applying administrator, exact proposal binding, and current target state.

Only successful apply mints the signed mandate token. The raw bearer token is shown once and is not persisted in governance/audit state. `mandate.revoke` remains a direct RBAC fail-closed action and immediately removes the mandate from subsequent transaction-path resolution.

## Governance versus transaction approval

Administrative governance and transaction-level human approval remain separate trust domains.

The bounded administrative four-eyes actions are currently:

- `policy.activate`;
- `mandate.issue`.

The proposer cannot approve their own request. Approval is bound to exact proposal/precondition digests, and stale target or authority state produces `STALE` rather than reusing old approval.

Transaction `approval.vote` does not activate policies or issue mandates. Likewise, administrative approval cannot force a payment result. An approved transaction must still retry through current mandate, agent, policy, reservation, provider, and reconciliation controls.

## Payments, audit, and operations

Payment views remain observational. The console provides no force-success, force-failure, reservation release/commit, reconciliation-completion, lease-clearing, or provider-evidence override controls.

Audit views expose safe transaction/admin evidence and operational recovery signals. `audit.verify` invokes the backend cryptographic verifier; verification cannot repair, truncate, rewind, or replace an audit chain.

## Pilot boundary

The console is intended for a concierge design-partner pilot, not anonymous/self-service signup.

Current limitations remain explicit:

- organization/bootstrap provisioning is operator-assisted;
- administrators still connect with an externally issued JWT plus organization UUID;
- execution-provider onboarding is not yet a generic customer self-service flow;
- the first pilot is intentionally small enough that the guided checklist's bounded inventory reads are useful;
- agent application integration is addressed by the next pilot-readiness slice rather than by browser-side protocol invention.

## Secret and authority non-claims

The console does not receive or expose Mino mandate/delegation/audit private keys, merchant/provider credentials, retention secrets, approval webhook secrets, metrics credentials, or browser-only permissions capable of overriding backend authorization.

The web application has no authority beyond the governed administrative APIs.

## Verification expectations

The permanent verification gate continues to prove the backend suite, migrations, and container authority split. Console-specific tests additionally verify:

- hardened no-store/security headers and same-origin first-party assets;
- absence of browser credential persistence and HTML-injection paths;
- human-readable organization/admin and beneficiary presentation while preserving stable IDs;
- guided first-run setup using existing read/mutation routes;
- exact major-unit to minor-unit monetary conversion without floating point;
- use of existing four-eyes governance rather than a browser approval shortcut; and
- absence of invented payment, reconciliation, or audit mutation authority.
