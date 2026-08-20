# Administrative HTTP authentication

Mino's administrative HTTP boundary is intentionally separate from both agent authentication and delegated spending authority.

## Trust chain

Every administrative request passes two independent gates:

```text
Bearer JWT
   ↓ cryptographic verification
trusted issuer + pinned key + algorithm + audience + subject + time claims
   ↓ stable (issuer, subject)
AdminPrincipal / organization membership
   ↓ deterministic organization-local RBAC
required narrow permission
   ↓
route handler
```

A valid identity-provider JWT is **not** sufficient by itself to administer Mino. The verified `(issuer, subject)` must resolve to an active `AdminPrincipal`, an active membership in the exact target organization, and a role set that grants the route's narrow permission.

Email, display name, and organization name are presentation metadata only. They do not participate in authorization decisions and are never accepted from JWT claims as Mino authority.

## Trusted issuer configuration

Administrative routes are not registered unless `MINO_ADMIN_JWT_ISSUERS_JSON` contains at least one trusted issuer. An empty or absent value disables the administrative HTTP surface and the administrative web console.

The configuration contains server-controlled public verification material, not bearer secrets. It has this shape:

```json
{
  "https://login.example.com/": {
    "audience": "mino-admin",
    "keys": {
      "key-2026-08": "<base64-encoded public PEM>"
    }
  }
}
```

Issuer identifiers must be HTTPS URLs without embedded credentials, query strings, or fragments. Mino does not rewrite the configured issuer identifier: the JWT `iss` claim must exactly match the trusted string.

Supported key/algorithm bindings are deliberately narrow:

- RSA public key → `RS256`
- P-256 EC public key → `ES256`
- Ed25519 public key → `EdDSA`

The JWT `kid` must select a pinned key for that issuer, and `alg` must exactly match the algorithm implied by that key type. `none`, HMAC algorithms, RSA-PSS algorithms, other EC curves, and algorithm/key confusion are rejected.

## Claims and time validation

Mino requires:

- `iss` — exact trusted issuer
- `aud` — exact configured audience, or an array containing it
- `sub` — non-empty stable external subject
- `exp` — required NumericDate
- `kid` and `alg` in the JOSE header

`nbf` and `iat` are optional but validated when present. The production verifier allows a bounded clock-skew window. Tokens that are expired, not yet valid, or materially issued in the future fail authentication.

The authenticator returns only the stable issuer/subject identity. Mino does not persist the raw bearer token and does not trust email/display-name JWT claims as enrolled metadata.

## Access context

The administrative console establishes organization-local context with:

```text
GET /v1/admin/organizations/:organizationId/access
```

The route requires `organization.read`. After authentication and RBAC succeed, it returns the stable technical identifiers and exact effective roles/permissions plus safe human-readable metadata from Mino's enrolled records:

```json
{
  "principalId": "<uuid>",
  "membershipId": "<uuid>",
  "organizationId": "<uuid>",
  "organization": {
    "id": "<uuid>",
    "name": "Northstar Operations"
  },
  "principal": {
    "id": "<uuid>",
    "displayName": "Alice Admin",
    "email": "alice@example.com"
  },
  "roles": ["FINANCE_MANAGER"],
  "permissions": ["organization.read", "policy.read", "policy.activate"]
}
```

`organization.name`, `principal.displayName`, and `principal.email` are presentation-only and may be omitted when the corresponding enrolled metadata is absent. Stable IDs remain present for support, audit, and API interoperability. The response never returns the external JWT subject, issuer configuration, bearer token, private keys, or signing material.

Authentication and authorization failures remain intentionally coarse:

- malformed/missing/invalid bearer token → `401 {"error":"unauthorized"}` with a Bearer challenge
- valid bearer identity without required organization-local Mino permission → `403 {"error":"forbidden"}`

Internal RBAC denial reasons such as missing membership, suspended principal, or missing permission are not reflected back to callers.

## Current administrative boundary

The same JWT/RBAC boundary protects the implemented administrative surfaces for agent lifecycle, policy management, merchant administration, mandate management, high-risk administrative governance, transaction approvals, payment visibility, audit verification, and operational visibility.

High-risk authority-creating/enabling actions are not authenticated through a separate identity path. `mandate.issue` and `policy.activate` reuse this boundary and then enter the durable four-eyes governance layer implemented by PR #39. The proposer, distinct approver, and applying administrator are revalidated against current Mino authority before the approved mutation can commit.

## Deliberate non-claims

Mino still does **not** implement:

- a first-party browser login/session service;
- OIDC authorization-code or PKCE browser flows;
- live OIDC discovery;
- remote JWKS retrieval or automatic key refresh;
- SCIM provisioning;
- generic customer-authored ABAC;
- replay-resistant sender-constrained administrator access tokens such as DPoP/mTLS.

For the first design-partner pilots, organization/bootstrap provisioning and administrator-token issuance remain concierge operational steps. A later browser-login slice should reuse the same pinned issuer/subject and organization-local RBAC model rather than creating a parallel authority system.
