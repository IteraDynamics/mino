# Production runtime composition

Mino has a concrete application composition root for running the implemented control-plane modules as one service.

## Startup

`src/server.ts` loads production configuration, constructs the dependency graph, and starts Fastify. Startup is fail-closed: PostgreSQL, Redis, and Prisma connectivity are checked before the application is returned, and malformed or missing security configuration causes startup to fail rather than substituting insecure defaults.

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

The production configuration loader also reads:

- `DATABASE_URL` — PostgreSQL connection URL.
- `REDIS_URL` — Redis connection URL.
- `MINO_ISSUER` — HTTPS issuer identity used by Mino-signed artifacts.
- `MINO_APPROVAL_WEBHOOK_URL` — HTTPS destination for approval-required notifications.
- `MINO_HOST` — optional; defaults to `0.0.0.0`.
- `MINO_PORT` — optional; defaults to `3000`.

## Concrete dependency graph

`createProductionApplication()` constructs and connects PostgreSQL/Prisma, Redis, repositories, mandate-token verification, signed agent-request verification, replay protection, policy evaluation, atomic spend reservations, durable approvals, approval-notification delivery, durable payment outcomes, continuous payment reconciliation, unresolved-payment monitoring, the tamper-evident audit ledger, ACP merchant forwarding, and delegation assertions.

Private signing keys and merchant credentials are never persisted into Mino's transactional tables.

## Background workers

The production server runs independent non-overlapping worker loops for approval notification delivery and payment outcome reconciliation. Each loop schedules its next run only after the prior run settles. PostgreSQL leases remain the cross-process claim boundary.

On `SIGTERM` or `SIGINT`, new loop iterations stop and in-flight runs are allowed to settle before Redis, Prisma, and PostgreSQL resources are closed.

## Payment reconciliation operations

The payment reconciler continuously claims unresolved `UNKNOWN` outcomes and stale `FORWARDING` outcomes, refreshes the Redis reconciliation hold, obtains server-side merchant credentials, and queries merchant-authoritative checkout state. It does not blindly repeat payment submission.

A read-only `PaymentReconciliationMonitor` separately summarizes unresolved count, stale count, high-attempt count, oldest unresolved age, and oldest outcome ID. The default warning thresholds are five minutes unresolved or eight reconciliation attempts. Structured logs are designed for routing into deployment metrics, SIEM, paging, or alert systems; Mino does not claim a built-in vendor-specific alert transport.

## Readiness and liveness

`GET /healthz` reports process liveness. `GET /readyz` returns ready only when PostgreSQL, Redis, and Prisma are reachable. Unresolved payments do not make the HTTP data plane unready; they remain governed by reconciliation state and operational monitoring.

## Verification boundary

The production-composition integration test uses real PostgreSQL, Redis, Prisma repositories, mandate signatures, agent signatures, nonce replay protection, spend reservation state, payment outcome persistence, and audit-chain verification. The only intentionally replaced boundary is the external merchant network call.

Production-config unit coverage verifies mounted secret loading, ambiguous dual-source rejection, required-secret failure, Ed25519 validation, active audit key-pair matching, and retention of historical audit public keys.

## Still intentionally outside this slice

Remaining productionization work includes:

- direct vendor-specific KMS signing APIs where private key material never leaves an HSM/KMS boundary
- external retention for signed audit checkpoints in a separate trust domain
- vendor-specific metrics/alert transports, tracing, and operational dashboards
- broader ACP endpoint coverage and customer-facing administrative surfaces
