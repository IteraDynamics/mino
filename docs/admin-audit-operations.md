# Administrative audit and operations APIs

Mino exposes an organization-scoped administrative visibility surface for transaction audit, administrative change audit, integrity verification, and durable operational state. The surface is intentionally observational. It is designed to support an operator or the first web console without creating repair, settlement, reconciliation, checkpoint-issuance, or worker-control authority.

## Authentication and permissions

These routes exist only when trusted administrative JWT issuers are configured. Every request first crosses the pinned-issuer Bearer-JWT boundary and then the exact organization-local permission check.

```text
GET  /v1/admin/organizations/:organizationId/audit/transactions
     audit.read

GET  /v1/admin/organizations/:organizationId/audit/administrative
     audit.read

POST /v1/admin/organizations/:organizationId/audit/transactions/verify
     audit.verify

POST /v1/admin/organizations/:organizationId/audit/administrative/verify
     audit.verify

GET  /v1/admin/organizations/:organizationId/operations
     audit.read
```

`audit.read` and `audit.verify` are separate authorities. For example, the built-in `FINANCE_MANAGER` role can inspect audit/operational state but does not thereby gain chain-verification authority, while `AUDITOR` carries both read and verification permissions.

All responses use `Cache-Control: no-store`.

## Transaction-audit inventory

Transaction-audit inventory is ordered by the integrity domain itself:

```text
chainSequence DESC
```

The opaque cursor contains the last visible positive chain sequence. `limit` defaults to 50 and is bounded to 1–100.

Supported filters are:

- verdict
- operation
- user ID
- agent ID
- mandate ID
- merchant domain
- created-after timestamp
- created-before timestamp

The safe projection exposes the correlation and integrity fields needed to investigate a decision:

- chain sequence and timestamp
- request and decision IDs
- user, agent, and optional mandate IDs
- protocol and operation
- merchant domain and optional vendor ID
- verdict and reason codes
- policy version when present
- evaluation latency
- reservation ID and upstream status when present
- event digest, prior chain digest, current chain digest, and signing-key ID

It deliberately omits:

- requested transaction payload
- approved payload
- decision snapshot
- arbitrary audit metadata
- request digest
- raw integrity signature
- credentials, bearer material, or private keys

The underlying signed ledger still retains the complete defensively redacted audit event required for cryptographic verification. The administrative list projection is narrower because an operator view does not require every persisted field.

## Administrative-audit inventory

Administrative change audit remains a separate sequence/signature domain and is also ordered by:

```text
chainSequence DESC
```

Supported filters are:

- principal ID
- permission
- action
- resource type
- resource ID
- created-after timestamp
- created-before timestamp

The projection exposes:

- chain sequence and timestamp
- request ID
- historical principal and membership IDs
- permission and action
- resource type and optional resource ID
- historical role set
- event digest, prior chain digest, current chain digest, and signing-key ID

It deliberately omits before/after snapshots, arbitrary metadata, request digests, and integrity signatures. Those fields remain available to the verifier inside the durable ledger but are not needed for routine low-risk inventory.

Transaction and administrative audit are never merged into one synthetic ordering. Their sequence spaces, chain heads, signature domains, and retention event types remain independent.

## Explicit verification

Verification is a POST because the operator is requesting computational validation with an optional supplied proof, but the operation does not mutate Mino state.

A request body may be empty:

```json
{}
```

or may contain a signed checkpoint obtained independently from the retention trust domain:

```json
{
  "retainedCheckpoint": {
    "version": 1,
    "organizationId": "...",
    "chainSequence": "42",
    "chainDigest": "...",
    "issuedAt": "2026-08-16T20:00:00.000Z",
    "signingKeyId": "audit-k1",
    "signature": "..."
  }
}
```

### Transaction audit

`POST .../audit/transactions/verify` always verifies the current PostgreSQL transaction-audit chain. If a retained transaction checkpoint is supplied, the existing transaction verifier also validates that signed checkpoint and anchors it against current database history.

### Administrative audit

`POST .../audit/administrative/verify` always verifies the current PostgreSQL administrative-audit chain. If a retained administrative checkpoint is supplied, the retained-admin verifier validates:

