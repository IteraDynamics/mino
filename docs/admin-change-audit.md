# Administrative change audit ledger

Mino maintains a dedicated signed audit chain for successful administrative state changes. It is intentionally separate from the agent/payment `AuditLog` chain because the two event families have different schemas and must not share a sequence that either verifier could observe as gaps.

No administrative mutation HTTP routes are enabled by this slice. The ledger exists first so later write APIs have a safe persistence primitive to use.

## Atomic mutation pattern

The critical API is `PostgresAdminChangeAuditLedger.appendInTransaction`.

Future administrative writes should follow this pattern on one PostgreSQL transaction and one connection:

```text
BEGIN
  mutate governed Mino state
  append signed AdminAuditLog event
COMMIT
```

If either the mutation or audit append fails, the caller rolls the transaction back. A crash cannot intentionally be handled as "state changed, audit will be written later." Integration tests exercise both rollback and commit paths against real PostgreSQL.

The convenience `append` method exists for standalone administrative audit events. It opens and owns its own transaction. `appendInTransaction` never commits, rolls back, or releases the caller's transaction.

## Per-organization signed chain

Each organization has an independent `AdminAuditChainHead` containing the current sequence and digest. Appending an event:

1. ensures the organization's chain head exists;
2. locks that row with `FOR UPDATE`;
3. assigns the next monotonic sequence;
4. canonicalizes and hashes the sanitized event;
5. derives a chain digest from organization, sequence, prior digest, and event digest;
6. signs the chain state with Mino's active Ed25519 audit key;
7. inserts `AdminAuditLog`;
8. advances the chain head in the same transaction.

The chain uses its own domain separator (`mino.admin.audit.chain.v1`) and does not reuse transaction-audit sequence numbers.

## Actor and authorization snapshot

Each committed change records:

- organization ID;
- request ID;
- administrative principal ID;
- organization-membership ID;
- permission that authorized the operation;
- role snapshot at the time of authorization;
- action name;
- resource type and optional resource ID;
- request digest;
- timestamp;
- sanitized before/after state and optional metadata.

`principalId` and `membershipId` are stored as UUID facts rather than foreign keys to the mutable admin-membership tables. Removing an administrator or membership therefore cannot cascade-delete historical change records. The organization relation remains restrictive for audit rows so an organization cannot be deleted while its administrative history still exists.

## Sensitive-state handling

Before state, after state, and metadata are defensively redacted **before** canonicalization, hashing, signing, or persistence.

The administrative redactor includes the existing payment/credential/card fields plus administrative secret forms such as passwords, private keys, client secrets, access tokens, refresh tokens, and bearer values. Dates are normalized to ISO strings and bigint values to exact decimal strings before persistence. Raw JWTs are not part of the event interface.

This is defense in depth. Future mutation handlers should still construct deliberately narrow audit snapshots rather than passing arbitrary request/configuration objects into the ledger.

## Verification

`PostgresAdminChangeAuditVerifier` replays an organization's chain from sequence 1 and checks:

- supported chain version;
- contiguous sequence numbers;
- prior-digest linkage;
- recomputed event digest;
- recomputed chain digest;
- historical signing-key availability;
- Ed25519 event signature;
- final stored chain-head sequence and digest.

It detects row mutation, middle deletion/gaps, link corruption, signature corruption, and deletion of newest rows while the durable chain head remains ahead.

## Independent checkpoint boundary

The mutable PostgreSQL chain head is not treated as an independent trust anchor. Production also issues signed administrative chain-head checkpoints and exports them to the separately operated audit-retention boundary.

A retained checkpoint lets `PostgresRetainedAdminAuditVerifier` detect a coherent database rewind where an attacker deletes the newest administrative audit rows **and** rewrites the local chain head to match the shortened database. In that case the database-only chain can still be internally valid, but it cannot agree with the previously retained signed sequence/digest.

Administrative checkpoints use a separate signing domain and retention-event type from transaction audit while reusing Mino's configured audit signing keys and external HTTPS/HMAC retention credential. Delivery is at-least-once with stable event IDs; the external receiver must durably deduplicate before returning success. See `docs/admin-audit-checkpoint-retention.md`.

## Trust boundary and non-claims

The combined chain plus independent checkpoint retention is **tamper-evident**, not immutable. It provides independent evidence against unilateral PostgreSQL rewrite/truncation as long as the external retention system remains a separate trust domain and preserves accepted events.

An attacker who controls both Mino's database and the independently operated retention system is inside both trust boundaries. Mino therefore does not describe this as immutable or blockchain-backed audit history.

The ledger also does not claim to audit denied HTTP attempts in this slice. Its immediate safety purpose is stronger and narrower: every **successful governed administrative state mutation** can be committed atomically with a signed, durable change receipt, and the resulting chain head can be independently retained outside the database.
