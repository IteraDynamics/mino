import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type QueryResultRow } from "pg";
import {
  BeginPaymentOutcomeKind,
  PaymentOutcomeStatus,
  PostgresPaymentOutcomeStore,
  type SqlClient,
} from "../../src/modules/payments/payment-outcome.store.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";

const ids = {
  organization: "10000000-0000-4000-8000-000000000001",
  user: "10000000-0000-4000-8000-000000000002",
  agent: "10000000-0000-4000-8000-000000000003",
  policy: "10000000-0000-4000-8000-000000000004",
  mandate: "10000000-0000-4000-8000-000000000005",
};
const now = new Date("2026-08-14T14:00:00.000Z");

integration("PostgresPaymentOutcomeStore", () => {
  let pool: Pool;
  let store: PostgresPaymentOutcomeStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const sql: SqlClient = {
      async query<R extends QueryResultRow>(text: string, values?: unknown[]) {
        const result = await pool.query<R>(text, values);
        return { rows: result.rows, rowCount: result.rowCount };
      },
    };
    store = new PostgresPaymentOutcomeStore(sql);
  });

  beforeEach(async () => {
    await pool.query('delete from "PaymentOutcome"');
    await pool.query('delete from "AgentMandate" where "id" = $1::uuid', [ids.mandate]);
    await pool.query('delete from "Policy" where "id" = $1::uuid', [ids.policy]);
    await pool.query('delete from "AgentIdentity" where "id" = $1::uuid', [ids.agent]);
    await pool.query('delete from "User" where "id" = $1::uuid', [ids.user]);
    await pool.query('delete from "Organization" where "id" = $1::uuid', [ids.organization]);

    await pool.query(
      `insert into "Organization" ("id", "name", "createdAt", "updatedAt")
       values ($1::uuid, 'Outcome Test Org', $2, $2)`,
      [ids.organization, now],
    );
    await pool.query(
      `insert into "User" ("id", "organizationId", "email", "status", "createdAt", "updatedAt")
       values ($1::uuid, $2::uuid, 'outcome@example.test', 'ACTIVE', $3, $3)`,
      [ids.user, ids.organization, now],
    );
    await pool.query(
      `insert into "AgentIdentity" (
         "id", "organizationId", "externalAgentId", "status", "createdAt", "updatedAt"
       ) values ($1::uuid, $2::uuid, 'outcome-agent', 'ACTIVE', $3, $3)`,
      [ids.agent, ids.organization, now],
    );
    await pool.query(
      `insert into "Policy" (
         "id", "organizationId", "name", "version", "active", "baseCurrency",
         "maxBudgetMinor", "rollingDailyLimitMinor", "approvedMerchantDomains",
         "approvedVendorIds", "restrictedCategories", "approvalMode",
         "maxTransactionsPerMinute", "crossMerchantWindowSecs", "maxDistinctMerchants",
         "createdAt", "updatedAt"
       ) values (
         $1::uuid, $2::uuid, 'Outcome Policy', 1, true, 'USD',
         10000, 20000, array['merchant.example'], array[]::text[], array[]::text[], 'AUTO_APPROVE',
         10, 60, 5, $3, $3
       )`,
      [ids.policy, ids.organization, now],
    );
    await pool.query(
      `insert into "AgentMandate" (
         "id", "organizationId", "userId", "agentId", "policyId", "tokenJtiHash",
         "policyVersion", "currency", "maxBudgetMinor", "rollingDailyLimitMinor",
         "approvedMerchantDomains", "approvedVendorIds", "restrictedCategories", "approvalMode",
         "maxTransactionsPerMinute", "crossMerchantWindowSecs", "maxDistinctMerchants",
         "delegationPayloadHash", "signingKeyId", "status", "issuedAt", "expiresAt"
       ) values (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'outcome-jti-hash',
         1, 'USD', 10000, 20000,
         array['merchant.example'], array[]::text[], array[]::text[], 'AUTO_APPROVE',
         10, 60, 5, 'delegation-hash', 'mino-k1', 'ACTIVE', $6, $7
       )`,
      [
        ids.mandate,
        ids.organization,
        ids.user,
        ids.agent,
        ids.policy,
        now,
        new Date(now.getTime() + 3600000),
      ],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  function beginInput(args: {
    id: string;
    reservationId: string;
    digest?: string;
    key?: string;
    providerBindingDigest?: string;
    checkoutSessionId?: string;
  }) {
    return {
      id: args.id,
      organizationId: ids.organization,
      userId: ids.user,
      agentId: ids.agent,
      mandateId: ids.mandate,
      reservationId: args.reservationId,
      idempotencyKey: args.key ?? "idem-outcome-1",
      requestDigest: args.digest ?? "digest-1",
      providerBindingDigest: args.providerBindingDigest ?? "provider-binding-1",
      merchantId: "merchant-1",
      merchantDomain: "merchant.example",
      checkoutSessionId: args.checkoutSessionId ?? "cs_1",
      amountMinor: 5000n,
      currency: "USD",
      now,
    };
  }

  it("creates one durable outcome and distinguishes replay from idempotency conflict", async () => {
    const first = await store.begin(
      beginInput({
        id: "10000000-0000-4000-8000-000000000006",
        reservationId: "reservation-1",
      }),
    );
    const replay = await store.begin(
      beginInput({
        id: "10000000-0000-4000-8000-000000000007",
        reservationId: "reservation-2",
      }),
    );
    const conflict = await store.begin(
      beginInput({
        id: "10000000-0000-4000-8000-000000000008",
        reservationId: "reservation-3",
        digest: "different-digest",
      }),
    );

    expect(first.kind).toBe(BeginPaymentOutcomeKind.CREATED);
    expect(first.outcome.providerBindingDigest).toBe("provider-binding-1");
    expect(replay.kind).toBe(BeginPaymentOutcomeKind.EXISTING);
    expect(replay.outcome.id).toBe(first.outcome.id);
    expect(conflict.kind).toBe(BeginPaymentOutcomeKind.CONFLICT);
  });

  it("fences the same external provider consequence across different Mino idempotency keys", async () => {
    const first = await store.begin(
      beginInput({
        id: "10000000-0000-4000-8000-000000000011",
        reservationId: "reservation-consequence-1",
        key: "idem-consequence-1",
      }),
    );
    const conflict = await store.begin(
      beginInput({
        id: "10000000-0000-4000-8000-000000000012",
        reservationId: "reservation-consequence-2",
        key: "idem-consequence-2",
      }),
    );

    expect(first.kind).toBe(BeginPaymentOutcomeKind.CREATED);
    expect(conflict.kind).toBe(BeginPaymentOutcomeKind.CONFLICT);
    expect(conflict.outcome.id).toBe(first.outcome.id);

    const count = await pool.query<{ count: string }>(
      `select count(*)::text as "count"
         from "PaymentOutcome"
        where "organizationId" = $1::uuid
          and "merchantId" = 'merchant-1'
          and "checkoutSessionId" = 'cs_1'`,
      [ids.organization],
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("persists unknown transport state and later resolves it to success", async () => {
    const first = await store.begin(
      beginInput({
        id: "10000000-0000-4000-8000-000000000009",
        reservationId: "reservation-4",
        key: "idem-outcome-2",
      }),
    );
    const unknownAt = new Date(now.getTime() + 1000);
    const succeededAt = new Date(now.getTime() + 2000);

    const unknown = await store.markUnknown(first.outcome.id, {
      errorCode: "MERCHANT_TRANSPORT_FAILURE",
      now: unknownAt,
    });
    const succeeded = await store.markSucceeded(
      first.outcome.id,
      {
        status: 200,
        body: { id: "cs_1", status: "completed", order: { id: "order-1" } },
        headers: { "request-id": "merchant-request-1" },
      },
      succeededAt,
    );
    const reconciled = await store.markReconciled(first.outcome.id, succeededAt);

    expect(unknown.status).toBe(PaymentOutcomeStatus.UNKNOWN);
    expect(unknown.lastErrorCode).toBe("MERCHANT_TRANSPORT_FAILURE");
    expect(succeeded.status).toBe(PaymentOutcomeStatus.SUCCEEDED);
    expect(succeeded.response?.status).toBe(200);
    expect(reconciled.lastReconciledAt).toEqual(succeededAt);
  });

  it("does not allow a succeeded outcome to transition to definitive failure", async () => {
    const first = await store.begin(
      beginInput({
        id: "10000000-0000-4000-8000-000000000010",
        reservationId: "reservation-5",
        key: "idem-outcome-3",
      }),
    );
    await store.markSucceeded(first.outcome.id, { status: 200, body: { status: "completed" } }, now);

    await expect(
      store.markDefinitiveFailure(first.outcome.id, { status: 400, body: { error: "declined" } }, now),
    ).rejects.toThrow(/state transition/i);
  });
});
