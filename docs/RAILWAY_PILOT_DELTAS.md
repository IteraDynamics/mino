# Railway sandbox pilot #1 — deltas vs `deploy/`

This documents how the **Railway** concierge sandbox host differs from the hardened Compose reference in `deploy/`. It exists so we do **not** overclaim Compose-equivalent isolation on Railway.

Scope: sandbox pilot #1 only. Fly (or equivalent private-net shape) remains the intended path **before live money** (see `docs/PILOT_OPS_PACKAGE.md` §8).

## What stays the same (non-negotiable)

| Requirement | How we satisfy it on Railway |
| --- | --- |
| Migrate before traffic | Dedicated one-shot **migrate** service / pre-deploy job runs `prisma migrate deploy`; app service depends on successful migrate |
| Secrets as files | Runtime reads `*_FILE` paths; start command materializes Railway variables into `/run/secrets/*` (mode `0600`) then `exec`s Node — app config still fail-closed on dual inline+file |
| Separate signing authorities | Distinct mandate / delegation / audit private keys |
| Redis auth + `noeviction` | Managed Redis with `requirepass` (or ACL) and `maxmemory-policy noeviction` verified at bring-up |
| HTTPS issuer + webhook/retention URLs | `MINO_ISSUER` and bridge URLs are HTTPS |
| Retention separate trust domain | Checkpoint receiver is **not** the Mino app service (external HTTPS bridge) |
| Public bind intentional | Railway public domain only on the app service; Postgres/Redis not publicly exposed |
| Sandbox money only | No live provider credentials on this host until §8 gates |

## Known deltas vs Compose reference

| Compose (`deploy/`) | Railway pilot #1 |
| --- | --- |
| Private `backend` network + loopback publish by default | Platform private networking between services; public HTTPS edge for the app only |
| Read-only rootfs, dropped caps, `no-new-privileges` | Railway container defaults — **not** claimed equivalent to Compose hardening |
| Secrets bind-mounted from `deploy/secrets/` | Variables → files at process start (same `*_FILE` contract; plaintext exists briefly in platform secret store) |
| Redis from `deploy/redis.conf` | Managed Redis; we verify auth + `noeviction` rather than shipping our conf file verbatim |
| Migration image authority-split (no app secrets on migrate) | Migrate job gets **database URL only**; signing/merchant/metrics secrets stay on the app service |
| Local twin may use host-network workarounds | Production-shaped claim waits on Fly/private-net before live |

## Explicit non-claims

- Railway pilot #1 is **not** a drop-in substitute for the full Compose security posture.
- Passing twin drills on Eng’s computer does **not** equal Railway drills.
- GTM outreach waits on: Railway host green + Product acceptance checklist + Security sandbox comfort (live pass still later).

## Bring-up checklist (Eng)

1. Create Railway project `mino-pilot-sandbox`.
2. Add Postgres + Redis; lock Redis policy.
3. Add migrate service (DB URL only) and app service (full `*_FILE` set).
4. Generate sandbox-only Ed25519 + HMAC material; never commit secrets.
5. Deploy migrate → app; confirm `/healthz` + `/readyz`.
6. Re-run ops drills from `docs/PILOT_OPS_PACKAGE.md` against Railway.
7. Seed pilot org (≥2 admins) so retention + acceptance can complete.

## Related

- `docs/PILOT_OPS_PACKAGE.md`
- `docs/PILOT_ACCEPTANCE_CHECKLIST.md`
- `deploy/README.md`
