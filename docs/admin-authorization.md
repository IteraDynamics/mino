# Administrative identity and authorization

Mino's administrative control plane is intentionally separate from the agent spending-authorization path.

## Identity separation

`User` represents the human or business user on whose behalf an agent may receive spending authority. It is not an administrative credential.

`AdminPrincipal` represents an externally authenticated human administrative identity. Principals are keyed by the stable `(issuer, subject)` identity tuple. Email and display name are metadata only and are never sufficient to establish administrative authority.

This slice does not expose customer-facing admin mutation routes and does not itself verify an OIDC/JWT bearer token. Future HTTP authentication must cryptographically establish the issuer/subject pair before invoking this authorization layer.

## Organization membership

Administrative authority is tenant-local. An `AdminPrincipal` must have an `ACTIVE` `AdminOrganizationMembership` in the exact target organization before role permissions are considered.

Authorization fails closed when:

- the external identity is not enrolled
- the principal is suspended or disabled
- the target-organization membership is missing
- the membership is suspended or removed
- the returned membership belongs to a different organization
- assigned roles do not grant the requested permission

A membership from one organization is never substituted for another.

## Built-in roles

The first role catalog is deliberately small and deterministic:

- `ORGANIZATION_OWNER`
- `SECURITY_ADMIN`
- `FINANCE_MANAGER`
- `AGENT_MANAGER`
- `APPROVER`
- `AUDITOR`

The database stores role assignments. It does **not** store mutable role-to-permission definitions. Role meaning is versioned with Mino code, reviewed like other security logic, and covered by unit tests.

`FINANCE_MANAGER` deliberately does not include `approval.vote`; policy/budget administration does not implicitly grant human approval authority. `APPROVER` can vote but cannot activate policy or issue a mandate merely because it can approve a transaction exception.

## Permissions

Administrative endpoints should authorize named actions such as:

```text
agent.create
agent.rotate_key
policy.activate
mandate.issue
mandate.revoke
approval.vote
audit.verify
role.assign
```

Route handlers must not branch directly on role names. They should request the narrow permission required for the operation and use the centralized `AdminAuthorizer` decision.

## RBAC now, bounded scopes later

This slice is organization-scoped RBAC. It does not introduce a general-purpose ABAC expression language or arbitrary JSON authorization conditions.

Future enterprise requirements may add bounded resource scopes such as agent group, cost center, business unit, or policy family. Those scopes should be explicit Mino concepts applied after role permission resolution, not customer-authored boolean programs.

The intended long-term evaluation order is:

```text
external human identity
        ↓
active organization membership
        ↓
role grants requested action
        ↓
optional bounded resource scope
        ↓
operation-specific governance / separation of duties
        ↓
ALLOW or DENY
```

## Separation of duties

Possessing a permission is not intended to become the final word for every high-risk administrative transition. Later slices may require a second authorized human for changes that materially broaden autonomous purchasing authority, for example:

- large budget increases
- broadening merchant/vendor scope
- weakening an approval requirement
- activating a high-risk policy
- issuing a materially broader mandate
- changing organization-owner or security-administrator assignments

Those governance rules belong above this deterministic role/permission substrate and should remain explicit and auditable.
