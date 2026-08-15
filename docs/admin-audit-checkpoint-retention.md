# Administrative audit checkpoint retention

Mino's administrative change ledger is signed and tamper-evident inside PostgreSQL, but PostgreSQL is not an independent trust anchor. A database superuser could delete the newest administrative audit rows and coherently rewind the mutable `AdminAuditChainHead` so the remaining database is internally consistent.

Administrative audit checkpoint retention closes that specific gap by exporting signed chain-head proofs to the same separately operated HTTPS/HMAC retention boundary already used for transaction-audit checkpoints.

## Independent proof

An administrative checkpoint contains:

```text
version
organizationId
chainSequence
chainDigest
issuedAt
signingKeyId
Ed25519 signature
```

Its signature domain is distinct from both administrative event signatures and transaction-audit checkpoints:

```text
mino.admin.audit.checkpoint.v1
```

The checkpoint is signed with Mino's configured audit signing key. Historical verification resolves the checkpoint's `signingKeyId`, so normal audit-key rotation does not invalidate older retained proofs as long as the historical public key remains configured.

## Detecting coherent database rewind

The retained-checkpoint verifier first verifies the external checkpoint signature, then independently verifies the current administrative database chain.

If the retained checkpoint says the organization had reached sequence 42 but the current internally valid database has been rewound to sequence 39, verification returns `CHECKPOINT_TRUNCATED`.

If sequence 42 still exists but its chain digest differs from the retained checkpoint, verification returns `CHECKPOINT_DIGEST_MISMATCH`.

This matters because the database-only verifier cannot detect an attacker who deletes the newest rows **and** rewrites the mutable head consistently. Integration tests explicitly demonstrate that the database-only verifier accepts a coherently rewound empty chain while the retained checkpoint still proves that sequence 2 previously existed.

## External delivery protocol

Administrative checkpoints reuse the configured audit-retention endpoint and HMAC secret:

```text
MINO_AUDIT_CHECKPOINT_RETENTION_URL
MINO_AUDIT_CHECKPOINT_RETENTION_SECRET
or
MINO_AUDIT_CHECKPOINT_RETENTION_SECRET_FILE
```

No additional credential is introduced.

Administrative checkpoint events are distinct from transaction-audit events:

```text
mino.admin.audit.checkpoint.retention.v1
```

The request also carries:

```text
X-Mino-Event-Id
X-Mino-Audit-Kind: admin
X-Mino-Audit-Organization-Id
X-Mino-Audit-Sequence
X-Mino-Signature
```

`X-Mino-Signature` is HMAC-SHA256 over `timestamp + "." + canonical-body`, using the same retention secret as the transaction-audit bridge.

The retention receiver must treat the event ID as an idempotency key and durably persist/deduplicate the signed checkpoint **before** returning 2xx.

## Delivery semantics

External delivery is **at-least-once**, not exactly once.

The worker keeps an in-process optimization that skips an unchanged checkpoint after successful delivery, but that state is intentionally not treated as durable delivery truth. A process restart can resend the same stable event ID. The external retention system therefore remains responsible for durable deduplication.

The worker issues a checkpoint only when it observes a stable chain head: it reads the current head, signs a checkpoint tied to that head's `updatedAt`, and verifies that sequence/digest did not advance underneath issuance. Rapidly changing heads are retried a bounded number of times rather than exporting ambiguous proof.

## Runtime scheduling

Production runs transaction-audit retention and administrative-audit retention on separate non-overlapping 60-second loops. They share the external trust boundary but have independent workers, event types, logs, and sequence spaces.

A failure to retain an administrative checkpoint is logged as an operational warning; the worker retries on a later pass. It does not mutate the administrative audit chain or transaction execution path.

Shutdown waits for both retention loops to settle before closing PostgreSQL.

## Trust boundary

With independent retention, an attacker limited to Mino's PostgreSQL database can no longer coherently erase the newest administrative audit suffix without disagreeing with a previously retained signed checkpoint.

This still does not make audit history magically immutable. An attacker who controls both Mino's database **and** the independently operated retention system is inside both trust domains. The security claim is therefore precise: retained checkpoints provide independent tamper evidence against unilateral database rewrite/truncation, assuming the external retention boundary remains independent and preserves accepted events.
