# Database migration governance

Mino governs PostgreSQL schema changes through committed Prisma migration history under `prisma/migrations/`.

The baseline migration is:

```text
20260815050000_baseline
```

It was generated from the repository's current `prisma/schema.prisma` with the pinned Prisma 7 toolchain using `prisma migrate diff --from-empty --to-schema ... --script`, then committed for review.

## Invariants

- `prisma db push` is not the production or CI schema-provisioning path.
- Every deployable schema change must have a committed migration before application code that depends on it is deployed.
- Production/staging applies pending migrations with `prisma migrate deploy`; it does not use `migrate dev`.
- The long-running Mino runtime image does not carry the Prisma migration CLI or migration directory.
- A separate short-lived migration image owns schema-mutation authority in the container reference deployment.
- The Mino application must not start until the migration job exits successfully.
- Existing databases that predate migration history must be baselined explicitly. The baseline SQL must never be blindly replayed onto an already-populated schema.
- Failed or drifted production databases require operator review; Mino does not auto-mark migrations applied or auto-reset production data.

## Fresh database

A fresh PostgreSQL database is provisioned only from committed history:

```bash
npm run prisma:migrate:deploy
npm run prisma:migrate:status
```

CI starts with an empty PostgreSQL service and runs these commands before TypeScript/unit/integration verification. The integration suite also verifies that `_prisma_migrations` contains one successful row for `20260815050000_baseline`.

## Existing pre-migration database: one-time baseline

This path is only for a Mino database whose schema already existed before committed Prisma migration history was introduced.

### 1. Back up first

Take and verify a restorable database backup using the operational tooling appropriate to the deployment. Do not baseline a production database without a recovery point.

### 2. Verify that the live schema matches the baseline model

Configure exactly one datasource source understood by `prisma.config.ts`:

```text
DATABASE_URL
DATABASE_URL_FILE
```

Then compare the configured database to the checked-in Prisma schema:

```bash
npx prisma migrate diff \
  --exit-code \
  --from-config-datasource \
  --to-schema prisma/schema.prisma
```

Exit code `0` means Prisma found no supported schema difference. Exit code `2` means a difference exists. If a difference exists, **stop**: do not mark the baseline applied until the drift is understood and reconciled.

`migrate diff` compares Prisma-supported database features. Any intentionally deployed database objects outside the Prisma schema language (for example custom triggers/views/procedures) must be reviewed separately rather than assumed equivalent.

### 3. Mark the baseline as already applied

Only after the existing schema is verified to represent the baseline:

```bash
npx prisma migrate resolve --applied 20260815050000_baseline
```

This records the baseline in `_prisma_migrations` without executing the baseline's CREATE statements against the existing tables.

### 4. Verify migration state and apply later migrations

```bash
npm run prisma:migrate:status
npm run prisma:migrate:deploy
npm run prisma:migrate:status
```

From that point forward, the database participates in normal versioned migration history.

## Creating a new migration

For an intentional schema change, update `prisma/schema.prisma` and generate a named migration in a development environment using Prisma's development migration workflow. Review the generated SQL before committing it. The migration and application changes belong in the same governed PR when the code depends on the new schema.

Before merge, CI must prove from an empty PostgreSQL database that:

1. every committed migration applies in order;
2. migration status is current;
3. the full application test suite passes against the migrated schema;
4. the migration container contains the Prisma CLI/history;
5. the long-running runtime container does not contain migration authority.

## Container deployment order

The reference Compose deployment uses this dependency chain:

```text
PostgreSQL healthy
       ↓
short-lived `migrate` service: prisma migrate deploy
       ↓ success only
long-running `mino` service may start
```

The migration service receives only the mounted database connection secret needed for schema work. It has no Redis, merchant, signing-key, approval, audit-retention, or metrics secrets.

The migration service runs non-root with a read-only root filesystem, dropped Linux capabilities, and `no-new-privileges`, just like the long-running application baseline.

## Failure behavior

If `prisma migrate deploy` fails, the migration container exits non-zero and the reference Mino service does not start. Operators should inspect the failed migration and database state rather than bypassing the gate.

`prisma migrate resolve` is an explicit operator recovery/baselining command, not an automatic startup action. Never mark a failed migration applied merely to make deployment continue.

## Rollback strategy

Mino does not assume that every database migration has a safe automatic down migration. Application rollback and database rollback are separate operational decisions. Prefer backward-compatible expand/contract schema changes for changes that must support rolling application deployments, and take verified backups before destructive or high-risk migrations.
