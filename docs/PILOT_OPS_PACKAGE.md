# Mino hosted pilot ops / release package (P0)

This is the supportable ops package for a **concierge design-partner pilot**, not a public self-serve SaaS launch.

Objective: one external design partner can run a Mino-governed **sandbox** economic action on a hosted org we operate, with credible stay-on ops (backup, recovery, monitoring, upgrade, sandbox to live criteria).

Related:

- product bar: `docs/PILOT_READINESS_ROADMAP.md`
- runtime composition: `docs/production-runtime.md`
- container baseline: `deploy/README.md`
- acceptance script: `docs/PILOT_ACCEPTANCE_CHECKLIST.md`
- verification gate: GitHub Actions `verification.yml` + `docs/verification-gate.md`

## Pilot shape (ops constraints)

- one design partner;
- one Mino organization;
- at least 2 human administrators (four-eyes real);
- 1-2 agents;
- one concrete economic workflow;
- one execution/payment provider from the partner stack;
- **sandbox/test money first**;
- tightly bounded live money only after sandbox acceptance + Security sign-off.

Mino is operated as a **hosted** service for the first pilot. Self-host is deliberately not a prerequisite.

## Authority split

| Role | Owns |
| --- | --- |
| Eng | This package accuracy vs `main`, deployability, drills, CI gate green |
| Product | Pilot wedge + acceptance script narrative |
| Security | Live-money threat pass; sandbox to live gate |
| GTM | Outreach only after this package is real |
| Company lead (Mino) | Priority conflicts |

**Never** take real financial actions from ops docs alone. Live credentials and live cutover require explicit founder + Security sign-off.

---

## 1. Hosted pilot deploy / runbook

### Reference topology

Use the hardened Compose baseline as the starting topology; replace Postgres/Redis with managed services when the pilot environment warrants it:

```bash
# from repository root, on the pilot host / CI runner
docker compose -f deploy/docker-compose.runtime.yml up --build -d
```

Startup dependency (fail-closed):

```text
PostgreSQL healthy
       then
short-lived migration image: prisma migrate deploy
       success only then
long-running Mino service may start
```

Optional overlays when the pilot wedge needs them:

- `deploy/docker-compose.admin-auth.yml` — enterprise admin JWT ingress + console
- `deploy/docker-compose.personal-auth.yml` — Mino Personal JWT ingress

### Pre-flight

1. Confirm `main` HEAD SHA and that GitHub `verification.yml` is green for that SHA.
2. Provision secrets directory (see section 2); never commit real secret files.
3. Set public env: `MINO_ISSUER`, mandate/delegation/audit key IDs + public key maps, approval webhook URL, audit checkpoint retention URL.
4. Bind publish address intentionally (`MINO_BIND_ADDRESS` defaults to loopback in the reference Compose file).
5. Confirm Redis policy: authentication + AOF + `noeviction` (see `deploy/redis.conf`).

### Bring-up checklist

```bash
curl -fsS http://127.0.0.1:3000/healthz
curl -fsS http://127.0.0.1:3000/readyz
# metrics only if configured:
curl -fsS -H "Authorization: Bearer <metrics token>" http://127.0.0.1:3000/metrics
```

`/readyz` must be ready (Postgres + Prisma + Redis). Unresolved payments or checkpoint-retention lag do **not** flip readiness; they surface via ops monitoring (section 5).

### Smoke (non-money)

1. Admin JWT ingress: `GET /v1/admin/organizations/:organizationId/access` returns expected permissions for both pilot admins.
2. Console loads at `/console` only when admin ingress is enabled.
3. Agent kit or Personal skill can form a signed request against the pilot base URL without using live provider credentials.

Money-path smoke belongs in `docs/PILOT_ACCEPTANCE_CHECKLIST.md` and uses **sandbox** credentials only.

---

## 2. Secret provisioning and rotation

### Inventory (reference Compose mounts)

Under `deploy/secrets/` (or `MINO_DEPLOY_SECRETS_DIR`):

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

Additional pilot surfaces (when enabled):

- Admin JWT trusted issuers / keys (admin auth overlay)
- Personal JWT issuers (`MINO_PERSONAL_JWT_ISSUERS_JSON` and overlay)
- Stripe (or other provider) **sandbox** credentials — server-side only, file-mounted when possible; never agent-supplied

Rules from production composition:

