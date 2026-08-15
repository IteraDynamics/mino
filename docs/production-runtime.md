# Production runtime composition

Mino has a concrete application composition root for running the implemented control-plane modules as one service.

## Startup

`src/server.ts` loads production configuration, constructs the dependency graph, and starts Fastify. Startup is fail-closed: PostgreSQL, Redis, and Prisma connectivity are checked before the application is returned, malformed or missing security configuration causes startup to fail rather than substituting insecure defaults, and relevant Redis authorization state is reconstructed from durable PostgreSQL facts before the production application is returned.

The compiled service starts with:

```bash
npm run build
npm start
```

## Secret inputs

Non-secret runtime settings may be supplied directly through environment variables. Sensitive values support two mutually exclusive forms: the legacy inline environment value or a mounted secret file. Configuring both forms for the same secret is rejected.

Mounted-file inputs are intended for deployment systems such as Vault Agent, Kubernetes CSI secret stores, or cloud secret-manager sidecars. Mino resolves the configured path and requires it to resolve to a readable regular file before startup succeeds.

Supported mounted secret alternatives are:

- `MINO_DELEGATION_PRIVATE_KEY_FILE` instead of `MINO_DELEGATION_PRIVATE_KEY_B64`
- `MINO_AUDIT_PRIVATE_KEY_FILE` instead of `MINO_AUDIT_PRIVATE_KEY_B64`
- `MINO_APPROVAL_RESOLUTION_SECRET_FILE` instead of `MINO_APPROVAL_RESOLUTION_SECRET`
- `MINO_APPROVAL_WEBHOOK_SECRET_FILE` instead of `MINO_APPROVAL_WEBHOOK_SECRET`
- `MINO_MERCHANT_CREDENTIALS_FILE` instead of `MINO_MERCHANT_CREDENTIALS_JSON`
- `MINO_AUDIT_CHECKPOINT_RETENTION_SECRET_FILE` instead of `MINO_AUDIT_CHECKPOINT_RETENTION_SECRET`

Private-key files contain PEM directly. HMAC files contain the secret text directly. The merchant credential file contains the same JSON object accepted by `MINO_MERCHANT_CREDENTIALS_JSON`.

Public verification material remains non-secret configuration:

- `MINO_MANDATE_PUBLIC_KEYS_B64_JSON` maps mandate signing key IDs to base64-encoded Ed25519 public PEM keys.
- `MINO_AUDIT_PUBLIC_KEYS_B64_JSON` maps current and historical audit signing key IDs to base64-encoded Ed25519 public PEM keys.
- `MINO_DELEGATION_SIGNING_KEY_ID` identifies the active delegation signing key.
- `MINO_AUDIT_SIGNING_KEY_ID` identifies the active audit signing key.

Mino validates private signing keys as Ed25519 at startup. For audit signing, the active private key must cryptographically match the public verification key registered under `MINO_AUDIT_SIGNING_KEY_ID`; a missing or mismatched pair fails startup.

Secrets are loaded at application startup. This slice does not claim in-process hot key replacement. Externally managed secret rotation is adopted through a controlled rolling restart.

## Audit signing-key rotation

A safe audit-key rotation preserves verification continuity:

1. Generate the new Ed25519 key pair in the external secret-management system.
2. Add the new public key to `MINO_AUDIT_PUBLIC_KEYS_B64_JSON` while retaining all historical public keys still needed to verify stored audit rows.
3. Stage the new private PEM in the managed secret mount.
4. Change `MINO_AUDIT_SIGNING_KEY_ID` to the new key ID.
5. Perform a rolling restart.
6. Each new process validates that the new private key matches the public key registered under the active ID before accepting traffic.
7. Keep older public keys available for as long as historical audit rows signed by those IDs must remain verifiable.

The audit ledger records `signingKeyId` per row, so new events can use the rotated key without invalidating older signatures.

Delegation private keys may likewise be supplied from mounted secret files and rotated by changing the active key ID/private material together during a controlled deployment. Downstream consumers remain responsible for retaining whatever historical delegation verification keys their trust policy requires.

## Required non-secret configuration

The production configuration loaders also read:

- `DATABASE_URL` — PostgreSQL connection URL.
- `REDIS_URL` — Redis connection URL.
- `MINO_ISSUER` — HTTPS issuer identity used by Mino-signed artifacts.
- `MINO_APPROVAL_WEBHOOK_URL` — HTTPS destination for approval-required notifications.
- `MINO_AUDIT_CHECKPOINT_RETENTION_URL` — HTTPS destination for the independently operated signed-checkpoint retention bridge.
- `MINO_HOST` — optional; defaults to `0.0.0.0`.
- `MINO_PORT` — optional; defaults to `3000`.

The checkpoint-retention transport secret is required through exactly one of `MINO_AUDIT_CHECKPOINT_RETENTION_SECRET` or `MINO_AUDIT_CHECKPOINT_RETENTION_SECRET_FILE` and must contain at least 32 characters.

