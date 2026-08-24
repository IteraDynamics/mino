import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type QueryResultRow } from "pg";
import {
  PaymentReconciliationMonitor,
  paymentReconciliationNeedsAttention,
  type PaymentReconciliationMonitorSqlClient,
} from "../../src/modules/payments/payment-reconciliation-monitor.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";
const now = new Date("2026-08-14T18:00:00.000Z");
const ids = {
  organization: "80000000-0000-4000-8000-000000000001",
  user: "80000000-0000-4000-8000-000000000002",
  agent: "80000000-0000-4000-8000-000000000003",
  policy: "80000000-0000-4000-8000-000000000004",
  mandate: "80000000-0000-4000-8000-000000000005",
};

integration("PaymentReconciliationMonitor", () => {
  let pool: Pool;
  let monitor: PaymentReconciliationMonitor;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const sql: PaymentReconciliationMonitorSqlClient = {
      async query<R extends QueryResultRow>(text: string, values?: unknown[]) {
        const result = await pool.query<R>(text, values);
        return { rows: result.rows, rowCount: result.rowCount };
      },
    };
    monitor = new PaymentReconciliationMonitor(sql, {
      staleAfterMs: 5 * 60 * 1000,
      highAttemptThreshold: 3,
    });
  });

  beforeEach(async () => {
    // The production monitor is deliberately global, so this fixture must own
    // the global unresolved-payment table state when asserting exact counts.
    // Integration files run serially through the repository test script.
    await pool.query('delete from "PaymentOutcome"');
    await pool.query('delete from "AgentMandate" where "id" = $1::uuid', [ids.mandate]);
    await pool.query('delete from "Policy" where "id" = $1::uuid', [ids.policy]);
    await pool.query('delete from "AgentIdentity" where "id" = $1::uuid', [ids.agent]);
    await pool.query('delete from "User" where "id" = $1::uuid', [ids.user]);
    await pool.query('delete from "Organization" where "id" = $1::uuid', [ids.organization]);

    await pool.query(
      `insert into "Organization" ("id", "name", "createdAt", "updatedAt") values ($1::uuid, 'Monitor Org', $2, $2)`,
      [ids.organization, now],
    );
    await pool.query(
      `insert into "User" ("id", "organizationId", "email", "status", "createdAt", "updatedAt") values ($1::uuid, $2::uuid, 'monitor@example.test', 'ACTIVE', $3, $3)`,
      [ids.user, ids.organization, now],
    );
    await pool.query(
      `insert into "AgentIdentity" ("id", "organizationId", "externalAgentId", "status", "createdAt", "updatedAt") values ($1::uuid, $2::uuid, 'monitor-agent', 'ACTIVE', $3, $3)`,
      [ids.agent, ids.organization, now],
    );
    await pool.query(
      `insert into "Policy" ("id", "organizationId", "name", "version", "active", "baseCurrency", "maxBudgetMinor", "rollingDailyLimitMinor", "approvedMerchantDomains", "approvedVendorIds", "restrictedCategories", "approvalMode", "maxTransactionsPerMinute", "crossMerchantWindowSecs", "maxDistinctMerchants", "createdAt", "updatedAt") values ($1::uuid, $2::uuid, 'Monitor Policy', 1, true, 'USD', 10000, 20000, array['merchant.example'], array[]::text[], array[]::text[], 'AUTO_APPROVE', 10, 60, 5, $3, $3)`,
      [ids.policy, ids.organization, now],
    );
    await pool.query(
      `insert into "AgentMandate" ("id", "organizationId", "userId", "agentId", "policyId", "tokenJtiHash", "policyVersion", "currency", "maxBudgetMinor", "rollingDailyLimitMinor", "approvedMerchantDomains", "approvedVendorIds", "restrictedCategories", "approvalMode", "maxTransactionsPerMinute", "crossMerchantWindowSecs", "maxDistinctMerchants", "delegationPayloadHash", "signingKeyId", "status", "issuedAt", "expiresAt") values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'monitor-jti', 1, 'USD', 10000, 20000, array['merchant.example'], array[]::text[], array[]::text[], 'AUTO_APPROVE', 10, 60, 5, 'monitor-delegation', 'mino-k1', 'ACTIVE', $6, $7)`,
      [ids.mandate, ids.organization, ids.user, ids.agent, ids.policy, now, new Date(now.getTime() + 3_600_000)],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it("reports an empty healthy snapshot when no payments are unresolved", async () => {
    const snapshot = await monitor.snapshot(now);
    expect(snapshot).toMatchObject({ unresolved: 0, stale: 0, highAttempt: 0, oldestAgeMs: 0 });
    expect(paymentReconciliationNeedsAttention(snapshot)).toBe(false);
  });

  it("flags aged and repeatedly retried unresolved outcomes", async () => {
    await insertOutcome("80000000-0000-4000-8000-000000000006", "UNKNOWN", new Date(now.getTime() - 600_000), 4);
    await insertOutcome("80000000-0000-4000-8000-000000000007", "UNKNOWN", new Date(now.getTime() - 60_000), 1);

    const snapshot = await monitor.snapshot(now);
    expect(snapshot.unresolved).toBe(2);
    expect(snapshot.stale).toBe(1);
    expect(snapshot.highAttempt).toBe(1);
    expect(snapshot.oldestAgeMs).toBe(600_000);
    expect(snapshot.oldestOutcomeId).toBe("80000000-0000-4000-8000-000000000006");
    expect(paymentReconciliationNeedsAttention(snapshot)).toBe(true);
  });

  it("excludes terminal payment outcomes from operational attention", async () => {
    await insertOutcome("80000000-0000-4000-8000-000000000008", "SUCCEEDED", new Date(now.getTime() - 900_000), 12);
    await insertOutcome("80000000-0000-4000-8000-000000000009", "FAILED_DEFINITIVE", new Date(now.getTime() - 900_000), 12);

    const snapshot = await monitor.snapshot(now);
    expect(snapshot.unresolved).toBe(0);
    expect(paymentReconciliationNeedsAttention(snapshot)).toBe(false);
  });

  async function insertOutcome(id: string, status: string, createdAt: Date, attempts: number): Promise<void> {
    await pool.query(
      `insert into "PaymentOutcome" (
         "id", "organizationId", "userId", "agentId", "mandateId", "reservationId",
         "idempotencyKey", "requestDigest", "merchantId", "merchantDomain", "checkoutSessionId",
         "amountMinor", "currency", "status", "reconcileAttempts", "forwardedAt", "createdAt", "updatedAt"
       ) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, 'digest', 'merchant-1', 'merchant.example', $8, 5000, 'USD', $9::"PaymentOutcomeStatus", $10, $11, $11, $11)`,
      [id, ids.organization, ids.user, ids.agent, ids.mandate, `reservation-${id}`, `idem-${id}`, `checkout-${id}`, status, attempts, createdAt],
    );
  }
});