- Prefer `*_FILE` mounted secrets over inline env for sensitive values.
- Configuring both inline and file for the same secret **fails closed** at startup.
- Mandate, delegation, and audit private keys are **separate** authority domains — do not collapse onto one key.
- Public verification maps may retain historical public keys; private keys for verification history are not required.

### Provisioning procedure

1. Generate Ed25519 key pairs for mandate, delegation, and audit in the external secret system.
2. Populate public key JSON maps and active key IDs in non-secret config.
3. Mount private PEMs and HMAC secrets as regular files readable only by the runtime UID.
4. Populate `merchant_credentials.json` / provider sandbox credentials only for registered pilot targets.
5. Start Mino; confirm startup key validation succeeds (active audit private key must match public map entry).

### Rotation procedure (controlled rolling restart)

Mino does **not** claim in-process hot key replacement. Rotate via external secret update + rolling restart.

**Audit signing key (safe pattern):**

1. Generate new Ed25519 pair externally.
2. Add new public key to `MINO_AUDIT_PUBLIC_KEYS_B64_JSON` while retaining historical keys needed for verification.
3. Stage new private PEM.
4. Point `MINO_AUDIT_SIGNING_KEY_ID` at the new ID.
5. Rolling restart; each process validates key match before traffic.
6. Retain old public keys for as long as historical rows must verify.

**Mandate / delegation keys:** change active key ID + private material together during a controlled deploy; keep historical mandate public keys for unexpired token verification lifetime.

**HMAC / metrics / retention / provider credentials:** mint new secret, dual-run or cutover window as the downstream bridge allows, restart, revoke old secret after confirmation.

**After any rotation:** re-run `/readyz`, spot-check admin access, and verify one recent transaction + admin audit chain (`audit.verify`) still passes.

---

## 3. PostgreSQL backup and restore

Pilot control-plane state is financial authority state. Treat Postgres as the durability root.

### Backup

Minimum for hosted pilot:

1. Automated logical backups (e.g. `pg_dump` or managed provider snapshots) at least daily, retained at least 30 days for pilot.
2. Pre-upgrade and pre-live-cutover on-demand snapshot.
3. Store backups outside the primary failure domain; encrypt at rest.
4. Record backup ID, UTC timestamp, and `main` SHA / image digest that produced the schema.

Schema changes only via committed Prisma migrations (`npm run prisma:migrate:deploy`). Never `db push` in pilot/prod.

### Restore drill (required before first partner money path)

1. Restore backup into an isolated recovery instance (not the live writer).
2. Run `npm run prisma:migrate:status` (or equivalent) against restored DB; confirm no unexpected drift.
3. Point a **non-serving** Mino instance at the restored DB + fresh empty Redis.
4. Confirm startup reconstruction completes and `/readyz` is ready.
5. Verify transaction and administrative audit chains for the pilot org (`audit.verify`).
6. Document restore RTO/RPO observed; file gaps as eng follow-ups before live.

Fail closed: do not promote a restored primary until migration status and audit verify succeed.

---

## 4. Redis loss / reconstruction drill

Redis is the atomic concurrency boundary; Postgres mirrors safety-critical spend facts. Reconstruction targets **complete Redis loss**, not selective eviction (hence `noeviction`).

### Drill steps

1. On a staging/pilot twin with known durable reservations / unresolved outcomes:
   - flush or replace Redis with empty authenticated instance (same `noeviction` + auth posture);
   - keep Postgres untouched.
2. Restart Mino (or trigger next guarded authorization op).
3. Expect: startup `reconstructAll()` and/or per-mandate lazy reconstruction; missing reconstruction marker fails closed until rebuild succeeds.
4. Confirm: recent committed spend, active reservations, unresolved payment holds, and velocity facts are restored from Postgres; unresolved outcomes keep reconciliation holds.
5. Confirm: a new sandbox authorization either succeeds under reconstructed limits or fails closed — never silently overspends.

Record drill date, operator, and outcome in the pilot ops log.

---

## 5. Monitoring and actionable alerts

### Built-in signals

- `GET /healthz` — process liveness
- `GET /readyz` — Postgres + Prisma + Redis reachability
- Optional `GET /metrics` — low-cardinality durable-state gauges (dedicated Bearer; no customer/transaction IDs as labels)
- Structured logs from:
  - payment reconciliation / `PaymentReconciliationMonitor` (default warn: about 5 minutes unresolved or about 8 attempts)
  - approval notification delivery failures / dead-letter
  - audit-checkpoint retention export failures