- checkpoint structure
- organization binding
- signing key
- checkpoint signature
- current database-chain validity
- whether the database is shorter than the retained sequence
- whether the database digest at the retained sequence still matches the checkpoint

A verification failure is returned as evidence in the normal response. The API does not attempt to repair, rewrite, truncate, advance, or otherwise mutate either chain.

## Independent checkpoint boundary

Mino already exports signed transaction and administrative audit checkpoints to an independently operated HTTPS/HMAC retention boundary. Delivery is at-least-once and the external receiver is responsible for durable deduplication and retention.

PR #29 does **not** add a credential or client that reads checkpoints back from that system. Doing so would unnecessarily broaden Mino's authority over a trust anchor intended to be independently retained.

Instead, an operator or retention service can supply a retained signed checkpoint to the verification endpoint. Mino verifies that proof using configured historical audit public keys and current durable database history.

There is intentionally no administrative checkpoint-issuance endpoint. Issuing a fresh local checkpoint at verification time would not substitute for an independently retained historical anchor when testing for coherent database rewind or suffix deletion.

## Operational snapshot

`GET /v1/admin/organizations/:organizationId/operations` returns a point-in-time, organization-scoped snapshot derived from durable PostgreSQL state. It is an operator read model, not a transaction-authorization input and not a promise that every external dependency is healthy.

### Payment reconciliation

The payment section reports:

- `FORWARDING`, `UNKNOWN`, `SUCCEEDED`, and `FAILED_DEFINITIVE` counts
- total unresolved (`FORWARDING` + `UNKNOWN`)
- reconciliation-claimable unresolved outcomes
- stale unresolved outcomes
- high-attempt unresolved outcomes
- currently leased unresolved outcomes
- age and ID of the oldest unresolved payment when one exists

Claimability deliberately mirrors the existing background reconciler:

- `UNKNOWN` is eligible when `nextReconcileAt` is absent or due
- `FORWARDING` is eligible only after the existing 30-second forwarding grace
- an active reconciliation lease prevents another worker from claiming the row

The stale threshold mirrors the existing reconciliation monitor: five minutes. `highAttempt` uses the existing threshold of eight reconciliation attempts.

These counts do not trigger reconciliation and cannot resolve payment outcome state.

### Approval delivery

The approval section reports persisted approval status counts plus:

- persisted `PENDING` requests already past `expiresAt`
- notification `PENDING`
- actively `LEASED` notifications
- `DELIVERED`
- `DEAD_LETTER`
- currently claimable notification work
- age of the oldest still-undelivered pending approval

Notification claimability mirrors the existing PostgreSQL outbox worker: a missing/PENDING notification or an expired lease may be claimed when `nextAttemptAt` is absent or due. A persisted pending request past its approval expiry remains visible as `expiredPending`; merely opening the operations page does not mutate it. The normal worker or approval state machine remains responsible for durable transitions.

### Spend reservations

The snapshot reports `RESERVED`, `COMMITTED`, `RELEASED`, and `EXPIRED` durable reservation counts, plus `overdueReserved` for rows still persisted as `RESERVED` after `expiresAt`.

This is diagnostic visibility only. The endpoint cannot commit, release, extend, expire, or reconstruct reservations.

### Audit coverage

The snapshot includes the stored transaction and administrative chain heads for the organization:

- current sequence
- current digest when present
- last head update timestamp when present

A stored head is operational state, not proof that the chain is valid. Operators requiring integrity evidence must use the explicit `audit.verify` routes.

## No operations mutation surface

PR #29 adds no endpoint to:

- force payment success or definitive failure
- release or commit allowance
- invoke reconciliation on demand
- steal or clear worker leases
- retry/dead-letter approval notification manually
- mutate spend reservations
- trigger Redis reconstruction
- delete or rewrite audit history
- change a chain head
- repair a failed chain verification
- issue a replacement retained checkpoint
- retrieve private audit signing keys or retention credentials

Operational visibility therefore remains downstream of the existing safety boundaries rather than becoming an alternate control plane for economic truth.

## Database and deployment boundary

The slice uses the existing audit, payment, approval, reservation, and chain-head tables and their existing indexes. It requires no new Prisma model or migration and no new runtime secret, network credential, container authority, or external dependency.
