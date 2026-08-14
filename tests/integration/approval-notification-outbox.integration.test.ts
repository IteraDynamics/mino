import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { HumanApprovalEvent } from "../../src/modules/approvals/approval-emitter.js";
import { ApprovalNotificationOutboxWorker } from "../../src/modules/approvals/approval-notification-outbox.worker.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";

const ids = {
  organization: "71000000-0000-4000-8000-000000000001",
  user: "71000000-0000-4000-8000-000000000002",
  agent: "71000000-0000-4000-8000-000000000003",
  policy: "71000000-0000-4000-8000-000000000004",
  mandate: "71000000-0000-4000-8000-000000000005",
};
const now = new Date("2026-08-14T18:30:00.000Z");

integration("ApprovalNotificationOutboxWorker", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  beforeEach(async () => {
    await pool.query('delete from "ApprovalVote" where "approvalRequestId" in (select "id" from "ApprovalRequest" where "organizationId" = $1::uuid)', [ids.organization]);
    await pool.query('delete from "ApprovalRequest" where "organizationId" = $1::uuid', [ids.organization]);
    await pool.query('delete from "AgentMandate" where "id" = $1::uuid', [ids.mandate]);
    await pool.query('delete from "Policy" where "id" = $1::uuid', [ids.policy]);
    await pool.query('delete from "AgentIdentity" where "id" = $1::uuid', [ids.agent]);
    await pool.query('delete from "User" where "id" = $1::uuid', [ids.user]);
    await pool.query('delete from "Organization" where "id" = $1::uuid', [ids.organization]);

    await pool.query(
      `insert into "Organization" ("id", "name", "createdAt", "updatedAt")
       values ($1::uuid, 'Outbox Test Org', $2, $2)`,
      [ids.organization, now],
    );
    await pool.query(
      `insert into "User" ("id", "organizationId", "email", "status", "createdAt", "updatedAt")
       values ($1::uuid, $2::uuid, 'outbox@example.test', 'ACTIVE', $3, $3)`,
      [ids.user, ids.organization, now],
    );
    await pool.query(
      `insert into "AgentIdentity" ("id", "organizationId", "externalAgentId", "status", "createdAt", "updatedAt")
       values ($1::uuid, $2::uuid, 'outbox-agent', 'ACTIVE', $3, $3)`,
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
        $1::uuid, $2::uuid, 'Outbox Policy', 1, true, 'USD', 4000, 20000,
        array['merchant.example'], array[]::text[], array[]::text[], 'DUAL_SIGNATURE_SLACK',
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
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'outbox-jti-hash',
        1, 'USD', 4000, 20000, array['merchant.example'], array[]::text[], array[]::text[],
        'DUAL_SIGNATURE_SLACK', 10, 60, 5, 'outbox-delegation-hash', 'mino-k1', 'ACTIVE', $6, $7
      )`,
      [ids.mandate, ids.organization, ids.user, ids.agent, ids.policy, now, new Date(now.getTime() + 3_600_000)],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  async function insertApproval(id: string, expiresAt = new Date(now.getTime() + 300_000)) {
    await pool.query(
      `insert into "ApprovalRequest" (
        "id", "organizationId", "userId", "agentId", "mandateId", "decisionId", "requestId",
        "idempotencyKey", "requestDigest", "policyVersion", "merchantId", "merchantDomain",
        "checkoutSessionId", "requestedPayload", "reasonCodes", "amountMinor", "currency",
        "status", "requiredSignatures", "createdAt", "expiresAt"
      ) values (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9, 1,
        'merchant-1', 'merchant.example', 'cs_outbox', '{}'::jsonb,
        array['TRANSACTION_LIMIT_EXCEEDED','HUMAN_APPROVAL_REQUIRED'], 5000, 'USD',
        'PENDING', 2, $10, $11
      )`,
      [
        id,
        ids.organization,
        ids.user,
        ids.agent,
        ids.mandate,
        `decision-${id}`,
        `request-${id}`,
        `idem-${id}`,
        `digest-${id}`,
        now,
        expiresAt,
      ],
    );
  }

  function worker(
    emit: (event: HumanApprovalEvent) => Promise<void>,
    options: { maxAttempts?: number } = {},
  ) {
    return new ApprovalNotificationOutboxWorker(
      pool,
      { emit },
      {
        baseBackoffMs: 1_000,
        maxBackoffMs: 1_000,
        leaseMs: 5_000,
        maxAttempts: options.maxAttempts ?? 3,
      },
    );
  }

  async function notificationState(id: string) {
    const result = await pool.query<{ approvalData: { notification?: Record<string, unknown> } | null; status: string }>(
      'select "approvalData", "status" from "ApprovalRequest" where "id" = $1::uuid',
      [id],
    );
    return result.rows[0]!;
  }

  it("defers a failed delivery and later delivers the same stable event", async () => {
    const id = "71000000-0000-4000-8000-000000000010";
    await insertApproval(id);
    const events: HumanApprovalEvent[] = [];
    let calls = 0;
    const delivery = worker(async (event) => {
      calls += 1;
      events.push(event);
      if (calls === 1) {
        throw new Error("simulated webhook outage with secret data that must not be stored");
      }
    });

    const first = await delivery.runOnce("worker-a", now);
    expect(first).toEqual({ claimed: 1, delivered: 0, deferred: 1, deadLettered: 0, expired: 0 });
    const deferred = await notificationState(id);
    expect(deferred.approvalData?.notification?.status).toBe("PENDING");
    expect(deferred.approvalData?.notification?.attempts).toBe(1);
    expect(deferred.approvalData?.notification?.lastErrorCode).toBe("DELIVERY_FAILED");
    expect(JSON.stringify(deferred.approvalData)).not.toContain("secret data");

    const tooEarly = await delivery.runOnce("worker-a", new Date(now.getTime() + 500));
    expect(tooEarly.claimed).toBe(0);

    const second = await delivery.runOnce("worker-a", new Date(now.getTime() + 1_001));
    expect(second.delivered).toBe(1);
    const delivered = await notificationState(id);
    expect(delivered.approvalData?.notification?.status).toBe("DELIVERED");
    expect(delivered.approvalData?.notification?.attempts).toBe(2);
    expect(events).toHaveLength(2);
    expect(events[0]?.eventId).toBe(id);
    expect(events[1]?.eventId).toBe(id);
  });

  it("lets concurrent workers claim a pending approval only once", async () => {
    const id = "71000000-0000-4000-8000-000000000011";
    await insertApproval(id);
    let deliveries = 0;
    const delivery = worker(async () => {
      deliveries += 1;
    });

    const [a, b] = await Promise.all([
      delivery.runOnce("worker-a", now),
      delivery.runOnce("worker-b", now),
    ]);

    expect(a.claimed + b.claimed).toBe(1);
    expect(deliveries).toBe(1);
    expect((await notificationState(id)).approvalData?.notification?.status).toBe("DELIVERED");
  });

  it("dead-letters delivery after the configured attempt budget", async () => {
    const id = "71000000-0000-4000-8000-000000000012";
    await insertApproval(id);
    const delivery = worker(async () => {
      throw new Error("still unavailable");
    }, { maxAttempts: 2 });

    const first = await delivery.runOnce("worker-a", now);
    expect(first.deferred).toBe(1);
    const second = await delivery.runOnce("worker-a", new Date(now.getTime() + 1_001));
    expect(second.deadLettered).toBe(1);
    const state = await notificationState(id);
    expect(state.approvalData?.notification?.status).toBe("DEAD_LETTER");
    expect(state.approvalData?.notification?.lastErrorCode).toBe("DELIVERY_ATTEMPTS_EXHAUSTED");
  });

  it("expires an approval that can no longer be usefully delivered", async () => {
    const id = "71000000-0000-4000-8000-000000000013";
    await insertApproval(id, new Date(now.getTime() - 1));
    const delivery = worker(async () => {
      throw new Error("should not be called");
    });

    const result = await delivery.runOnce("worker-a", now);
    expect(result.expired).toBe(1);
    const state = await notificationState(id);
    expect(state.status).toBe("EXPIRED");
    expect(state.approvalData?.notification?.status).toBe("DEAD_LETTER");
    expect(state.approvalData?.notification?.lastErrorCode).toBe("APPROVAL_EXPIRED_BEFORE_DELIVERY");
  });
});
