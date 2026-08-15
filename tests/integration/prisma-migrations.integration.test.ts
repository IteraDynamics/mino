import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";
const BASELINE_MIGRATION = "20260815050000_baseline";

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

  it("records the committed baseline as successfully applied", async () => {
    const result = await pool.query<MigrationRow>(
      `select migration_name, finished_at, rolled_back_at, logs
         from "_prisma_migrations"
        where migration_name = $1`,
      [BASELINE_MIGRATION],
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.migration_name).toBe(BASELINE_MIGRATION);
    expect(result.rows[0]?.finished_at).toBeInstanceOf(Date);
    expect(result.rows[0]?.rolled_back_at).toBeNull();
    expect(result.rows[0]?.logs).toBeNull();
  });
});
