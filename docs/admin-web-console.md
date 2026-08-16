# First administrative web console

Mino's first web console is a thin same-origin operator interface over the governed administrative APIs implemented before it. It is intentionally not a second control plane: authentication, organization-local authorization, validation, durable state transitions, signed administrative audit, transaction authorization, merchant-authoritative payment handling, approval semantics, and reconciliation remain backend responsibilities.

## Availability

The console is served by the existing Fastify runtime at:

```text
GET /console
GET /console/
GET /console/styles.css
GET /console/app.js
```

The console routes are registered only when the trusted administrative JWT boundary is configured. If administrative HTTP access is disabled, Mino does not expose the console shell either.

No separate frontend service, deployment, CORS origin, JavaScript dependency graph, or frontend build pipeline is introduced by this first release.

## Authentication model

Mino currently verifies administrator JWTs issued by externally configured trusted issuers. It does not yet own an OAuth/OIDC browser login client or an administrative browser-session service.

PR #30 therefore does not create a parallel identity/session authority merely for UI convenience.

The operator connects with:

- the target organization UUID; and
- an existing signed administrator bearer JWT.

The browser then calls:

```text
GET /v1/admin/organizations/:organizationId/access
```

using that bearer token. A successful response supplies the organization-local principal, membership, roles, and exact permission set used to render the console.

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

A production deployment can later add an explicit OIDC/OAuth browser flow as a separately governed authentication slice. That should reuse the existing pinned issuer/subject identity model rather than weakening it.

## Browser security boundary

The console uses only first-party HTML, CSS, and JavaScript served by Mino. It loads no CDN scripts, external fonts, tracking pixels, analytics libraries, or remote images.

Every console asset is served with:

- `Cache-Control: no-store, max-age=0`;
- `Content-Security-Policy` with `default-src 'none'` and only same-origin script/style/connect authority;
- `frame-ancestors 'none'` plus `X-Frame-Options: DENY`;
- `Referrer-Policy: no-referrer`;
- `X-Content-Type-Options: nosniff`;
- same-origin opener/resource policy; and
- a restrictive browser permissions policy.

Dynamic API values are written into DOM text nodes. The console does not turn server-returned names, IDs, comments, domains, or audit values into executable HTML.

## Permission-aware product surface

The console derives usability state from the exact permissions returned by `/access`.

Navigation sections are hidden when their read permission is absent. Mutation controls are shown only when the corresponding narrow permission is present. This is a usability layer only; every API call still passes through backend JWT verification and organization-local authorization.

### Overview

When `audit.read` is available, the landing view shows durable operational signals including:

- unresolved and claimable payment outcomes;
- stale/high-attempt reconciliation state;
- pending and past-expiry approvals;
- approval-notification work;
- overdue reservations; and
- transaction/admin audit chain-head sequences.

The view also shows the current principal, membership, roles, and permission count.

### Agents

With `agent.read`, operators can inspect machine identities.

Additional controls are permission-specific:

- `agent.create` — enroll an Ed25519 agent identity;
- `agent.suspend` — suspend an active agent;
- `agent.reactivate` — reactivate a suspended agent;
- `agent.rotate_key` — rotate Ed25519 verification material.

The UI never treats enrollment or lifecycle management as spending authority.

### Policies

With `policy.read`, operators can inspect versioned policy configuration.

The console exposes existing backend operations for:

- initial inactive policy creation (`policy.create`);
- explicit next-version creation (`policy.create`);
- version-local activation (`policy.activate`); and
- version-local deactivation (`policy.deactivate`).

Monetary inputs remain decimal minor-unit strings and are sent to the existing backend validator. The browser does not reinterpret policy semantics or silently rewrite previous versions.

### Merchants

With `merchant.read`, operators can inspect registered merchant endpoints.

`merchant.manage` adds:

- inactive merchant registration;
- configuration maintenance while inactive;
- activation; and
- deactivation.

The console never receives merchant credentials. Configuration uses the existing canonical HTTPS/domain validation boundary. Active endpoints cannot be silently repointed from the browser because the backend continues to require inactive maintenance state.

### Mandates

With `mandate.read`, operators can inspect delegated authority.

`mandate.issue` exposes issuance against a beneficiary user UUID, an active agent, an active exact policy version, and an explicit expiry. The form generates a cryptographically random administrative idempotency key once per open issuance attempt and reuses that key if a network failure leaves the outcome uncertain.

On a successful new issuance, the raw signed mandate token is displayed in a dedicated one-time dialog. The token is not added to console state, inventory, logs, browser storage, or later detail views. Closing the dialog removes it from the DOM. Copying it to the operating-system clipboard is an explicit operator action.

`mandate.revoke` uses the existing durable revocation path and therefore immediately removes authority from subsequent transaction-path resolution.

### Approvals

With `approval.read`, operators can inspect and filter durable human transaction approvals.

`approval.vote` adds approve/reject actions using the same backend approval state machine and stable Mino administrative principal identity already established by PR #28. The console does not implement signature counting, terminal-state logic, expiry, or revalidation itself.

An approval remains only approval state. The agent must retry the exact transaction through normal merchant-authoritative authorization before a payment can proceed.

### Payments

With `payment.read`, operators can inspect and filter durable payment outcomes and reconciliation state.

The console intentionally provides no payment mutation controls. There is no UI or API path for:

- force success;
- force failure;
- manual reservation release/commit;
- reconciliation completion by assertion;
- lease clearing; or
- merchant-evidence substitution.

Uncertain payments remain governed by the existing merchant-authoritative reconciliation machinery.

### Audit and operations

With `audit.read`, operators can inspect:

- transaction audit history;
- administrative audit history;
- durable recovery/worker signals; and
- stored chain-head state.

With `audit.verify`, the console can explicitly invoke the existing cryptographic database-chain verifiers and can accept a pasted independently retained signed checkpoint for retained-proof verification.

The retained checkpoint is held only in the open dialog and sent to the existing verifier. Mino still does not gain a read credential into the independent retention trust domain.

Verification remains observational. The console cannot repair, rewrite, truncate, rewind, or replace either audit chain.

## High-risk administrative governance remains deferred

The roadmap originally placed a bounded four-eyes administrative governance layer before the console. That slice was deliberately deferred and remains unimplemented.

The first console therefore displays a persistent **Direct RBAC mode** notice and labels sensitive direct actions such as policy activation, merchant activation, agent key rotation, mandate issuance, and mandate revocation accordingly.

The UI does not claim that these operations are multi-human approved simply because they now have buttons.

When a durable four-eyes layer is implemented later, the console should consume those backend change-request/approval APIs rather than implementing proposer/approver logic in browser code.

## Secret and authority non-claims

The console does not receive or expose:

- Mino mandate-signing private keys;
- payment-delegation private keys;
- audit-signing private keys;
- merchant credentials;
- retention HMAC secrets;
- approval webhook secrets;
- metrics credentials;
- raw persisted request payloads hidden by the administrative safe projections; or
- any browser-only permission capable of overriding backend authorization.

The console also adds no database migration, runtime secret, migration-container authority, or network dependency.

## Verification expectations

The permanent verification gate must continue to prove the complete backend suite and container authority split. Console-specific tests additionally verify:

- hardened no-store/security headers;
- same-origin first-party asset serving;
- absence of inline executable script in the HTML shell;
- absence of browser credential persistence APIs;
- use of the existing administrative endpoints rather than invented payment/audit mutation routes; and
- explicit representation of the deferred four-eyes governance boundary.
