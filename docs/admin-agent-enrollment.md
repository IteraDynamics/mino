# Administrative agent enrollment

Mino's first administrative mutation is agent enrollment. It establishes a cryptographic machine identity inside one organization; it does **not** create a spend mandate, attach a policy, or grant payment authority.

## Authorization boundary

`POST /v1/admin/organizations/:organizationId/agents` is registered only when the administrative JWT boundary is enabled. The caller must pass the same pinned-issuer JWT authentication used by the administrative read surface and must hold `agent.create` in the exact organization named by the route.

## Enrollment contract

The request supplies:

- `externalAgentId`
- optional `displayName`
- `keyId`
- Ed25519 public key PEM

Only Ed25519 public keys are accepted. Mino canonicalizes the key to SPKI PEM before comparison/storage and returns only a SHA-256 public-key fingerprint in the response/audit snapshot.

The organization row is locked while enrollment is evaluated. `externalAgentId` is the natural retry identity:

- no existing row -> create the ACTIVE agent and one signed administrative audit receipt (`201`)
- existing ACTIVE row with exactly equivalent normalized enrollment data -> safe replay with no second audit receipt (`200`)
- same external ID with changed key/display/status data -> conflict (`409`)

## Atomic audit invariant

Creation uses one PostgreSQL transaction and one connection:

```text
BEGIN
  lock organization
  insert AgentIdentity
  append signed AdminAuditLog receipt
COMMIT
```

If the mutation or audit append fails, the caller rolls the transaction back. The audit receipt records `agent.create`, actor principal/membership/roles, resource ID, request digest, and a sanitized after-state containing the key fingerprint rather than the public key body.

## Spending non-authority

Enrollment alone grants no commerce authority. An enrolled agent still cannot successfully exercise Mino's payment path without a separate valid server-side mandate/policy assignment and signed mandate token.

## Verification

The permanent gate exercises the production JWT -> organization RBAC -> HTTP enrollment -> PostgreSQL -> signed admin-audit path, plus exact replay, conflict, cross-tenant denial, and concurrent enrollment behavior. The admin audit verifier confirms the resulting chain remains valid, and the full pre-existing payment/recovery/audit/container suite must remain green before merge.
