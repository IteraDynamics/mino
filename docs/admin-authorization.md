# Administrative identity and authorization

Mino's administrative control plane is intentionally separate from the agent spending-authorization path.

## Identity separation

`User` represents the human or business beneficiary on whose behalf an agent may receive spending authority. It is not an administrative credential.

`AdminPrincipal` represents an externally authenticated human administrative identity. Principals are keyed by the stable `(issuer, subject)` identity tuple. Email and display name are presentation metadata only and are never sufficient to establish administrative authority.

The administrative HTTP boundary cryptographically verifies a pinned-issuer JWT before this authorization layer receives the stable issuer/subject pair. JWT email/display-name claims are not treated as enrolled Mino profile data or authority.

## Organization membership

Administrative authority is tenant-local. An `AdminPrincipal` must have an `ACTIVE` `AdminOrganizationMembership` in the exact target organization before role permissions are considered.

Authorization fails closed when:

- the external identity is not enrolled;
- the principal is suspended or disabled;
- the target-organization membership is missing;
- the membership is suspended or removed;
- the returned membership belongs to a different organization; or
- assigned roles do not grant the requested permission.

A membership from one organization is never substituted for another.

## Built-in roles

The built-in role catalog is deliberately small and deterministic:

- `ORGANIZATION_OWNER`;
- `SECURITY_ADMIN`;
- `FINANCE_MANAGER`;
- `AGENT_MANAGER`;
- `APPROVER`; and
- `AUDITOR`.

The database stores role assignments. It does **not** store mutable role-to-permission definitions. Role meaning is versioned with Mino code, reviewed like other security logic, and covered by tests.

`FINANCE_MANAGER` deliberately does not include `approval.vote`; policy/budget administration does not implicitly grant transaction-level human approval authority. `APPROVER` can vote on transaction approvals but does not thereby gain `policy.activate` or `mandate.issue`.

## Permissions

Administrative endpoints authorize named actions such as:

```text
agent.create
agent.rotate_key
policy.activate
mandate.issue
mandate.revoke
governance.read
approval.vote
audit.verify
role.assign
```

Route handlers must not branch directly on role names. They request the narrow permission required for the operation and use the centralized `AdminAuthorizer` decision.

## Presentation metadata is not authority

After authorization succeeds, the `/access` surface may return enrolled organization name plus administrator display name/email for pilot usability. Stable organization, membership, and principal IDs remain the technical identity.

These human-readable fields do not affect permission resolution. Changing a display name or email must not change what an administrator can do.

## Bounded four-eyes governance

PR #39 implements a durable separation-of-duties layer above RBAC for exactly two authority-creating/enabling actions in the current production composition:

- `policy.activate`;
- `mandate.issue`.

The flow is:

```text
verified external human identity
        ↓
active organization membership
        ↓
role grants requested action
        ↓
durable exact-mutation proposal
        ↓
distinct currently authorized administrator approval
        ↓
explicit apply
        ↓
revalidate proposer + approver + applying admin + target state
        ↓
atomic mutation + signed administrative evidence
```

The proposer cannot approve their own request. Approval is bound to the exact proposal and target/precondition digest. If relevant target state or administrative authority changes before apply, the request becomes `STALE` rather than silently applying old approval to new circumstances.

`governance.read` provides visibility into the queue but does not itself grant the underlying mutation permission.

## Authority-removing actions remain direct

The four-eyes layer is intentionally bounded rather than universal.

Authority-removing operations such as `mandate.revoke` and `policy.deactivate` remain direct RBAC actions so an authorized administrator can fail closed immediately without waiting for a second human.

Other administrative mutations also remain direct unless explicitly brought under a future governed action by design.

## Transaction approval remains separate

Administrative high-risk governance is not the same trust domain as transaction-level human spend approval.

`approval.vote` participates in the durable transaction approval state machine. It cannot activate a policy, issue a mandate, force a payment outcome, or replace the explicit administrative governance flow.

Likewise, an approved administrative change cannot make a transaction successful by assertion. Economic execution still passes through mandate resolution, policy evaluation, provider binding, reservation, payment outcome, and reconciliation controls.

## Bounded scopes later

Mino still does not introduce a general-purpose customer-authored ABAC expression language or arbitrary JSON authorization conditions.

Future enterprise requirements may add explicit resource scopes such as agent group, cost center, business unit, or policy family. Those scopes should be typed Mino concepts applied after role permission resolution and before operation-specific governance, not customer-authored boolean programs.

The intended evaluation shape is:

```text
external human identity
        ↓
active organization membership
        ↓
role grants requested action
        ↓
optional bounded resource scope
        ↓
operation-specific governance where required
        ↓
ALLOW or DENY
```
