import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PgSqlAdapter } from "../../src/infrastructure/postgres/pg-sql-adapter.js";
import { PostgresOperationalMetrics } from "../../src/operations/postgres-operational-metrics.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";

integration("PostgresOperationalMetrics", () => {
  let pool: Pool;
  let metrics: PostgresOperationalMetrics;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
    metrics = new PostgresOperationalMetrics(new PgSqlAdapter(pool));
  });

  afterAll(async () => {
    await pool.end();
  });

  it("returns a non-negative internally consistent snapshot from the real schema", async () => {
    const now = new Date();
    const snapshot = await metrics.snapshot(now);

    expect(snapshot.capturedAt).toEqual(now);
    expect(snapshot.unresolvedPayments).toBe(
      snapshot.payments.FORWARDING + snapshot.payments.UNKNOWN,
    );
    expect(snapshot.oldestUnresolvedPaymentAgeSeconds).toBeGreaterThanOrEqual(0);

    const allCounts = [
      ...Object.values(snapshot.auditDecisions),
      ...Object.values(snapshot.approvals),
      ...Object.values(snapshot.payments),
      ...Object.values(snapshot.spendReservations),
      snapshot.auditOrganizations,
      snapshot.unresolvedPayments,
    ];
    for (const count of allCounts) {
      expect(count).toBeGreaterThanOrEqual(0n);
    }
  });
});
