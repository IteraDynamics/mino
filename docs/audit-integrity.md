# Audit integrity model

Mino's PostgreSQL audit ledger is designed to make changes to recorded gateway decisions detectable without storing payment credentials or authorization secrets in the ledger.

## Record construction

Before persistence, the audit sink recursively redacts known credential fields again even if the caller already supplied a sanitized payload. It then canonicalizes the persisted event, including the request/decision identities, organization/user/agent/mandate binding, merchant context, requested and approved payloads, decision snapshot, queryable decision fields, request digest, reservation reference, and upstream status.

The canonical event is hashed with SHA-256 to produce `eventDigest`.

## Organization-local chain

Each organization has an independent monotonically increasing `chainSequence`. PostgreSQL stores one `AuditChainHead` row per organization. A writer creates that row idempotently when necessary and then locks it with `SELECT ... FOR UPDATE` inside the same transaction that inserts the audit event and advances the chain head. The database also enforces a unique `(organizationId, chainSequence)` index on `AuditLog`.

This gives every organization an explicit serialization point: concurrent legitimate writers cannot independently read the same prior sequence and create competing next entries. The `AuditChainHead` row is operational mutable state used to serialize writers; it is not treated as an external integrity anchor.

For each audit row, Mino computes a chain digest over:

- chain format/version
- organization ID
- organization-local sequence
- previous chain digest (or `null` for genesis)
- current event digest

The row stores both the previous digest and current digest. Changing or removing an interior row therefore breaks the next link or creates a sequence gap.

## Event signatures and key rotation

Mino signs a canonical chain envelope with Ed25519. The envelope binds the chain digest, event digest, sequence, previous digest, organization, format version, and signing key ID.

The private key is supplied by an external `AuditSigningKeyProvider`; it is not stored in `AuditLog`. Each row persists only the `signingKeyId` and signature. Historical verification resolves the appropriate public key for each row, so a deployment may rotate the active audit signing key without invalidating the earlier chain.

## Verification

`PostgresAuditVerifier.verifyOrganization()` walks the organization chain from sequence 1 and fails at the first detected integrity violation. It checks:

- supported chain version
- contiguous sequence numbers
- exact previous-digest linkage
- recomputed event digest
- recomputed chain digest
- availability of the historical verification key
- Ed25519 signature validity

This detects payload or query-column modification, signature modification, reordering, middle deletion, inserted gaps, and broken chain links.

## Tail truncation and signed checkpoints

A hash chain stored only in the same mutable database has a fundamental limitation: if a privileged attacker deletes the newest suffix and also rewrites database-local chain-head state to the remaining valid prefix, the surviving prefix can still be internally valid. No algorithm can prove that a later suffix once existed if every copy of that fact lives in the same trust domain and is deleted or rewritten with it.

Mino therefore supports signed chain checkpoints. `issueCheckpoint()` returns a signed statement containing the organization ID, current chain sequence, current chain digest, issue time, and signing key ID.

A checkpoint becomes a trusted anchor only when retained outside the same PostgreSQL trust domain—for example in independent object storage with retention controls, a compliance archive, another service/account, or an external transparency system. Later verification against that checkpoint detects a local database whose head was truncated below the anchored sequence or whose digest at the anchored sequence no longer matches.

## External checkpoint retention

The production server periodically exports signed checkpoints to a separately configured HTTPS retention bridge. The transport event includes a deterministic event ID plus the complete Ed25519-signed checkpoint. Transport authentication uses HMAC-SHA256 over the canonical event body and a timestamp.

For an unchanged organization chain head, Mino derives a stable checkpoint issue time from the chain head's own `updatedAt` value and confirms that the head did not advance while the checkpoint was being signed. That makes both the signed checkpoint and its retention event ID stable across retries and process restarts.

Delivery is intentionally **at-least-once**. A process remembers successful event IDs only to suppress redundant sends while that process remains alive. Another Mino instance or a restarted process may resend the same event. The retention service must deduplicate `X-Mino-Event-Id` and must return 2xx only after the signed checkpoint has been durably committed to the independent retention system.

The retention transport does not write a database-local flag claiming that the checkpoint is externally immutable. Such a flag would live in the same mutable trust domain and therefore could not prove external retention. The independent retained copy is the evidence.

`MINO_AUDIT_CHECKPOINT_RETENTION_URL` must use HTTPS. Its HMAC secret may be supplied inline through `MINO_AUDIT_CHECKPOINT_RETENTION_SECRET` or through the mounted-file alternative `MINO_AUDIT_CHECKPOINT_RETENTION_SECRET_FILE`, but never both.

The configured receiver is responsible for the actual retention guarantee. Suitable implementations include a bridge backed by WORM/object-lock storage, a compliance archive in a separate account, an append-only transparency service, a trusted timestamp service, or a future blockchain anchoring backend. Mino does not claim that an arbitrary HTTP endpoint is immutable merely because it returned 2xx.

## Security claim

The correct claim for the current implementation is **cryptographically tamper-evident audit logging with independently exportable signed checkpoints**.

It is not claimed to be physically immutable against a PostgreSQL superuser. Stronger immutability depends on deployment controls outside the database trust domain, including the configured external checkpoint-retention system.