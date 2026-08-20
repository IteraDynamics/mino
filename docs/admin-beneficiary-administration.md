# Administrative beneficiary management

Mino distinguishes a **spending beneficiary** from an **administrator**.

A beneficiary is the `User` on whose behalf an agent may receive delegated economic authority. An administrator is an `AdminPrincipal` authenticated through the separate pinned-issuer administrative JWT and organization-local RBAC boundary. Creating one does not create the other.

## Pilot purpose

Before this slice, mandate issuance required an already-existing beneficiary UUID, which meant pilot setup depended on out-of-band database provisioning. PR #41 makes the beneficiary a first-class administrative resource while preserving the existing mandate and authorization semantics.

The supported pilot workflow is:

```text
create beneficiary
      ↓
beneficiary is ACTIVE
      ↓
select beneficiary when proposing mandate issuance
      ↓
normal four-eyes mandate governance
      ↓
mandate may be used only while beneficiary remains ACTIVE
```

## HTTP surface

```text
GET  /v1/admin/organizations/:organizationId/beneficiaries
GET  /v1/admin/organizations/:organizationId/beneficiaries/:beneficiaryId
POST /v1/admin/organizations/:organizationId/beneficiaries
POST /v1/admin/organizations/:organizationId/beneficiaries/:beneficiaryId/suspend
```

There is intentionally no beneficiary-reactivation endpoint in this pilot slice.

## Permissions

The administrative permission catalog adds:

- `beneficiary.read` — organization-scoped beneficiary inventory/detail;
- `beneficiary.create` — create an active beneficiary;
- `beneficiary.suspend` — fail closed a beneficiary for subsequent mandate resolution.

`ORGANIZATION_OWNER` receives the complete permission catalog. `SECURITY_ADMIN` and `FINANCE_MANAGER` can read/create/suspend beneficiaries. `AGENT_MANAGER`, `APPROVER`, and `AUDITOR` receive beneficiary read visibility only.

Role meaning remains deterministic code-reviewed Mino configuration. The database still stores role assignments, not customer-authored role-to-permission programs.

## Creation semantics

Creation accepts an email address and normalizes it by trimming and lowercasing before persistence.

Within an organization, an equivalent retry against an already-active case-insensitive email returns the existing beneficiary as a replay and creates no duplicate signed administrative audit event.

If the same case-insensitive email resolves to a suspended/disabled beneficiary, or historical state is ambiguous, creation fails closed with a conflict rather than silently restoring authority eligibility.

Creation itself grants no spending authority. It does not create:

- an agent identity;
- a policy;
- a mandate;
- a payment credential;
- a provider account; or
- an administrative identity/membership.

## Suspension semantics

Suspension changes the durable `User.status` from `ACTIVE` to `SUSPENDED` and appends the signed administrative change receipt in the same PostgreSQL transaction.

The existing production `PrismaMandateRepository` already requires all of the following before it returns a mandate to the transaction path:

- mandate status is active;
- beneficiary `User.status` is active;
- agent status is active;
- the bound policy version is still active and matches the mandate snapshot.

Therefore beneficiary suspension takes effect at the same durable source used by actual agent authorization: an otherwise-valid existing mandate stops resolving for new requests immediately after suspension commits.

Suspension does not rewrite or delete the historical mandate. Audit, approval, payment-outcome, and reservation records keep their historical beneficiary references.

Equivalent suspension retries replay without manufacturing duplicate administrative audit history.

## Why reactivation is omitted

Reactivating a beneficiary could make still-valid historical mandates resolve again. That is authority-restoring behavior, not merely profile maintenance.

For the first design-partner pilot, Mino deliberately exposes the safe fail-closed direction only. A later reactivation design should explicitly decide whether restoring a beneficiary should also restore existing mandates or require newly governed delegated authority.

This avoids smuggling a new authority-enabling path into a usability PR.

## Console behavior

The console adds a **Beneficiaries** view showing email, status, and stable technical ID.

When proposing mandate issuance, the console now loads the safe beneficiary inventory and presents active beneficiaries by email instead of requiring the operator to paste a beneficiary UUID manually. The selected UUID remains the backend binding sent to the existing mandate-governance API.

The browser still has no independent authority: all beneficiary reads and mutations pass through the administrative JWT, exact organization-local permission checks, backend validation, durable mutation service, and signed administrative audit boundary.
