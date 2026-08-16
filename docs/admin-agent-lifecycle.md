# Administrative agent lifecycle

Mino's administrative control plane supports inspecting and controlling an enrolled agent's security lifecycle after enrollment.

## HTTP surface

```text
GET  /v1/admin/organizations/:organizationId/agents/:agentId
POST /v1/admin/organizations/:organizationId/agents/:agentId/suspend
POST /v1/admin/organizations/:organizationId/agents/:agentId/reactivate
POST /v1/admin/organizations/:organizationId/agents/:agentId/rotate-key
```

The routes exist only when the administrative JWT boundary is enabled and reuse the shared organization-local authorizer.

Permissions are deliberately narrow:

- detail: `agent.read`
- suspend: `agent.suspend`
- reactivate: `agent.reactivate`
- key rotation: `agent.rotate_key`

Reactivation is a distinct security permission rather than an alias for generic `agent.update`.

## State semantics

The supported reversible lifecycle is:

```text
ACTIVE <-> SUSPENDED
```

`REVOKED` is terminal. This slice does not expose agent revocation yet, but a persisted REVOKED identity cannot be suspended, reactivated, or key-rotated by these operations.

Repeated requests that already match the requested state are safe replays and do not append another administrative audit event.

## Immediate transaction-path enforcement

Mino does not implement a separate lifecycle cache or a second suspension policy. Existing transaction ingress already resolves both the server-side mandate and the agent verification key only for an `ACTIVE` `AgentIdentity`.

Consequently:

- once an agent is suspended, new mandate resolution and agent public-key resolution fail immediately;
- reactivation restores those existing resolution paths;
- after key rotation, the previous key ID stops resolving immediately and only the replacement key ID/key can authenticate new requests.

This keeps the administrative lifecycle and transaction authorization boundary tied to one durable source of truth.

## Atomic signed audit

Every actual status or key transition uses one PostgreSQL transaction for the governed mutation and signed administrative receipt:

```text
BEGIN
  SELECT AgentIdentity ... FOR UPDATE
  UPDATE AgentIdentity
  append signed AdminAuditLog receipt
COMMIT
```

The row lock serializes competing lifecycle transitions for the same agent. A failed mutation or audit append rolls back the whole transaction. Replay/no-op requests do not generate artificial audit history.

Audit before/after snapshots contain the agent key ID and SHA-256 public-key fingerprint, never the raw public key body.

## Verification coverage

The integration suite proves with real PostgreSQL/Prisma that:

- suspension immediately removes the current key from the production verification resolver;
- reactivation explicitly restores the active identity path;
- key rotation makes the old key ID unusable and the new key the only resolved key;
- idempotent lifecycle retries do not duplicate audit events;
- REVOKED remains terminal;
- the administrative audit chain remains valid; and
- the real production HTTP path works through signed JWT authentication, organization-local RBAC, audited lifecycle mutation, and the same key resolver consumed by agent request verification.

Enrollment and lifecycle management still do not themselves grant economic authority. Spending requires a separately governed mandate and policy.