## Concrete dependency graph

`createProductionApplication()` constructs and connects PostgreSQL/Prisma, Redis, repositories, mandate-token verification, signed agent-request verification, replay protection, policy evaluation, atomic Redis spend reservations, durable PostgreSQL reservation mirrors, authorization-state reconstruction, durable approvals, approval-notification delivery, durable payment outcomes, continuous payment reconciliation, unresolved-payment monitoring, the tamper-evident audit ledger, optional checkpoint-retention worker composition, ACP merchant forwarding, and delegation assertions.

The production server supplies the required HTTPS checkpoint retainer to that composition root, so the runnable service includes external checkpoint export. Private signing keys and merchant credentials are never persisted into Mino's transactional tables.

## Redis authorization state recovery

Redis is Mino's fast atomic enforcement layer for rolling spend, active reservations, velocity, idempotency, and reservation lifecycle details. PostgreSQL now provides the durable recovery facts needed to fail closed after a complete Redis loss.

### Durable reservation bridge

When Redis accepts a new spend reservation, production does not immediately continue toward payment. The reservation is first mirrored into PostgreSQL `SpendReservation` with the organization/user/agent/mandate binding, idempotency key, merchant, currency, amount, reserve time, expiry, and lifecycle status.

The order is intentionally conservative:

1. Redis atomically evaluates policy state and creates the reservation.
2. Mino persists the accepted reservation in PostgreSQL.
3. Only after that durable write succeeds may the request proceed toward `PaymentOutcome` creation and merchant dispatch.

If step 2 fails, Mino attempts to release the Redis reservation and fails the request. A crash after the Redis reservation but before the durable write can leave only a short-lived Redis hold; no merchant dispatch has been authorized past the durable boundary. A crash after the durable write leaves a PostgreSQL fact that reconstruction can restore.

Reservation lifecycle transitions are mirrored conservatively as well. Commit, release, approval release, and reconciliation-hold extension update the durable reservation before the corresponding Redis transition. A durable `COMMITTED` reservation cannot be reopened as `RESERVED` by a stale same-idempotency retry. Released or expired rows may be replaced by the fresh reservation created by an approved retry.

### Reconstruction source

For each mandate, `RedisAuthorizationStateReconstructor` rebuilds:

- recent `SpendReservation` rows in `COMMITTED` state as rolling committed spend
- active pre-dispatch `SpendReservation` rows in `RESERVED` state as active allowance holds
- unresolved `PaymentOutcome` rows (`FORWARDING`/`UNKNOWN`) as reconciliation holds, including legacy rows without a durable reservation mirror
- recent successful `PaymentOutcome` rows as a legacy/cross-dispatch committed-spend fallback when no committed reservation mirror exists
- recent `PaymentOutcome` and checkout-completion `AuditLog` activity as velocity history

Unresolved payments receive a fresh reconciliation hold during recovery so uncertainty cannot silently age out merely because Redis restarted. Durable amounts are rejected if they exceed the same exact-integer range accepted by the Redis/Lua authorization engine.

The restore is performed by one Redis Lua script per mandate. The per-mandate key `mino:v1:auth:{mandateId}:state-reconstructed` is written only after the reconstructed committed/reserved/velocity/detail state has been applied. Conflicting durable state removes or withholds that marker and fails closed.

### Startup and later loss

Production startup proactively calls `reconstructAll()` after PostgreSQL and Redis connectivity checks. Relevant active mandates and mandates with recent/unresolved durable money state are reconstructed before the application is returned.

Every production reservation lifecycle operation is also wrapped by `ReconstructingAuthorizationReservations`. It requires the per-mandate marker before the operation and checks the marker again afterward. If Redis is completely wiped after startup, the missing marker triggers lazy reconstruction before that mandate can authorize or finalize more spend. If Redis disappears during an authorization operation, the post-operation marker check fails the request rather than trusting a reservation that vanished underneath it.

Commit and reconciliation-hold operations can force one reconstruction/retry when reservation detail was lost, allowing durable payment recovery to rehydrate the Redis detail needed by the existing lifecycle scripts.

### Explicit boundary

This design targets **complete Redis state loss/restart**, where the state and reconstruction marker disappear together. It does not claim to detect arbitrary selective eviction of one authorization key while the marker somehow survives. Production Redis must therefore use an appropriate `noeviction` policy plus persistence/replication/availability controls suitable for a financial authorization dependency.

The reconstruction also does not claim to recreate every ephemeral Redis idempotency result for requests that never crossed a durable payment or approval boundary. Those requests are re-evaluated under current governed state. The safety-critical monetary holds and recent velocity history are reconstructed from durable facts.

## Background workers

The production server runs three independent non-overlapping worker loops:

