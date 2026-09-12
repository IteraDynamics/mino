# Railway sandbox pilot #1 — deltas vs `deploy/`

This documents how the **Railway** concierge sandbox host differs from the hardened Compose reference in `deploy/`. It exists so we do **not** overclaim Compose-equivalent isolation on Railway.

Scope: sandbox pilot #1 only. Fly (or equivalent private-net shape) remains the intended path **before live money** (see `docs/PILOT_OPS_PACKAGE.md` §8).

Verified bring-up (2026-09-12): project `mino-sandbox-pilot`, app `https://mino-production-0b40.up.railway.app` (`/healthz` + `/readyz` 200).

## What stays the same (non-negotiable)

| Requirement | How we satisfy it on Railway |
| --- | --- |
| Migrate before traffic | Railway `deploy.preDeployCommand`: `npm run prisma:migrate:deploy` in the built image before traffic; image must retain Prisma CLI |
| Secrets as files | Runtime reads `*_FILE` paths; `scripts/railway-entrypoint.sh` materializes Railway-injected source vars into `/tmp/mino-secrets/*` (mode `0600`), exports `*_FILE`, **unsets** inline sources, then `exec`s Node — fail-closed dual inline+file still enforced |
| Separate signing authorities | Distinct mandate / delegation / audit private keys |
| Redis auth + `noeviction` | Managed Redis startCommand patched with `--requirepass` + `--maxmemory-policy noeviction`; live `CONFIG GET maxmemory-policy` confirms |
| HTTPS issuer + webhook/retention URLs | `MINO_ISSUER` and bridge URLs are HTTPS (app `assertHttpsUrl`) |
| Retention separate trust domain | Checkpoint receiver is **not** the Mino app service (separate `mock-bridges` HTTPS service) |
| Public bind intentional | Railway public domain only on the app (+ sandbox mocks); Postgres/Redis not publicly exposed |
| Sandbox money only | No live provider credentials on this host until §8 gates |

## Known deltas vs Compose reference

| Compose (`deploy/`) | Railway pilot #1 |
| --- | --- |
| Private `backend` network + loopback publish by default | Platform private networking between services; public HTTPS edge for the app only |
| Read-only rootfs, dropped caps, `no-new-privileges` | Railway container defaults — **not** claimed equivalent to Compose hardening |
| Secrets bind-mounted from `deploy/secrets/` | Variables → files at process start via entrypoint (same `*_FILE` contract; plaintext exists briefly in platform secret store) |
| Redis from `deploy/redis.conf` (AOF + noeviction + auth) | Auth + `noeviction` via startCommand; RDB `--save 60 1` only — **full AOF / appendfsync from compose is not applied** |
| Migration image authority-split (no app secrets on migrate) | `preDeployCommand` runs in app image; prefer DB-only vars during migrate; signing/merchant/metrics secrets are for runtime |
| Stock `Dockerfile` target `runtime` (Prisma CLI stripped) | Use `Dockerfile.railway` (keeps Prisma CLI + entrypoint) for this host |
| Local twin may use host-network workarounds | Production-shaped claim waits on Fly/private-net before live |

## Explicit non-claims

- Railway pilot #1 is **not** a drop-in substitute for the full Compose security posture.
- Passing twin drills on Eng’s computer does **not** equal Railway drills.
- GTM outreach waits on: Railway host green + Product acceptance checklist + Security sandbox comfort (live pass still later).

## Bring-up checklist (Eng)

1. Create Railway project `mino-sandbox-pilot`.
2. Add Postgres + Redis; patch Redis startCommand for auth + `noeviction`; verify live.
3. Deploy app with `Dockerfile.railway` + `scripts/railway-entrypoint.sh`; set `preDeployCommand` migrate.
4. Generate sandbox-only Ed25519 + HMAC material; never commit secrets.
5. Separate `mock-bridges` HTTPS service for approval webhook + audit retention.
6. Confirm `/healthz` + `/readyz`.
7. Re-run ops drills from `docs/PILOT_OPS_PACKAGE.md` against Railway.
8. Seed pilot org (≥2 admins) so retention + acceptance can complete.

## Related

- `docs/PILOT_OPS_PACKAGE.md`
- `docs/PILOT_ACCEPTANCE_CHECKLIST.md`
- `deploy/README.md`
- `Dockerfile.railway`
- `scripts/railway-entrypoint.sh`
