# Administrative web console

Mino's administrative web console is a thin same-origin operator interface over the governed administrative APIs. It is intentionally not a second control plane: authentication, organization-local authorization, validation, durable state transitions, signed administrative audit, transaction authorization, payment reconciliation, and four-eyes governance remain backend responsibilities.

## Availability

The console is served by the existing Fastify runtime at:

```text
GET /console
GET /console/
GET /console/styles.css
GET /console/app.js
```

Console routes are registered only when trusted administrative JWT ingress is configured. If administrative HTTP access is disabled, Mino does not expose the console shell either.

There is no separate frontend service, CORS origin, browser credential store, third-party JavaScript dependency, or independent frontend authorization model.

## Authentication model

Mino verifies administrator JWTs issued by explicitly configured trusted issuers. It does not yet own an OAuth/OIDC browser-login client or an administrative browser-session service.

For the current design-partner/pilot flow, an operator connects with:

- the target organization UUID; and
- an existing signed administrator bearer JWT.

The browser calls:

```text
GET /v1/admin/organizations/:organizationId/access
```

using that token. A successful response supplies the organization-local principal, membership, roles, exact permissions, and safe presentation metadata used by the console.

PR #40 makes that presentation human-first without changing authority. When enrolled metadata exists, the console shows the organization name and administrator display name/email before technical UUIDs. Stable principal, membership, and organization IDs remain available for support and audit work.

The bearer JWT exists only in the page's in-memory JavaScript state. The console does **not** place it in:

- `localStorage`;
- `sessionStorage`;
- cookies;
- IndexedDB;
- URL query strings or fragments;
- HTML data attributes;
- server-side console persistence;
- analytics/telemetry; or
- third-party code.

The token input is cleared after connection. Disconnect or page reload clears the in-memory token. API requests use `credentials: omit`, `cache: no-store`, same-origin paths, and `Referrer-Policy: no-referrer`.

## Browser security boundary

The console uses only first-party HTML, CSS, and JavaScript served by Mino. It loads no CDN scripts, external fonts, tracking pixels, analytics libraries, or remote images.

Every console asset is served with:

- `Cache-Control: no-store, max-age=0`;
- a restrictive Content Security Policy;
- `frame-ancestors 'none'` and `X-Frame-Options: DENY`;
- `Referrer-Policy: no-referrer`;
- `X-Content-Type-Options: nosniff`;
- same-origin opener/resource policy; and
- a restrictive browser permissions policy.

Dynamic API values are written into DOM text nodes. The console does not turn server-returned names, IDs, comments, domains, or audit values into executable HTML.

## Permission-aware product surface

The console derives usability state from the exact permissions returned by `/access`.

Navigation sections are hidden when their read permission is absent. Mutation controls appear only when the corresponding narrow permission is present. This is a usability layer only; every request still passes through backend JWT verification and organization-local authorization.

### Overview

When `audit.read` is available, the landing view shows durable operational signals including:

- unresolved and claimable payment outcomes;
- stale/high-attempt reconciliation state;
- pending and past-expiry approvals;
- approval-notification work;
- overdue reservations; and
- transaction/admin audit chain-head sequences.

The access section presents:

- human-readable organization name when enrolled;
- administrator display name and email when enrolled;
- exact role and permission state; and
- stable technical IDs as secondary support/audit details.

JWT issuer/subject and identity-provider display claims are not presented as Mino profile authority.

### Agents

With `agent.read`, operators can inspect machine identities.

Additional controls are permission-specific:

- `agent.create` — enroll an Ed25519 agent identity;
- `agent.suspend` — suspend an active agent;
- `agent.reactivate` — reactivate a suspended agent;
- `agent.rotate_key` — rotate Ed25519 verification material.

Agent enrollment/lifecycle management alone does not grant spending authority.

Agent key rotation currently remains a direct RBAC-authorized security action. The bounded four-eyes workflow does not apply to every administrative mutation.

### Policies

With `policy.read`, operators can inspect versioned policy configuration.

The console exposes backend operations for:

- initial inactive policy creation (`policy.create`);
- explicit next-version creation (`policy.create`);
- governed version-local activation (`policy.activate`); and
- direct version-local deactivation (`policy.deactivate`).

Policy activation no longer mutates immediately. The console creates a durable high-risk governance proposal. A distinct currently authorized administrator must approve it, and an authorized administrator must explicitly apply it after Mino revalidates the exact target state and current authority.

Policy deactivation deliberately remains direct RBAC so authority can be removed without waiting for a second administrator.

Monetary policy inputs remain exact minor-unit strings in this baseline. Human currency entry is a later pilot-readiness slice; the browser does not reinterpret policy semantics or silently rewrite historical versions.

