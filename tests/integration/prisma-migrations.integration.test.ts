import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";
const EXPECTED_MIGRATIONS = [
  "20260815050000_baseline",
  "20260815053000_admin_identity_rbac",
] as const;

interface MigrationRow {
  migration_name: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
  logs: string | null;
}

integration("Prisma production migration history", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("records every committed production migration as successfully applied", async () => {
    const result = await pool.query<MigrationRow>(
      `select migration_name, finished_at, rolled_back_at, logs
         from "_prisma_migrations"
        where migration_name = any($1::text[])
        order by migration_name asc`,
      [EXPECTED_MIGRATIONS],
    );

    expect(result.rows.map((row) => row.migration_name)).toEqual(EXPECTED_MIGRATIONS);
    for (const row of result.rows) {
      expect(row.finished_at).toBeInstanceOf(Date);
      expect(row.rolled_back_at).toBeNull();
      expect(row.logs).toBeNull();
    }
  });
});
