# Administrative HTTP authentication

Mino's administrative HTTP boundary is intentionally separate from both agent authentication and the durable administrative RBAC model.

## Trust chain

A request to an administrative route must pass two independent gates:

```text
Bearer JWT
   ↓ cryptographic verification
trusted issuer + key + algorithm + audience + subject + time claims
   ↓ stable (issuer, subject)
AdminPrincipal / organization membership
   ↓ deterministic RBAC
required narrow permission
   ↓
route handler
```

A valid identity-provider JWT is **not** sufficient by itself to administer Mino. The verified `(issuer, subject)` must also be enrolled as an active `AdminPrincipal`, have an active membership in the exact target organization, and receive the route's required permission through the built-in role catalog.

## Trusted issuer configuration

Administrative routes are not registered unless `MINO_ADMIN_JWT_ISSUERS_JSON` contains at least one trusted issuer. An empty or absent value disables the administrative HTTP surface.

The configuration is server-controlled public verification material, not a bearer secret. It has this shape:

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

Issuer URLs must be canonical HTTPS URLs without embedded credentials, query strings, or fragments. Mino compares the JWT `iss` claim exactly against the configured issuer string.

Supported key/algorithm bindings are deliberately narrow:

- RSA public key → `RS256`
- P-256 EC public key → `ES256`
- Ed25519 public key → `EdDSA`

The JWT `kid` must select a pinned key for that issuer, and the token's `alg` must exactly match the algorithm implied by that key type. `none`, HMAC algorithms, RSA-PSS algorithms, other EC curves, and algorithm/key confusion are rejected.

## Claims and time validation

Mino requires:

- `iss` — exact trusted issuer
- `aud` — either the exact configured audience or an array containing it
- `sub` — non-empty stable external subject
- `exp` — required NumericDate
- `kid` and `alg` in the JOSE header

`nbf` and `iat` are optional, but are validated when present. The production verifier allows a 60-second clock-skew window by default. Tokens that are expired, not yet valid, or materially issued in the future fail authentication.

Mino returns only the stable issuer/subject pair from JWT authentication. It does not persist the raw bearer token or treat email/display-name claims as authority.

## HTTP semantics

The first authenticated administrative route is:

```text
GET /v1/admin/organizations/:organizationId/access
```

It requires `organization.read` and returns only the caller's enrolled organization-local principal ID, membership ID, roles, and effective Mino permissions.

Authentication and authorization failures are intentionally coarse:

- malformed/missing/invalid bearer token → `401 {"error":"unauthorized"}` with a Bearer challenge
- valid bearer identity without required Mino tenant permission → `403 {"error":"forbidden"}`

Internal RBAC denial reasons such as missing membership, suspended principal, or missing permission are not reflected back to unauthenticated callers.

## Deliberate non-claims

This slice does **not** implement:

- browser login/session management
- OIDC authorization-code or PKCE flows
- live OIDC discovery
- remote JWKS retrieval or automatic key refresh
- SCIM provisioning
- generic customer-authored ABAC
- administrative mutation endpoints
- replay-resistant sender-constrained access tokens such as DPoP/mTLS

Pinned keys can be rotated operationally by supplying the old and new public keys simultaneously during the issuer's overlap window, then removing the retired key after its accepted tokens have expired.

The read-only access endpoint is deliberately the first HTTP consumer of the #17 authorization substrate. Mutation APIs should be added only after this authentication boundary remains green under production composition and integration testing.
