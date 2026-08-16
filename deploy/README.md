# Hardened container runtime reference

This directory contains a production-like Docker Compose baseline for running the Mino service with PostgreSQL and Redis. It is a deployment reference, not a claim that Docker Compose replaces a managed orchestrator, secret manager, managed database, or managed Redis service in every production environment.

## Security posture

The long-running Mino application image:

- runs as non-root UID/GID `10001`
- contains only production dependencies and compiled application output
- does **not** contain the Prisma migration CLI or `prisma/migrations`
- excludes repository secrets, local environment files, Git metadata, coverage, and artifacts from the build context
- provides a `/healthz` container healthcheck

The short-lived `migration` image is a separate authority boundary. It retains the Prisma CLI and committed migration history, runs non-root, and exists only to execute `prisma migrate deploy` before application startup.

The Compose services additionally use read-only root filesystems, bounded tmpfs storage, dropped Linux capabilities, and `no-new-privileges` where applicable. Only the Mino application publishes a host port, bound to loopback by default.

PostgreSQL, Redis, and the migration job are attached only to the internal `backend` network and publish no host ports in the reference composition.

Redis uses `deploy/redis.conf` with AOF persistence and `maxmemory-policy noeviction`. The reference service also requires authentication. These settings matter because Mino's cold-loss reconstruction is designed for complete Redis loss/restart; arbitrary selective eviction while a reconstruction marker survives is deliberately outside that recovery claim.

## Required public environment settings

Set these before running Compose:

```text
MINO_ISSUER
MINO_MANDATE_PUBLIC_KEYS_B64_JSON
MINO_MANDATE_SIGNING_KEY_ID
MINO_DELEGATION_SIGNING_KEY_ID
MINO_AUDIT_SIGNING_KEY_ID
MINO_AUDIT_PUBLIC_KEYS_B64_JSON
MINO_APPROVAL_WEBHOOK_URL
MINO_AUDIT_CHECKPOINT_RETENTION_URL
```

`MINO_MANDATE_SIGNING_KEY_ID` must identify the active public key inside `MINO_MANDATE_PUBLIC_KEYS_B64_JSON`. Startup verifies that the mounted mandate private key is Ed25519 and derives that exact public key. Historical mandate public keys may remain in the verification map while the active signing key rotates.

Optional host-publication controls:

```text
MINO_BIND_ADDRESS       # defaults to 127.0.0.1
MINO_PUBLISHED_PORT     # defaults to 3000
MINO_DEPLOY_SECRETS_DIR # defaults to ./secrets relative to this directory
```

Binding to loopback by default prevents the reference Compose file from accidentally publishing Mino directly to every host interface. Production ingress/TLS should normally be provided by the deployment environment or reverse proxy.

## Required secret files

Create the following files under `deploy/secrets/` or the directory named by `MINO_DEPLOY_SECRETS_DIR`:

```text
database_url
redis_url
postgres_password
redis_password
mandate_private_key.pem
delegation_private_key.pem
audit_private_key.pem
approval_resolution_secret
approval_webhook_secret
merchant_credentials.json
audit_checkpoint_retention_secret
metrics_bearer_token
```

`database_url` contains the complete PostgreSQL connection URL used by both the migration job and Mino. Its password must match `postgres_password` when using the included PostgreSQL service. `prisma.config.ts` and the application both support `DATABASE_URL_FILE`; ambiguous inline-plus-file configuration fails closed.

`redis_url` contains the authenticated Redis URL used by Mino, for example `redis://:password@redis:6379`. Its password must match `redis_password` when using the included Redis service. Mino accepts this through `REDIS_URL_FILE`; configuring both Redis URL sources likewise fails closed.

Private-key files contain PEM directly. The mandate, payment-delegation, and audit signing keys are deliberately separate authority domains and must not be collapsed onto one key. HMAC/token files contain the secret text directly. `merchant_credentials.json` uses the same organization/merchant-to-Bearer mapping documented by the production runtime.

The mandate signing private key exists only so the configured runtime can issue new mandate bearer artifacts through the governed administrative issuance path. Mino does not persist raw mandate tokens and does not need historical mandate private keys merely to verify older unexpired tokens; retain the corresponding historical public keys instead for the verification lifetime you intend to support.

Never commit real files from this directory. `deploy/secrets/.gitignore` keeps the secret directory deny-by-default.

## Database migration gate

On startup Compose enforces:

```text
PostgreSQL healthy
       ↓
`migrate` service runs committed Prisma migrations
       ↓ service_completed_successfully
Mino application may start
```

If migration fails, the long-running Mino service is not started through this dependency chain. The migration service receives the database connection secret only; it does not receive Redis credentials, **mandate/delegation/audit signing keys**, merchant credentials, approval secrets, audit-retention credentials, or metrics credentials.

Fresh databases are created from committed migration history. Existing databases that predate migration history require the one-time verified baseline procedure in `docs/database-migrations.md`; do not run the baseline CREATE statements blindly against an existing production schema.

## Start

From the repository root:

```bash
docker compose -f deploy/docker-compose.runtime.yml up --build -d
```

Compose builds both the short-lived migration image and long-running runtime image. It waits for PostgreSQL, applies pending migrations, then starts Mino only if migration completes successfully.

Then check liveness/readiness from the host-bound endpoint:

```bash
curl http://127.0.0.1:3000/healthz
curl http://127.0.0.1:3000/readyz
```

Metrics require the dedicated Bearer token from `metrics_bearer_token`:

```bash
curl -H "Authorization: Bearer <metrics token>" http://127.0.0.1:3000/metrics
```

## Managed-service deployments

The Compose PostgreSQL/Redis services are replaceable boundaries. In a managed environment, point the mounted `database_url` and `redis_url` secrets at the managed services and preserve the same relevant guarantees:

- versioned migrations execute as a pre-deployment job before application code that needs them starts
- PostgreSQL durability/backups appropriate for financial control-plane state
- Redis authentication/TLS/network isolation as supported by the provider
- Redis no-eviction semantics for Mino authorization keys
- Redis persistence/replication/availability appropriate to the deployment
- independent secret management for database/Redis credentials and each signing authority

Mino still reconstructs safety-critical authorization state from PostgreSQL after complete Redis loss; persistence and replication reduce how often that recovery path is needed.
