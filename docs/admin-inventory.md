# Administrative inventory APIs

Mino exposes a deliberately read-only administrative inventory surface on top of the authenticated administrative boundary.

These routes are intended to support operator tooling and a future dashboard without introducing configuration mutation authority before administrative change auditing is available.

## Routes and permissions

All routes require a valid configured admin Bearer JWT plus an active Mino membership in the exact organization named in the URL.

```text
GET /v1/admin/organizations/:organizationId/agents
    requires agent.read

GET /v1/admin/organizations/:organizationId/policies
    requires policy.read

GET /v1/admin/organizations/:organizationId/merchants
    requires merchant.read
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

## Tenant boundary

Every Prisma query includes the requested `organizationId` before rows are materialized. Mino does not query globally and filter the result in application memory.

Tests seed resources belonging to a second organization and verify those records never appear in the target organization's pages.

## Deliberate non-claims

This slice adds no administrative writes. In particular it cannot:

- create/update/suspend agents
- rotate agent keys
- create/activate/deactivate policies
- register/update merchants
- issue/revoke mandates
- manage memberships or roles

Those operations should be introduced only behind the same narrow permission model and a durable administrative-change audit trail.
