# Hardened container runtime reference

This directory contains a production-like Docker Compose baseline for running the Mino service with PostgreSQL and Redis. It is a deployment reference, not a claim that Docker Compose replaces a managed orchestrator, secret manager, managed database, or managed Redis service in every production environment.

## Security posture

The Mino application image:

- runs as non-root UID/GID `10001`
- contains only production dependencies and compiled application output in the runtime stage
- excludes repository secrets, local environment files, Git metadata, coverage, and artifacts from the build context
- provides a `/healthz` container healthcheck

The Compose service additionally:

- uses a read-only root filesystem
- drops all Linux capabilities
- enables `no-new-privileges`
- uses a bounded `/tmp` tmpfs
- exposes only the Mino HTTP port
- binds that port to host loopback by default
- receives sensitive runtime values through mounted secret files

PostgreSQL and Redis are attached only to the internal `backend` network and publish no host ports in the reference composition. The application is the only service attached to both frontend and backend networks.

Redis uses `deploy/redis.conf` with AOF persistence and `maxmemory-policy noeviction`. The reference service also requires authentication. These settings matter because Mino's cold-loss reconstruction is designed for complete Redis loss/restart; arbitrary selective eviction while a reconstruction marker survives is deliberately outside that recovery claim.

## Required public environment settings

Set these before running Compose:

```text
MINO_ISSUER
MINO_MANDATE_PUBLIC_KEYS_B64_JSON
MINO_DELEGATION_SIGNING_KEY_ID
MINO_AUDIT_SIGNING_KEY_ID
MINO_AUDIT_PUBLIC_KEYS_B64_JSON
MINO_APPROVAL_WEBHOOK_URL
MINO_AUDIT_CHECKPOINT_RETENTION_URL
```

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
delegation_private_key.pem
audit_private_key.pem
approval_resolution_secret
approval_webhook_secret
merchant_credentials.json
audit_checkpoint_retention_secret
metrics_bearer_token
```

`database_url` contains the complete PostgreSQL connection URL used by Mino. Its password must match `postgres_password` when using the included PostgreSQL service. Mino accepts this through `DATABASE_URL_FILE`; configuring both `DATABASE_URL` and `DATABASE_URL_FILE` fails closed.

`redis_url` contains the authenticated Redis URL used by Mino, for example `redis://:password@redis:6379`. Its password must match `redis_password` when using the included Redis service. Mino accepts this through `REDIS_URL_FILE`; configuring both Redis URL sources likewise fails closed.

Private-key files contain PEM directly. HMAC/token files contain the secret text directly. `merchant_credentials.json` uses the same organization/merchant-to-Bearer mapping documented by the production runtime.

Never commit real files from this directory. `deploy/secrets/.gitignore` keeps the secret directory deny-by-default.

## Database schema prerequisite

This container-runtime slice does not invent a database migration policy. The target PostgreSQL database must already contain the schema expected by the deployed Mino build. The follow-on governed migration slice replaces that prerequisite with versioned `prisma migrate deploy` execution before application startup.

## Start

From the repository root:

```bash
docker compose -f deploy/docker-compose.runtime.yml up --build -d
```

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

- PostgreSQL durability/backups appropriate for financial control-plane state
- Redis authentication/TLS/network isolation as supported by the provider
- Redis no-eviction semantics for Mino authorization keys
- Redis persistence/replication/availability appropriate to the deployment
- independent secret management for database/Redis credentials

Mino still reconstructs safety-critical authorization state from PostgreSQL after complete Redis loss; persistence and replication reduce how often that recovery path is needed.