### Alert routing (pilot minimum)

Wire deployment logs/metrics into whatever pager the founder uses. Minimum actionable alerts:

| Signal | Severity | Action |
| --- | --- | --- |
| `/readyz` failing over 2m | P1 | Page eng; do not take money traffic |
| Migration job failed / app not started | P1 | Block deploy; fix schema/secrets |
| Unresolved payment age over 5m or attempts at least 8 | P1 | Investigate provider/merchant truth; **do not** invent terminal outcome |
| Approval webhook dead-letter growth | P2 | Fix bridge; humans may be missing approvals |
| Checkpoint retention export failing | P2 | Fix retention bridge; authorization continues but independent evidence lags |
| Audit verify failure | P1 | Freeze sensitive admin mutations; escalate Security |

Mino does not ship a vendor-specific alert transport; the pilot host must attach one.

---

## 6. Audit-checkpoint retention procedure

1. Configure HTTPS retention URL + at least 32-char HMAC secret (file-mounted preferred).
2. Retention worker exports signed chain-head checkpoints at-least-once with deterministic event IDs; receiver must durable-dedupe.
3. Receiver must be a **separate trust domain** (WORM/object-lock or independently controlled archive).
4. Ops verification: after pilot activity, confirm retained event IDs exist externally and `audit.verify` (DB + retained checkpoint) succeeds for the org.
5. On retention outage: authorization may continue; treat missing independent anchors as an ops defect before live promotion.

---

## 7. Upgrade / rollback

### Upgrade

1. Note current image digest / git SHA and take Postgres snapshot.
2. Ensure `verification.yml` green on the candidate SHA.
3. Run migrations via the short-lived migration image/job **before** new app traffic (`service_completed_successfully` gate).
4. Rolling restart app image; confirm `/readyz`, admin access, and one sandbox acceptance smoke.
5. Record change in pilot ops log.

### Rollback

1. If app-only regression and schema compatible: redeploy previous app image; confirm `/readyz`.
2. If migration already applied: **do not** casually reverse migrations against financial state. Restore from pre-upgrade snapshot into a controlled recovery path (section 3) or forward-fix with a new eng PR.
3. Provider credentials stay sandbox unless this was an approved live window — never roll forward into live to unblock an upgrade failure.

---

## 8. Sandbox to live promotion criteria

Live money is **not** implied by merging code or by a successful sandbox PaymentIntent.

All of the following are required:

1. P0 ops package drills completed: backup restore, Redis reconstruction, alert routing verified.
2. `docs/PILOT_ACCEPTANCE_CHECKLIST.md` fully passed on **sandbox** for the partner wedge.
3. Security live-money pass on the P0/P1 surfaces actually enabled (admin, Personal, provider adapter, consequence fence / `providerBindingDigest` handling).
4. Explicit founder confirmation to use live provider credentials.
5. Separate live credential mounts (never reuse sandbox secrets); livemode binding enforced by adapter.
6. Tight amount caps, closely watched reconciliation alerts, and a documented abort (revoke mandates / suspend agent / disable provider target).
7. Incident owner named and reachable for the live window.

Until then: sandbox credentials only.

---

## 9. Incident / support ownership

| Severity | Examples | Owner |
| --- | --- | --- |
| SEV1 | Readyz down; suspected overspend; audit verify fail; live money unexpected | Eng primary, Security consulted, founder notified |
| SEV2 | Reconciliation stuck; approval notify dead; retention outage | Eng |
| SEV3 | Docs drift; non-blocking debt | Eng / Product |

Concierge support for the design partner goes through GTM and Eng; partners do not get database access.

**Forbidden during incidents:** force-success payment outcomes, manual allowance release outside governed codepaths, rewriting audit history, or bypassing four-eyes for mandate issue / policy activate.

---

## 10. Pilot acceptance

Execute `docs/PILOT_ACCEPTANCE_CHECKLIST.md` on the hosted sandbox org before any outreach claim that Mino is "pilot ready."

---

## Out of scope for this package

- Billing / public signup
- Broad provider catalog
- Self-host as partner prerequisite
- Vendor KMS/HSM signing APIs
- Compliance certifications for appearance
- Live money without Security + founder sign-off
