import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import {
  ApprovalAlreadyResolvedError,
  ApprovalRequestStatus,
  ApprovalVoteConflictError,
  ApprovalVoteDecision,
  BeginApprovalRequestKind,
  PostgresApprovalRequestStore,
  type ApprovalSqlClient,
  type ApprovalSqlTransaction,
} from "../../src/modules/approvals/approval-request.store.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";

const ids = {
  organization: "30000000-0000-4000-8000-000000000001",
  user: "30000000-0000-4000-8000-000000000002",
  agent: "30000000-0000-4000-8000-000000000003",
  policy: "30000000-0000-4000-8000-000000000004",
  mandate: "30000000-0000-4000-8000-000000000005",
};
const now = new Date("2026-08-14T16:00:00.000Z");

integration("PostgresApprovalRequestStore", () => {
  let pool: Pool;
  let store: PostgresApprovalRequestStore;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
    store = new PostgresApprovalRequestStore(sqlAdapter(pool));
  });

  beforeEach(async () => {
    await pool.query(
      `delete from "ApprovalVote"
        where "approvalRequestId" in (
          select "id" from "ApprovalRequest" where "organizationId" = $1::uuid
        )`,
      [ids.organization],
    );
    await pool.query('delete from "ApprovalRequest" where "organizationId" = $1::uuid', [ids.organization]);
    await pool.query('delete from "AgentMandate" where "id" = $1::uuid', [ids.mandate]);
    await pool.query('delete from "Policy" where "id" = $1::uuid', [ids.policy]);
    await pool.query('delete from "AgentIdentity" where "id" = $1::uuid', [ids.agent]);
    await pool.query('delete from "User" where "id" = $1::uuid', [ids.user]);
    await pool.query('delete from "Organization" where "id" = $1::uuid', [ids.organization]);

    await pool.query(
      `insert into "Organization" ("id", "name", "createdAt", "updatedAt")
       values ($1::uuid, 'Approval Test Org', $2, $2)`,
      [ids.organization, now],
    );
    await pool.query(
      `insert into "User" ("id", "organizationId", "email", "status", "createdAt", "updatedAt")
       values ($1::uuid, $2::uuid, 'approval@example.test', 'ACTIVE', $3, $3)`,
      [ids.user, ids.organization, now],
    );
    await pool.query(
      `insert into "AgentIdentity" (
         "id", "organizationId", "externalAgentId", "status", "createdAt", "updatedAt"
       ) values ($1::uuid, $2::uuid, 'approval-agent', 'ACTIVE', $3, $3)`,
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
         $1::uuid, $2::uuid, 'Approval Policy', 3, true, 'USD',
         4000, 20000, array['merchant.example'], array[]::text[], array[]::text[], 'DUAL_SIGNATURE_SLACK',
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
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'approval-jti-hash',
         3, 'USD', 4000, 20000,
         array['merchant.example'], array[]::text[], array[]::text[], 'DUAL_SIGNATURE_SLACK',
         10, 60, 5, 'approval-delegation-hash', 'mino-k1', 'ACTIVE', $6, $7
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

  function beginInput(args: { id: string; key?: string; digest?: string; expiresAt?: Date }) {
    return {
      id: args.id,
      organizationId: ids.organization,
      userId: ids.user,
      agentId: ids.agent,
      mandateId: ids.mandate,
      decisionId: `decision-${args.id}`,
      requestId: `request-${args.id}`,
      idempotencyKey: args.key ?? "approval-idem-1",
      requestDigest: args.digest ?? "approval-digest-1",
      policyVersion: 3,
      merchantId: "merchant-1",
      merchantDomain: "merchant.example",
      checkoutSessionId: "cs_approval",
      requestedPayload: { payment_data: { token: "[REDACTED]" } },
      sessionSnapshot: { id: "cs_approval", status: "ready_for_payment" },
      spendSnapshot: { currency: "USD", committedMinor: "10000", reservedMinor: "0" },
      reasonCodes: ["TRANSACTION_LIMIT_EXCEEDED", "HUMAN_APPROVAL_REQUIRED"],
      amountMinor: 5_000n,
      currency: "USD",
      requiredSignatures: 2,
      expiresAt: args.expiresAt ?? new Date(now.getTime() + 300_000),
      now,
    };
  }

  it("creates one durable request and distinguishes replay from idempotency conflict", async () => {
    const first = await store.begin(
      beginInput({ id: "30000000-0000-4000-8000-000000000006" }),
    );
    const replay = await store.begin(
      beginInput({ id: "30000000-0000-4000-8000-000000000007" }),
    );
    const conflict = await store.begin(
      beginInput({
        id: "30000000-0000-4000-8000-000000000008",
        digest: "changed-digest",
      }),
    );

    expect(first.kind).toBe(BeginApprovalRequestKind.CREATED);
    expect(replay.kind).toBe(BeginApprovalRequestKind.EXISTING);
    expect(replay.request.id).toBe(first.request.id);
    expect(conflict.kind).toBe(BeginApprovalRequestKind.CONFLICT);
  });

  it("resolves dual approval exactly once under concurrent votes", async () => {
    const begun = await store.begin(
      beginInput({
        id: "30000000-0000-4000-8000-000000000009",
        key: "approval-idem-dual",
      }),
    );

    const [alice, bob] = await Promise.all([
      store.castVote({
        approvalRequestId: begun.request.id,
        approverId: "alice@example.test",
        decision: ApprovalVoteDecision.APPROVE,
        now: new Date(now.getTime() + 1_000),
      }),
      store.castVote({
        approvalRequestId: begun.request.id,
        approverId: "bob@example.test",
        decision: ApprovalVoteDecision.APPROVE,
        now: new Date(now.getTime() + 1_001),
      }),
    ]);

    const resolved = await store.getById(begun.request.id);
    expect(resolved?.status).toBe(ApprovalRequestStatus.APPROVED);
    expect(resolved?.votes).toHaveLength(2);
    expect([alice.status, bob.status]).toContain(ApprovalRequestStatus.APPROVED);
  });

  it("makes a duplicate same vote idempotent but rejects changing an approver's vote", async () => {
    const begun = await store.begin(
      beginInput({
        id: "30000000-0000-4000-8000-000000000010",
        key: "approval-idem-duplicate",
      }),
    );
    const vote = {
      approvalRequestId: begun.request.id,
      approverId: "alice@example.test",
      decision: ApprovalVoteDecision.APPROVE,
      now: new Date(now.getTime() + 1_000),
    } as const;

    await store.castVote(vote);
    const replay = await store.castVote(vote);
    expect(replay.votes).toHaveLength(1);

    await expect(
      store.castVote({ ...vote, decision: ApprovalVoteDecision.REJECT }),
    ).rejects.toBeInstanceOf(ApprovalVoteConflictError);
  });

  it("rejects the request immediately and refuses new votes after terminal resolution", async () => {
    const begun = await store.begin(
      beginInput({
        id: "30000000-0000-4000-8000-000000000011",
        key: "approval-idem-reject",
      }),
    );

    const rejected = await store.castVote({
      approvalRequestId: begun.request.id,
      approverId: "security@example.test",
      decision: ApprovalVoteDecision.REJECT,
      now: new Date(now.getTime() + 1_000),
    });
    expect(rejected.status).toBe(ApprovalRequestStatus.REJECTED);

    await expect(
      store.castVote({
        approvalRequestId: begun.request.id,
        approverId: "finance@example.test",
        decision: ApprovalVoteDecision.APPROVE,
        now: new Date(now.getTime() + 2_000),
      }),
    ).rejects.toBeInstanceOf(ApprovalAlreadyResolvedError);
  });

  it("expires a pending request before accepting a late vote", async () => {
    const expiresAt = new Date(now.getTime() + 1_000);
    const begun = await store.begin(
      beginInput({
        id: "30000000-0000-4000-8000-000000000012",
        key: "approval-idem-expired",
        expiresAt,
      }),
    );

    await expect(
      store.castVote({
        approvalRequestId: begun.request.id,
        approverId: "late@example.test",
        decision: ApprovalVoteDecision.APPROVE,
        now: new Date(expiresAt.getTime() + 1),
      }),
    ).rejects.toBeInstanceOf(ApprovalAlreadyResolvedError);

    const expired = await store.getById(begun.request.id);
    expect(expired?.status).toBe(ApprovalRequestStatus.EXPIRED);
    expect(expired?.votes).toHaveLength(0);
  });
});

function sqlAdapter(pool: Pool): ApprovalSqlClient {
  return {
    async query<R extends QueryResultRow>(text: string, values?: unknown[]) {
      const result = await pool.query<R>(text, values);
      return { rows: result.rows, rowCount: result.rowCount };
    },
    async connect(): Promise<ApprovalSqlTransaction> {
      return transactionAdapter(await pool.connect());
    },
  };
}

function transactionAdapter(client: PoolClient): ApprovalSqlTransaction {
  return {
    async query<R extends QueryResultRow>(text: string, values?: unknown[]) {
      const result = await client.query<R>(text, values);
      return { rows: result.rows, rowCount: result.rowCount };
    },
    release() {
      client.release();
    },
  };
}