### Merchants

With `merchant.read`, operators can inspect registered merchant endpoints.

`merchant.manage` adds:

- inactive merchant registration;
- configuration maintenance while inactive;
- activation; and
- deactivation.

The console never receives merchant credentials. Configuration uses the existing canonical HTTPS/domain validation boundary. Merchant administration remains outside the bounded four-eyes actions selected for PR #39.

### Mandates

With `mandate.read`, operators can inspect delegated authority.

`mandate.issue` now creates a **governance proposal**, not an active mandate. The proposal binds the intended beneficiary user, active keyed agent, exact active policy snapshot, expiry, organization, and idempotency semantics.

A distinct currently authorized administrator must approve the proposal. Approval alone still does not create authority. During explicit apply, Mino revalidates the proposer, distinct approver, applying administrator, current target state, and exact proposal binding.

Only after that apply succeeds does Mino mint the signed mandate token. The raw token is displayed once, is not persisted in governance/audit state, and is removed from the DOM when the one-time dialog closes.

`mandate.revoke` remains direct RBAC and immediately removes the mandate from subsequent transaction-path resolution even while an old bearer token remains cryptographically valid.

The current pilot console still asks for a beneficiary user UUID because beneficiary administration has not yet been productized. That is the next planned pilot-readiness gap, not a permanent intended UX.

### Governance

With `governance.read`, operators can inspect the durable high-risk administrative queue.

The implemented statuses are:

- `PENDING`;
- `APPROVED`;
- `REJECTED`;
- `EXPIRED`;
- `APPLIED`; and
- `STALE`.

For the bounded actions (`policy.activate` and `mandate.issue`):

- the proposer cannot approve their own request;
- the approver must currently hold the request-bound underlying permission;
- approval is bound to the exact proposal and precondition digest;
- changed target or governing authority produces `STALE` rather than silently reusing old approval;
- explicit apply revalidates current authority and state before mutation; and
- the eventual mutation and signed governance/audit evidence commit atomically.

This administrative governance domain remains separate from transaction-level human spend approvals.

### Transaction approvals

With `approval.read`, operators can inspect and filter durable human transaction approvals.

`approval.vote` uses the existing transaction approval state machine and stable Mino administrative principal identity. The console does not implement voter counting, terminal-state logic, expiry, or transaction revalidation itself.

A transaction approval is not payment authorization. The agent must retry the exact transaction through normal merchant-authoritative authorization before payment can proceed.

### Payments

With `payment.read`, operators can inspect durable payment outcomes and reconciliation state.

The console intentionally provides no payment mutation controls. There is no UI or API path for:

- force success;
- force failure;
- manual reservation release/commit;
- reconciliation completion by assertion;
- lease clearing; or
- merchant-evidence substitution.

Uncertain payments remain governed by the existing provider/merchant-authoritative reconciliation machinery.

### Audit and operations

With `audit.read`, operators can inspect:

- transaction audit history;
- administrative audit history;
- durable recovery/worker signals; and
- stored chain-head state.

With `audit.verify`, the console can invoke the cryptographic database-chain verifiers and can accept a pasted independently retained signed checkpoint for retained-proof verification.

Verification remains observational. The console cannot repair, rewrite, truncate, rewind, or replace either audit chain.

## Pilot boundary

The console is now suitable for a concierge design-partner pilot, not yet for anonymous/self-service signup.

The remaining onboarding friction is explicit:

- organization/bootstrap provisioning is operator-assisted;
- administrators still connect with an externally issued JWT and organization UUID;
- beneficiary users are not yet manageable through the console;
- policy monetary entry still uses exact minor units;
- provider onboarding is not yet a generic customer self-service flow.

Those limitations are product/readiness work, not hidden authorization bypasses.

## Secret and authority non-claims

The console does not receive or expose:

- Mino mandate-signing private keys;
- payment-delegation private keys;
- audit-signing private keys;
- merchant/provider credentials;
- retention HMAC secrets;
- approval webhook secrets;
- metrics credentials;
- raw persisted request payloads hidden by administrative safe projections; or
- any browser-only permission capable of overriding backend authorization.

The web application has no authority beyond the same backend APIs available to other administrative clients.

## Verification expectations

The permanent verification gate must continue to prove the complete backend suite and container authority split. Console-specific tests additionally verify:

- hardened no-store/security headers;
- same-origin first-party asset serving;
- absence of inline executable script in the HTML shell;
- absence of browser credential persistence APIs;
- human-readable access presentation without removing stable IDs;
- use of the existing administrative/governance endpoints rather than invented payment/audit mutation routes; and
- explicit representation of the implemented four-eyes boundary and the administrative actions that intentionally remain direct RBAC.
