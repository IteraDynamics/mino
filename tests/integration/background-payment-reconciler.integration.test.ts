import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type QueryResultRow } from "pg";
import {
  BackgroundPaymentReconciler,
} from "../../src/modules/payments/background-payment-reconciler.js";
import {
  PaymentOutcomeStatus,
  PostgresPaymentOutcomeStore,
  type SqlClient,
} from "../../src/modules/payments/payment-outcome.store.js";
import type {
  ACPMerchantClient,
  MerchantEndpoint,
  MerchantResponse,
} from "../../src/modules/proxy/merchant-client.js";
import type {
  AuthorizationReservations,
  ReservationAttemptInput,
  ReservationAttemptResult,
} from "../../src/modules/spending/authorization-reservation.service.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";

const ids = {
  organization: "20000000-0000-4000-8000-000000000001",
  user: "20000000-0000-4000-8000-000000000002",
  agent: "20000000-0000-4000-8000-000000000003",
  policy: "20000000-0000-4000-8000-000000000004",
  mandate: "20000000-0000-4000-8000-000000000005",
};
const now = new Date("2026-08-14T15:00:00.000Z");

integration("BackgroundPaymentReconciler", () => {
  let pool: Pool;
  let store: PostgresPaymentOutcomeStore;
  let sequence = 0;

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
    sequence = 0;
    await pool.query('delete from "PaymentOutcome"');
    await pool.query('delete from "AgentMandate" where "id" = $1::uuid', [ids.mandate]);
    await pool.query('delete from "Policy" where "id" = $1::uuid', [ids.policy]);
    await pool.query('delete from "AgentIdentity" where "id" = $1::uuid', [ids.agent]);
    await pool.query('delete from "User" where "id" = $1::uuid', [ids.user]);
    await pool.query('delete from "Organization" where "id" = $1::uuid', [ids.organization]);

    await pool.query(
      `insert into "Organization" ("id", "name", "createdAt", "updatedAt")
       values ($1::uuid, 'Reconciler Test Org', $2, $2)`,
      [ids.organization, now],
    );
    await pool.query(
      `insert into "User" ("id", "organizationId", "email", "status", "createdAt", "updatedAt")
       values ($1::uuid, $2::uuid, 'reconciler@example.test', 'ACTIVE', $3, $3)`,
      [ids.user, ids.organization, now],
    );
    await pool.query(
      `insert into "AgentIdentity" (
         "id", "organizationId", "externalAgentId", "status", "createdAt", "updatedAt"
       ) values ($1::uuid, $2::uuid, 'reconciler-agent', 'ACTIVE', $3, $3)`,
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
         $1::uuid, $2::uuid, 'Reconciler Policy', 1, true, 'USD',
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
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'reconciler-jti-hash',
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
        new Date(now.getTime() + 3_600_000),
      ],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  function nextUuid(): string {
    sequence += 1;
    return `20000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;
  }

  async function createOutcome(args: { key: string; status?: "UNKNOWN" | "FORWARDING" }) {
    const begun = await store.begin({
      id: nextUuid(),
      organizationId: ids.organization,
      userId: ids.user,
      agentId: ids.agent,
      mandateId: ids.mandate,
      reservationId: `reservation-${args.key}`,
      idempotencyKey: args.key,
      requestDigest: `digest-${args.key}`,
      merchantId: "merchant-1",
      merchantDomain: "merchant.example",
      checkoutSessionId: `cs-${args.key}`,
      amountMinor: 5000n,
      currency: "USD",
      now,
    });
    if (args.status === "UNKNOWN") {
      return store.markUnknown(begun.outcome.id, {
        errorCode: "MERCHANT_TRANSPORT_FAILURE",
        now,
      });
    }
    return begun.outcome;
  }

  function checkoutSession(id: string, status: string) {
    const base = {
      id,
      status,
      currency: "usd",
      line_items: [
        {
          id: "line-1",
          item: { id: "item-1", name: "Office item", unit_amount: 5000 },
          quantity: 1,
          category: "OFFICE_SUPPLIES",
          totals: [{ type: "subtotal", amount: 5000 }],
        },
      ],
      totals: [
        { type: "subtotal", amount: 5000 },
        { type: "total", amount: 5000 },
      ],
    };
    return status === "completed"
      ? { ...base, order: { id: `order-${id}` } }
      : base;
  }

  function harness(sessionStatus: string) {
    let commits = 0;
    let releases = 0;
    let holds = 0;
    let gets = 0;

    const reservations: AuthorizationReservations = {
      async tryReserve(_input: ReservationAttemptInput): Promise<ReservationAttemptResult> {
        throw new Error("tryReserve is not used by the background reconciler");
      },
      async commit() {
        commits += 1;
        return true;
      },
      async release() {
        releases += 1;
        return true;
      },
      async releaseForApproval() {
        throw new Error("releaseForApproval is not used by the background reconciler");
      },
      async holdForReconciliation() {
        holds += 1;
        return true;
      },
    };

    const merchant: MerchantEndpoint = {
      id: "merchant-1",
      domain: "merchant.example",
      baseUrl: "https://merchant.example",
      active: true,
    };

    const merchantClient: ACPMerchantClient = {
      async createCheckout() {
        throw new Error("not used");
      },
      async getCheckout(_merchant, checkoutSessionId): Promise<MerchantResponse> {
        gets += 1;
        return {
          status: 200,
          body: checkoutSession(checkoutSessionId, sessionStatus),
          headers: { "request-id": `merchant-request-${gets}`, "set-cookie": "secret=1" },
        };
      },
      async completeCheckout() {
        throw new Error("not used");
      },
      async cancelCheckout() {
        throw new Error("not used");
      },
    };

    const reconciler = new BackgroundPaymentReconciler(
      {
        outcomes: store,
        reservations,
        merchants: {
          async getById(organizationId, merchantId) {
            return organizationId === ids.organization && merchantId === merchant.id
              ? merchant
              : undefined;
          },
        },
        merchantClient,
        credentials: {
          async getAuthorization(organizationId, merchantId) {
            return organizationId === ids.organization && merchantId === merchant.id
              ? "Bearer server-side-merchant-credential"
              : undefined;
          },
        },
        generateRequestId: () => nextUuid(),
      },
      {
        batchSize: 10,
        leaseMs: 1000,
        forwardingGraceMs: 30_000,
        baseBackoffMs: 5000,
        maxBackoffMs: 60_000,
      },
    );

    return {
      reconciler,
      state: () => ({ commits, releases, holds, gets }),
    };
  }

  it("leases an unresolved outcome to only one worker and permits recovery after lease expiry", async () => {
    await createOutcome({ key: "lease", status: "UNKNOWN" });

    const first = await store.claimForReconciliation({
      workerId: "worker-a",
      now,
      limit: 10,
      leaseMs: 1000,
      forwardingGraceMs: 30_000,
    });
    const competing = await store.claimForReconciliation({
      workerId: "worker-b",
      now,
      limit: 10,
      leaseMs: 1000,
      forwardingGraceMs: 30_000,
    });
    const recovered = await store.claimForReconciliation({
      workerId: "worker-b",
      now: new Date(now.getTime() + 1001),
      limit: 10,
      leaseMs: 1000,
      forwardingGraceMs: 30_000,
    });

    expect(first).toHaveLength(1);
    expect(first[0]?.reconciliationLeaseOwner).toBe("worker-a");
    expect(first[0]?.reconcileAttempts).toBe(1);
    expect(competing).toHaveLength(0);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.reconciliationLeaseOwner).toBe("worker-b");
    expect(recovered[0]?.reconcileAttempts).toBe(2);
  });

  it("resolves a completed merchant session without forwarding payment again", async () => {
    await createOutcome({ key: "completed", status: "UNKNOWN" });
    const h = harness("completed");

    const result = await h.reconciler.runOnce("worker-completed", now);
    const stored = await store.getByIdempotency(ids.organization, "completed");

    expect(result).toEqual({
      claimed: 1,
      succeeded: 1,
      failedDefinitive: 0,
      deferred: 0,
      errors: 0,
    });
    expect(h.state()).toEqual({ commits: 1, releases: 0, holds: 1, gets: 1 });
    expect(stored?.status).toBe(PaymentOutcomeStatus.SUCCEEDED);
    expect(stored?.response?.body).toMatchObject({ status: "completed" });
    expect(stored?.response?.headers).toEqual({ "request-id": "merchant-request-1" });
    expect(stored?.reconciliationLeaseOwner).toBeUndefined();
  });

  it("releases a reservation only when merchant state is terminally canceled", async () => {
    await createOutcome({ key: "canceled", status: "UNKNOWN" });
    const h = harness("canceled");

    const result = await h.reconciler.runOnce("worker-canceled", now);
    const stored = await store.getByIdempotency(ids.organization, "canceled");

    expect(result.failedDefinitive).toBe(1);
    expect(h.state()).toEqual({ commits: 0, releases: 1, holds: 1, gets: 1 });
    expect(stored?.status).toBe(PaymentOutcomeStatus.FAILED_DEFINITIVE);
  });

  it("recovers stale FORWARDING rows and defers nonterminal merchant state with backoff", async () => {
    await createOutcome({ key: "stale-forwarding", status: "FORWARDING" });
    const h = harness("ready_for_payment");
    const runAt = new Date(now.getTime() + 30_001);

    const result = await h.reconciler.runOnce("worker-recovery", runAt);
    const stored = await store.getByIdempotency(ids.organization, "stale-forwarding");

    expect(result).toEqual({
      claimed: 1,
      succeeded: 0,
      failedDefinitive: 0,
      deferred: 1,
      errors: 0,
    });
    expect(h.state()).toEqual({ commits: 0, releases: 0, holds: 1, gets: 1 });
    expect(stored?.status).toBe(PaymentOutcomeStatus.UNKNOWN);
    expect(stored?.lastErrorCode).toBe("MERCHANT_CHECKOUT_NOT_TERMINAL");
    expect(stored?.nextReconcileAt).toEqual(new Date(runAt.getTime() + 5000));
    expect(stored?.reconciliationLeaseOwner).toBeUndefined();
  });
});