- approval notification delivery every two seconds
- payment outcome reconciliation every two seconds
- signed audit-checkpoint retention export every minute

Each loop schedules its next run only after the prior run settles. PostgreSQL leases remain the cross-process claim boundary for approval and payment work.

Audit-checkpoint retention intentionally uses a different concurrency model. Each checkpoint event has a deterministic event ID derived from the complete signed checkpoint, and the external retention service must deduplicate that ID. Multiple Mino instances or a restarted process may therefore resend the same checkpoint without relying on mutable database-local publication state to claim that an external anchor exists.

On `SIGTERM` or `SIGINT`, new loop iterations stop and in-flight runs are allowed to settle before Redis, Prisma, and PostgreSQL resources are closed.

## External audit-checkpoint retention

For every organization with a non-empty audit chain, the worker reads the current `AuditChainHead` and asks the existing `PostgresAuditLedger` to issue the checkpoint. To make retries stable, it uses the head's `updatedAt` timestamp as the checkpoint issue time and confirms after signing that the sequence and digest did not advance. If the head races forward repeatedly, that organization is treated as a failed export for the run rather than emitting an unstable identity.

The HTTPS event carries the full Ed25519-signed checkpoint plus a deterministic `X-Mino-Event-Id`. A separate HMAC-SHA256 transport signature binds the canonical event body to a timestamp. Redirects are rejected and non-2xx responses are treated as failures.

Successful event IDs are remembered only in process memory to avoid needless repeats during that process lifetime. The external retained copy—not a flag in PostgreSQL—is the independent evidence. After a restart or on another Mino instance, the same stable checkpoint may be resent. This is an **at-least-once** retention transport, not an exactly-once claim.

The receiver must return 2xx only after durable retention and must deduplicate `X-Mino-Event-Id`. It should operate in a separate trust domain and can be backed by WORM/object-lock storage, an independently controlled compliance archive, a transparency/timestamp service, or a future blockchain anchoring implementation. Mino cannot prove that an arbitrary configured HTTP service is immutable merely because it acknowledged a request.

Failures emit structured warnings suitable for routing into the deployment's monitoring stack. Checkpoint-export failure does not weaken or bypass transaction authorization and does not mutate payment state.

## Payment reconciliation operations

The payment reconciler continuously claims unresolved `UNKNOWN` outcomes and stale `FORWARDING` outcomes, refreshes the Redis reconciliation hold, obtains server-side merchant credentials, and queries merchant-authoritative checkout state. It does not blindly repeat payment submission.

A read-only `PaymentReconciliationMonitor` separately summarizes unresolved count, stale count, high-attempt count, oldest unresolved age, and oldest outcome ID. The default warning thresholds are five minutes unresolved or eight reconciliation attempts. Structured logs are designed for routing into deployment metrics, SIEM, paging, or alert systems; Mino does not claim a built-in vendor-specific alert transport.

## Readiness and liveness

`GET /healthz` reports process liveness. `GET /readyz` returns ready only when PostgreSQL, Redis, and Prisma are reachable. Startup reconstruction completes before the application is returned. A later full Redis wipe is handled fail-closed per mandate on the next guarded authorization operation rather than by claiming that simple Redis connectivity alone proves all reconstructed keys are present.

Unresolved payments or a temporary checkpoint-retention outage do not make the HTTP data plane unready; they remain surfaced through governed recovery or operational warnings rather than altering authorization behavior.

## Verification boundary

The production-composition integration test uses real PostgreSQL, Redis, Prisma repositories, mandate signatures, agent signatures, nonce replay protection, durable spend reservation state, payment outcome persistence, and audit-chain verification. The only intentionally replaced boundary is the external merchant network call.

Production-config unit coverage verifies mounted secret loading, ambiguous dual-source rejection, required-secret failure, Ed25519 validation, active audit key-pair matching, and retention of historical audit public keys. Separate checkpoint-retention unit tests cover HTTPS enforcement, mounted HMAC-secret loading, canonical HMAC transport, non-2xx failure handling, and deterministic event IDs. PostgreSQL integration tests cover stable checkpoint export, chain-head advancement, retry identity, and restart-style duplicate delivery for downstream deduplication.

Redis-recovery verification uses real PostgreSQL and Redis. It covers reconstruction of recent committed spend, unresolved reconciliation holds, recent blocked-attempt velocity, repeated full Redis loss, rejection of amounts outside Redis's exact-integer range, pre-`PaymentOutcome` durable reservation recovery, committed-state non-regression, approval-release reservation replacement, and fail-closed marker loss during an operation.

## Still intentionally outside this slice

Remaining productionization work includes:

- direct vendor-specific KMS signing APIs where private key material never leaves an HSM/KMS boundary
- vendor-specific metrics/alert transports, tracing, and operational dashboards
- broader ACP endpoint coverage and customer-facing administrative surfaces
