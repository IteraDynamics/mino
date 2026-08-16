# Administrative inventory APIs

Mino exposes deliberately read-only administrative inventory routes on top of the authenticated administrative boundary. Mutation authority lives in separate, narrowly permissioned administrative services; inventory reads do not themselves grant or change authority.

These routes support operator tooling and the future web console while preserving organization-local query boundaries and safe projections.

## Routes and permissions

All routes require a valid configured admin Bearer JWT plus an active Mino membership in the exact organization named in the URL.

```text
GET /v1/admin/organizations/:organizationId/agents
    requires agent.read

GET /v1/admin/organizations/:organizationId/policies
    requires policy.read

GET /v1/admin/organizations/:organizationId/merchants
    requires merchant.read

GET /v1/admin/organizations/:organizationId/mandates
    requires mandate.read
```

Authentication and authorization use the same shared boundary as the access-introspection endpoint:

- invalid/missing bearer identity → generic `401 unauthorized`
- valid identity without the exact tenant permission → generic `403 forbidden`
- malformed organization ID or pagination input → `400 invalid_request`

All responses carry `Cache-Control: no-store`.

## Pagination

Inventory routes use deterministic forward cursor pagination by the resource's stable UUID primary key.

Query parameters:

```text
limit   optional integer, default 50, minimum 1, maximum 100
cursor  optional UUID returned as nextCursor by the previous page
```

Unknown query parameters are rejected rather than silently ignored.

A page has this envelope:

```json
{
  "items": [],
  "nextCursor": "optional-resource-uuid"
}
```

`nextCursor` is omitted on the last page.

The cursor affects ordering only inside the already organization-scoped database predicate. It cannot cause another organization's records to be returned.

## Agent inventory

Agent rows expose operational identity metadata needed by administrators:

- Mino agent ID
- external agent ID
- optional display name
- status
- optional key ID
- created/updated timestamps

The agent public verification key itself is deliberately not returned by this list API.

## Policy inventory

Policy rows expose the effective policy snapshot fields needed to understand current spending governance, including merchant/vendor/category scopes, approval mode, velocity controls, and version/active state.

Monetary values are returned as exact decimal **strings in minor units**:

```json
{
  "maxBudgetMinor": "9007199254740993123",
  "rollingDailyLimitMinor": "9007199254740993999"
}
```

They are not converted to JavaScript numbers, because policy values are persisted as PostgreSQL `BIGINT` and may exceed IEEE-754 safe-integer precision.

## Merchant inventory

Merchant rows expose:

- Mino merchant-endpoint ID
- external merchant ID
- domain
- optional vendor ID
- active state
- created/updated timestamps

The internal upstream `baseUrl` is not returned by this list API, and merchant authorization credentials are never part of the repository result.

## Mandate inventory

Mandate rows expose the safe authority metadata needed to understand which durable grants exist:

- mandate ID
- user ID
- agent ID
- exact policy row ID and policy version
- currency
- max-budget and rolling-daily-limit minor-unit strings
- status
- issued/expiration timestamps
- optional revocation timestamp
- mandate signing-key ID

The list deliberately omits:

- raw mandate bearer tokens
- raw token JTI values and JTI hashes
- administrative issuance idempotency keys or their hashes
- private signing material

Full organization-scoped mandate detail is a separate `mandate.read` endpoint documented in `docs/admin-mandate-management.md`. It can expose additional safe snapshot fields/fingerprints but still never exposes the raw bearer artifact.

## Tenant boundary

Every Prisma query includes the requested `organizationId` before rows are materialized. Mino does not query globally and filter the result in application memory.

Integration coverage uses organization-local authorization and production repositories to verify cross-tenant access fails closed.

## Relationship to write surfaces

Inventory is observational. Administrative writes introduced in later governed slices use separate routes and exact permissions:

- agent enrollment/lifecycle: `agent.create`, `agent.suspend`, `agent.reactivate`, `agent.rotate_key`
- policy administration: `policy.create`, `policy.activate`, `policy.deactivate`
- merchant administration: `merchant.manage`
- mandate issuance/revocation: `mandate.issue`, `mandate.revoke`

Those mutations remain subject to their own validation, transactional state changes, and signed administrative-audit receipts; possessing a read permission never implies the corresponding write permission.
