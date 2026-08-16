# Administrative policy management

PR #24 extends Mino's administrative control plane from read-only policy inventory to governed policy creation, versioning, and activation lifecycle management.

## HTTP surface

```text
GET  /v1/admin/organizations/:organizationId/policies/:policyId
POST /v1/admin/organizations/:organizationId/policies
POST /v1/admin/organizations/:organizationId/policies/:policyId/versions
POST /v1/admin/organizations/:organizationId/policies/:policyId/activate
POST /v1/admin/organizations/:organizationId/policies/:policyId/deactivate
```

The routes exist only when the administrative JWT boundary is configured. Every route first verifies the pinned-issuer bearer token and then authorizes the exact organization named by the route.

Permissions remain narrow:

- detail: `policy.read`
- initial policy/version creation: `policy.create`
- activation: `policy.activate`
- deactivation: `policy.deactivate`

Route code authorizes permissions, not role names.

## Version model

Mino does not mutate the economic meaning of an existing policy version in place.

An initial `POST /policies` creates version `1`. A later `POST /policies/:policyId/versions` creates the explicit next integer version of the same policy name. The source policy must still be the latest version when the new version is first created, preventing accidental branching of one policy lineage.

Every newly created version starts with:

```text
active = false
```

Creation therefore does not imply activation. `policy.create` and `policy.activate` remain distinct authorities even when a built-in role happens to grant both permissions.

Version creation is retry-safe:

- the same source, next version, and normalized configuration -> `REPLAYED`, with no second administrative audit event;
- reuse of that version with materially different configuration -> conflict;
- trying to skip a version or create from a stale branch point -> conflict.

## Activation semantics

Activation is version-local.

Activating version 2 does **not** silently deactivate version 1. This matters because existing mandates are durably bound to a specific policy row and policy version. Automatically turning off an older version when a newer version becomes available would implicitly revoke unrelated existing authority.

Multiple policy versions may therefore remain active at the same time. A later mandate-management API can explicitly choose an active version when granting authority.

Deactivation is explicit and fail-closed. The existing production `PrismaMandateRepository` already requires the exact referenced policy row to remain active and to match the mandate's snapshotted `policyVersion`. Consequently:

- creating a newer version does not change an existing mandate;
- activating a newer version does not change an existing mandate;
- explicitly deactivating the exact older policy version makes mandates bound to that version stop resolving for new requests immediately.

Reactivation is simply an explicit `policy.activate` operation on that same version; there is no hidden "current policy" pointer.

## Configuration validation and canonicalization

Policy configuration is validated before persistence.

The administrative surface currently accepts the currencies already supported by Mino's deterministic policy evaluator:

```text
BHD EUR GBP JPY KWD USD
```

Monetary limits cross the API as decimal integer strings and are validated against PostgreSQL signed `BIGINT` range. They are never converted through JavaScript `number`, so values above `Number.MAX_SAFE_INTEGER` remain lossless.

The service also normalizes configuration whose order or spelling is not semantically meaningful:

- currency is uppercase;
- merchant domains are canonical lower-case ASCII hostnames without a trailing dot;
- merchant domains, vendor IDs, and restricted categories are deduplicated and sorted;
- restricted categories are normalized to the same uppercase/underscore form used by policy evaluation;
- velocity and cross-merchant controls are bounded integers.

Malformed domains, unsupported currencies, negative/overflow monetary values, control characters, unbounded lists, and invalid control ranges fail before persistence.

## Atomic signed audit

Every actual mutation uses one PostgreSQL transaction for policy state and the signed administrative change receipt.

```text
BEGIN
  lock organization/policy state
  INSERT or UPDATE Policy
  append signed AdminAuditLog receipt
COMMIT
```

The initial create and version-create path serializes through the organization row so competing writers cannot manufacture two different "next" versions of the same policy lineage.

Administrative audit actions are distinct:

```text
policy.create
policy.version.create
policy.activate
policy.deactivate
```

Receipts contain safe normalized policy configuration, including exact decimal monetary strings. No runtime credential, bearer token, signing private key, or merchant secret is part of the policy surface.

## Economic-authority boundary

Policy management defines reusable governance configuration. It does **not** grant an agent spending authority.

A policy row does not bind a user to an agent, does not create a signed mandate token, does not reserve allowance, and cannot dispatch a payment. Economic authority remains represented by an `AgentMandate`; administrative issuance and revocation of that authority is intentionally deferred to PR #26.

This keeps the planned configuration sequence explicit:

```text
agent identity
  -> policy configuration
  -> merchant configuration
  -> mandate authority
```

## Verification coverage

The PR verifies the boundary at three levels:

- route tests prove narrow permission selection, strict request validation, no-store responses, and no persistence after authorization denial;
- real PostgreSQL tests prove inactive draft creation, lossless/canonical configuration, exact-retry replay, changed-reuse conflict, serialized competing version creation, explicit activation/deactivation, and valid signed administrative audit chains;
- production HTTP integration uses a real signed RSA admin JWT, real PostgreSQL RBAC, the real administrative audit ledger, the production policy repository, and the existing production mandate resolver to prove version-local activation and immediate fail-closed deactivation.

No database migration is required for PR #24; the existing versioned `Policy` schema already carries the required state.