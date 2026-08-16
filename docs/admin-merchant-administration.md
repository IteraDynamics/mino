# Administrative merchant administration

PR #25 extends Mino's administrative control plane from read-only merchant inventory to governed merchant registration, routing maintenance, and activation lifecycle management.

## HTTP surface

```text
GET  /v1/admin/organizations/:organizationId/merchants/:merchantId
POST /v1/admin/organizations/:organizationId/merchants
POST /v1/admin/organizations/:organizationId/merchants/:merchantId/configuration
POST /v1/admin/organizations/:organizationId/merchants/:merchantId/activate
POST /v1/admin/organizations/:organizationId/merchants/:merchantId/deactivate
```

The routes exist only when the administrative JWT boundary is configured. Each request authenticates the pinned issuer first and then authorizes the exact organization named by the route.

Permissions remain narrow:

- detail: `merchant.read`
- registration, routing/configuration changes, activation, and deactivation: `merchant.manage`

Route handlers authorize permissions rather than role names.

## Merchant identity and lifecycle

`MerchantEndpoint.id` is the internal administrative resource identifier. `externalMerchantId` is the stable organization-local identifier used by agent-facing ACP routes and by the production merchant registry.

Registration creates a merchant with:

```text
active = false
```

Registration therefore cannot immediately place a new destination on the live transaction path. Activation is an explicit audited operation.

`externalMerchantId` cannot be changed after registration. A configuration update can change only:

- domain;
- optional vendor ID;
- HTTPS base URL/routing origin.

A materially changed configuration update is rejected while the merchant is active. The intended maintenance sequence is:

```text
deactivate
    -> update configuration
    -> activate
```

Equivalent create/configuration/lifecycle retries return `REPLAYED` and do not append duplicate administrative audit events. Reusing an existing external merchant ID with a different registration configuration conflicts.

## Routing boundary

Administrative routing input and the outbound merchant client use the same canonical validation rules.

A merchant route must:

- use an absolute `https:` URL;
- use a DNS hostname rather than a literal IP address;
- use a multi-label hostname rather than a single-label/private-style host;
- have a base-URL hostname that exactly matches the registered merchant domain after IDNA/case normalization;
- omit URL user information;
- omit query strings and fragments;
- identify an origin rather than carrying an ignored path prefix.

The canonical persisted base URL is the URL origin, including a non-default HTTPS port when configured. Default port `443`, case differences, and a trailing slash normalize away.

This validation prevents the administrative API from supplying a different forwarding host in the base URL than the registered merchant domain. It also makes invalid persisted routes fail closed at the outbound runtime boundary rather than trusting that all database rows were created through the admin API.

DNS resolution and network egress policy remain deployment-layer controls. Mino's application-level registry validation does not claim to make a compromised DNS or unrestricted production network harmless.

## Production authority

Administrative mutations write the existing `MerchantEndpoint` table. `PrismaMerchantRegistry`, which is already consumed by checkout, checkout lifecycle, and payment reconciliation code, reads those same rows.

Consequences are immediate for subsequent registry resolution:

- an inactive merchant is not a usable outbound merchant target;
- activation exposes the currently persisted canonical route to later requests;
- deactivation makes later requests fail closed;
- after inactive maintenance, reactivation exposes the changed domain/vendor/routing values without a second configuration store or cache to synchronize.

Merchant administration does not weaken the existing ACP stable-version pin, agent signature verification, mandate binding, merchant/vendor scope evaluation, spend reservation, human approval, delegation assertion, or merchant-authoritative payment outcome rules.

## Unresolved-payment safety

Payment reconciliation deliberately stores the merchant ID and merchant domain observed when payment dispatch began. The reconciler requires the current merchant registry entry to remain active and to match that recorded domain before querying merchant-authoritative state.

Therefore:

- deactivating a merchant causes unresolved payments for that merchant to defer rather than release allowance or invent an outcome;
- changing a merchant domain can cause older unresolved outcomes recorded under the prior domain to defer after reactivation;
- an administrator cannot use merchant administration to mark those payments successful, failed, or releasable by assertion.

Operators should clear or understand outstanding `FORWARDING`/`UNKNOWN` payment outcomes before intentionally repointing a merchant domain. If a prior-domain unresolved payment still needs merchant-authoritative recovery, restoring the prior route may be required until that outcome resolves. This is intentionally fail-closed; PR #29 is planned to make this operational state visible without direct database access.

## Credential boundary

Merchant bearer credentials are not merchant-administration data.

They remain runtime secret configuration under the existing `MINO_MERCHANT_CREDENTIALS_*` boundary and are resolved by organization ID plus stable external merchant ID. The `MerchantEndpoint` row contains no credential field.

The merchant administration request schemas are strict and do not accept credential/authorization fields. Admin responses and administrative audit before/after state contain routing metadata but no merchant bearer credential. Changing domain/vendor/routing configuration therefore does not copy, rewrite, expose, or rotate the runtime credential.

Credential rotation remains an operations/secret-management action outside this API.

## Administrative audit

Every actual merchant mutation and its administrative receipt commit in one PostgreSQL transaction using `PostgresAdminChangeAuditLedger.appendInTransaction`.

The actions are:

```text
merchant.create
merchant.configuration.update
merchant.activate
merchant.deactivate
```

All four currently use the narrow `merchant.manage` permission. Audit state records stable merchant identity, domain, optional vendor ID, canonical base URL, and active state. It does not contain merchant bearer credentials.

## Database model

PR #25 requires no schema migration. The existing `MerchantEndpoint` model already carries the required organization-local identity, domain, optional vendor ID, routing base URL, active state, and timestamps, including the unique `(organizationId, externalMerchantId)` boundary.

## Economic-authority boundary

Merchant registration determines which server-known endpoint Mino may resolve. It does **not** grant an agent permission to transact with that merchant.

A payment still needs an active mandate whose snapshot permits the resulting domain/vendor scope, a valid signed agent request, current policy and machine controls, successful reservation, any required human approval, and a final eligible delegation assertion before dispatch.

The next planned slice is PR #26 — mandate issuance and revocation. That is the first remaining administrative slice that can grant delegated economic authority.