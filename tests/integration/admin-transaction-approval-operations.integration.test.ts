import { generateKeyPairSync, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StaticAuditKeyProvider } from "../../src/infrastructure/crypto/static-key-providers.js";
import { PgSqlAdapter } from "../../src/infrastructure/postgres/pg-sql-adapter.js";
import {
  PostgresAdminChangeAuditLedger,
  PostgresAdminChangeAuditVerifier,
} from "../../src/modules/admin/admin-change-audit-ledger.js";
import { PostgresAdminTransactionApprovalOperations } from "../../src/modules/admin/admin-transaction-approval-operations.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";
const now = new Date("2026-08-16T17:30:00.000Z");

integration("administrative transaction and approval operations", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("paginates safe tenant-scoped projections and never exposes economic-truth mutation surfaces", async () => {
    const fixture = await seedFixture(pool);
    const { service } = buildService(pool);

    try {
      const first = await service.listApprovals(fixture.organizationId, {
        status: "PENDING",
        limit: 1,
      });
      expect(first.items).toHaveLength(1);
      expect(first.nextCursor).toBeTruthy();
      expect(first.items[0]).toMatchObject({
        organizationId: fixture.organizationId,
        status: "PENDING",
        amountMinor: "9007199254740993000",
        voteCount: 0,
      });
      const second = await service.listApprovals(fixture.organizationId, {
        status: "PENDING",
        limit: 1,
        cursor: first.nextCursor,
      });
      expect(second.items).toHaveLength(1);
      expect(second.items[0]!.id).not.toBe(first.items[0]!.id);

      const expired = await service.listApprovals(fixture.organizationId, { status: "EXPIRED" });
      expect(expired.items.map((item) => item.id)).toContain(fixture.expiredApprovalId);
      expect(
        (
          await pool.query<{ status: string }>(
            `select "status"::text as status from "ApprovalRequest" where "id" = $1::uuid`,
            [fixture.expiredApprovalId],
          )
        ).rows[0]?.status,
      ).toBe("PENDING");

      const approvalDetail = await service.getApproval(
        fixture.organizationId,
        fixture.primaryApprovalId,
      );
      expect(approvalDetail?.votes).toEqual([]);
      const approvalText = JSON.stringify(approvalDetail);
      expect(approvalText).not.toContain("approval-super-secret");
      expect(approvalText).not.toContain("approval-idempotency-primary");
      expect(approvalText).not.toContain("approval-request-digest-primary");

      const payments = await service.listPayments(fixture.organizationId, {
        status: "UNKNOWN",
        merchantId: "merchant-1",
      });
      expect(payments.items).toHaveLength(1);
      expect(payments.items[0]).toMatchObject({
        id: fixture.paymentOutcomeId,
        amountMinor: "9223372036854775807",
        status: "UNKNOWN",
        reconciliationState: "PENDING",
        reconcileAttempts: 3,
        lastErrorCode: "MERCHANT_TRANSPORT_ERROR",
      });
      const paymentText = JSON.stringify(payments.items[0]);
      expect(paymentText).not.toContain("merchant-secret-body");
      expect(paymentText).not.toContain("merchant-secret-header");
      expect(paymentText).not.toContain("payment-idempotency-primary");
      expect(paymentText).not.toContain("payment-request-digest-primary");
      expect(paymentText).not.toContain("lease-worker-secret");

      expect(
        await service.getApproval(fixture.organizationId, fixture.otherApprovalId),
      ).toBeUndefined();
      expect(
        await service.getPayment(fixture.organizationId, fixture.otherPaymentOutcomeId),
      ).toBeUndefined();
    } finally {
      await cleanupFixture(pool, fixture.organizationId, fixture.otherOrganizationId);
    }
  });

  it("casts admin votes atomically with audit, replays exactly, and preserves expiry and terminal rules", async () => {
    const fixture = await seedFixture(pool);
    const { service, verifier } = buildService(pool);
    const firstActor = actorFor(fixture.organizationId);
    const secondActor = actorFor(fixture.organizationId);

    try {
      const firstVote = await service.castApprovalVote(firstActor, fixture.primaryApprovalId, {
        decision: "APPROVE",
        comment: "first approval",
      });
      expect(firstVote.outcome).toBe("UPDATED");
      if (firstVote.outcome !== "UPDATED") throw new Error("expected first vote update");
      expect(firstVote.approval).toMatchObject({
        status: "PENDING",
        requiredSignatures: 2,
        voteCount: 1,
        approveCount: 1,
      });
      expect(await auditCount(pool, fixture.organizationId)).toBe("1");

      const replay = await service.castApprovalVote(firstActor, fixture.primaryApprovalId, {
        decision: "APPROVE",
        comment: "a changed comment does not create a second vote",
      });
      expect(replay.outcome).toBe("REPLAYED");
      expect(await auditCount(pool, fixture.organizationId)).toBe("1");

      const changedVote = await service.castApprovalVote(firstActor, fixture.primaryApprovalId, {
        decision: "REJECT",
      });
      expect(changedVote.outcome).toBe("CONFLICT");
      expect(await auditCount(pool, fixture.organizationId)).toBe("1");

      const secondVote = await service.castApprovalVote(secondActor, fixture.primaryApprovalId, {
        decision: "APPROVE",
      });
      expect(secondVote.outcome).toBe("UPDATED");
      if (secondVote.outcome !== "UPDATED") throw new Error("expected second vote update");
      expect(secondVote.approval).toMatchObject({
        status: "APPROVED",
        voteCount: 2,
        approveCount: 2,
        rejectCount: 0,
      });
      expect(secondVote.approval.votes?.map((vote) => vote.identity.type)).toEqual([
        "ADMIN_PRINCIPAL",
        "ADMIN_PRINCIPAL",
      ]);
      expect(await auditCount(pool, fixture.organizationId)).toBe("2");

      const terminal = await service.castApprovalVote(
        actorFor(fixture.organizationId),
        fixture.primaryApprovalId,
        { decision: "REJECT" },
      );
      expect(terminal.outcome).toBe("ALREADY_RESOLVED");
      expect(await auditCount(pool, fixture.organizationId)).toBe("2");

      const expired = await service.castApprovalVote(
        actorFor(fixture.organizationId),
        fixture.expiredApprovalId,
        { decision: "APPROVE" },
      );
      expect(expired.outcome).toBe("ALREADY_RESOLVED");
      if (expired.outcome !== "ALREADY_RESOLVED") throw new Error("expected expired result");
      expect(expired.approval.status).toBe("EXPIRED");
      expect(await auditCount(pool, fixture.organizationId)).toBe("2");
      expect(
        (
          await pool.query<{ status: string }>(
            `select "status"::text as status from "ApprovalRequest" where "id" = $1::uuid`,
            [fixture.expiredApprovalId],
          )
        ).rows[0]?.status,
      ).toBe("EXPIRED");

      const rejected = await service.castApprovalVote(
        actorFor(fixture.organizationId),
        fixture.rejectableApprovalId,
        { decision: "REJECT" },
      );
      expect(rejected.outcome).toBe("UPDATED");
      if (rejected.outcome !== "UPDATED") throw new Error("expected rejection update");
      expect(rejected.approval.status).toBe("REJECTED");
      expect(await auditCount(pool, fixture.organizationId)).toBe("3");

      const auditRows = await pool.query<{
        permission: string;
        action: string;
        beforeState: unknown;
        afterState: unknown;
        requestDigest: string;
      }>(
        `select "permission", "action", "beforeState", "afterState", "requestDigest"
           from "AdminAuditLog"
          where "organizationId" = $1::uuid
          order by "chainSequence" asc`,
        [fixture.organizationId],
      );
      expect(auditRows.rows.map((row) => [row.permission, row.action])).toEqual([
        ["approval.vote", "approval.vote"],
        ["approval.vote", "approval.vote"],
        ["approval.vote", "approval.vote"],
      ]);
      expect(JSON.stringify(auditRows.rows)).not.toContain("first approval");
      expect(await verifier.verifyOrganization(fixture.organizationId)).toMatchObject({
        valid: true,
        checkedEvents: 3,
      });
    } finally {
      await cleanupFixture(pool, fixture.organizationId, fixture.otherOrganizationId);
    }
  });
});

function buildService(pool: Pool) {
  const keys = generateKeyPairSync("ed25519");
  const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const sql = new PgSqlAdapter(pool);
  const provider = new StaticAuditKeyProvider(
    { keyId: "admin-operations-audit-k1", privateKey },
    new Map([["admin-operations-audit-k1", publicKey]]),
  );
  const audit = new PostgresAdminChangeAuditLedger(sql, provider);
  return {
    service: new PostgresAdminTransactionApprovalOperations(
      sql,
      audit,
      randomUUID,
      () => now,
    ),
    verifier: new PostgresAdminChangeAuditVerifier(sql, provider),
  };
}

function actorFor(organizationId: string) {
  return {
    principalId: randomUUID(),
    membershipId: randomUUID(),
    organizationId,
    roles: ["APPROVER" as const],
  };
}

interface Fixture {
  organizationId: string;
  otherOrganizationId: string;
  primaryApprovalId: string;
  expiredApprovalId: string;
  rejectableApprovalId: string;
  otherApprovalId: string;
  paymentOutcomeId: string;
  otherPaymentOutcomeId: string;
}

async function seedFixture(pool: Pool): Promise<Fixture> {
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const userId = randomUUID();
  const agentId = randomUUID();
  const policyId = randomUUID();
  const mandateId = randomUUID();
  const otherUserId = randomUUID();
  const otherAgentId = randomUUID();
  const otherPolicyId = randomUUID();
  const otherMandateId = randomUUID();
  const primaryApprovalId = randomUUID();
  const secondaryApprovalId = randomUUID();
  const expiredApprovalId = randomUUID();
  const rejectableApprovalId = randomUUID();
  const otherApprovalId = randomUUID();
  const paymentOutcomeId = randomUUID();
  const otherPaymentOutcomeId = randomUUID();

  await pool.query(
    `insert into "Organization" ("id", "name", "createdAt", "updatedAt")
     values ($1::uuid, 'Admin operations org', now(), now()),
            ($2::uuid, 'Other admin operations org', now(), now())`,
    [organizationId, otherOrganizationId],
  );
  await pool.query(
    `insert into "User" ("id", "organizationId", "email", "status", "createdAt", "updatedAt")
     values ($1::uuid, $2::uuid, $3, 'ACTIVE', now(), now()),
            ($4::uuid, $5::uuid, $6, 'ACTIVE', now(), now())`,
    [
      userId,
      organizationId,
      `${userId}@example.test`,
      otherUserId,
      otherOrganizationId,
      `${otherUserId}@example.test`,
    ],
  );
  await pool.query(
    `insert into "AgentIdentity" (
       "id", "organizationId", "externalAgentId", "status", "createdAt", "updatedAt"
     ) values
       ($1::uuid, $2::uuid, $3, 'ACTIVE', now(), now()),
       ($4::uuid, $5::uuid, $6, 'ACTIVE', now(), now())`,
    [agentId, organizationId, `agent-${agentId}`, otherAgentId, otherOrganizationId, `agent-${otherAgentId}`],
  );
  await pool.query(
    `insert into "Policy" (
       "id", "organizationId", "name", "version", "active", "baseCurrency",
       "maxBudgetMinor", "rollingDailyLimitMinor", "approvedMerchantDomains", "approvedVendorIds",
       "restrictedCategories", "approvalMode", "maxTransactionsPerMinute",
       "crossMerchantWindowSecs", "maxDistinctMerchants", "createdAt", "updatedAt"
     ) values
       ($1::uuid, $2::uuid, 'Admin Ops', 1, true, 'USD', 9007199254740993000, 9223372036854775807,
        ARRAY['shop.example.com'], ARRAY['vendor-1'], ARRAY['GAMBLING'], 'DUAL_SIGNATURE_SLACK', 10, 60, 5, now(), now()),
       ($3::uuid, $4::uuid, 'Other Admin Ops', 1, true, 'USD', 1000, 10000,
        ARRAY['other.example.com'], ARRAY[]::text[], ARRAY[]::text[], 'AUTO_APPROVE', 10, 60, 5, now(), now())`,
    [policyId, organizationId, otherPolicyId, otherOrganizationId],
  );
  await pool.query(
    `insert into "AgentMandate" (
       "id", "organizationId", "userId", "agentId", "policyId", "tokenJtiHash", "policyVersion",
       "currency", "maxBudgetMinor", "rollingDailyLimitMinor", "approvedMerchantDomains",
       "approvedVendorIds", "restrictedCategories", "approvalMode", "maxTransactionsPerMinute",
       "crossMerchantWindowSecs", "maxDistinctMerchants", "delegationPayloadHash", "signingKeyId",
       "status", "issuedAt", "expiresAt"
     ) values
       ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, 1, 'USD', 9007199254740993000,
        9223372036854775807, ARRAY['shop.example.com'], ARRAY['vendor-1'], ARRAY['GAMBLING'],
        'DUAL_SIGNATURE_SLACK', 10, 60, 5, 'delegation-hash', 'mandate-k1', 'ACTIVE', $7, $8),
       ($9::uuid, $10::uuid, $11::uuid, $12::uuid, $13::uuid, $14, 1, 'USD', 1000,
        10000, ARRAY['other.example.com'], ARRAY[]::text[], ARRAY[]::text[],
        'AUTO_APPROVE', 10, 60, 5, 'other-delegation-hash', 'mandate-k1', 'ACTIVE', $7, $8)`,
    [
      mandateId,
      organizationId,
      userId,
      agentId,
      policyId,
      `jti-${mandateId}`,
      new Date("2026-08-16T16:00:00.000Z"),
      new Date("2026-09-16T16:00:00.000Z"),
      otherMandateId,
      otherOrganizationId,
      otherUserId,
      otherAgentId,
      otherPolicyId,
      `jti-${otherMandateId}`,
    ],
  );

  const approvalValues = [
    [primaryApprovalId, organizationId, userId, agentId, mandateId, "2026-08-16T17:20:00.000Z", "2026-08-16T18:00:00.000Z", "approval-idempotency-primary", "approval-request-digest-primary"],
    [secondaryApprovalId, organizationId, userId, agentId, mandateId, "2026-08-16T17:10:00.000Z", "2026-08-16T18:10:00.000Z", "approval-idempotency-secondary", "approval-request-digest-secondary"],
    [expiredApprovalId, organizationId, userId, agentId, mandateId, "2026-08-16T16:00:00.000Z", "2026-08-16T17:00:00.000Z", "approval-idempotency-expired", "approval-request-digest-expired"],
    [rejectableApprovalId, organizationId, userId, agentId, mandateId, "2026-08-16T17:05:00.000Z", "2026-08-16T18:05:00.000Z", "approval-idempotency-reject", "approval-request-digest-reject"],
    [otherApprovalId, otherOrganizationId, otherUserId, otherAgentId, otherMandateId, "2026-08-16T17:25:00.000Z", "2026-08-16T18:25:00.000Z", "approval-idempotency-other", "approval-request-digest-other"],
  ] as const;
  for (const [id, org, user, agent, mandate, createdAt, expiresAt, idempotencyKey, requestDigest] of approvalValues) {
    await pool.query(
      `insert into "ApprovalRequest" (
         "id", "organizationId", "userId", "agentId", "mandateId", "decisionId", "requestId",
         "idempotencyKey", "requestDigest", "policyVersion", "merchantId", "merchantDomain",
         "checkoutSessionId", "requestedPayload", "sessionSnapshot", "spendSnapshot", "reasonCodes",
         "amountMinor", "currency", "status", "requiredSignatures", "createdAt", "expiresAt"
       ) values (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9, 1,
         'merchant-1', 'shop.example.com', 'checkout-1', $10::jsonb, $11::jsonb, $12::jsonb,
         ARRAY['TRANSACTION_LIMIT_EXCEEDED'], 9007199254740993000, 'USD', 'PENDING', 2, $13, $14
       )`,
      [
        id,
        org,
        user,
        agent,
        mandate,
        `decision-${id}`,
        `request-${id}`,
        idempotencyKey,
        requestDigest,
        JSON.stringify({ card: "approval-super-secret" }),
        JSON.stringify({ authorization: "approval-super-secret" }),
        JSON.stringify({ committedMinor: "100", reservedMinor: "50" }),
        new Date(createdAt),
        new Date(expiresAt),
      ],
    );
  }

  await pool.query(
    `insert into "PaymentOutcome" (
       "id", "organizationId", "userId", "agentId", "mandateId", "reservationId",
       "idempotencyKey", "requestDigest", "merchantId", "merchantDomain", "checkoutSessionId",
       "amountMinor", "currency", "status", "upstreamStatus", "responseBody", "responseHeaders",
       "lastErrorCode", "forwardedAt", "lastReconciledAt", "reconcileAttempts", "nextReconcileAt",
       "reconciliationLeaseOwner", "reconciliationLeaseExpiresAt", "createdAt", "updatedAt"
     ) values
       ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'reservation-primary',
        'payment-idempotency-primary', 'payment-request-digest-primary', 'merchant-1', 'shop.example.com',
        'checkout-1', 9223372036854775807, 'USD', 'UNKNOWN', 503, $6::jsonb, $7::jsonb,
        'MERCHANT_TRANSPORT_ERROR', $8, $9, 3, $10, 'lease-worker-secret', $11, $8, $9),
       ($12::uuid, $13::uuid, $14::uuid, $15::uuid, $16::uuid, 'reservation-other',
        'payment-idempotency-other', 'payment-request-digest-other', 'merchant-other', 'other.example.com',
        'checkout-other', 1000, 'USD', 'SUCCEEDED', 200, '{}'::jsonb, '{}'::jsonb,
        null, $8, $9, 0, null, null, null, $8, $9)`,
    [
      paymentOutcomeId,
      organizationId,
      userId,
      agentId,
      mandateId,
      JSON.stringify({ secret: "merchant-secret-body" }),
      JSON.stringify({ authorization: "merchant-secret-header" }),
      new Date("2026-08-16T17:15:00.000Z"),
      new Date("2026-08-16T17:20:00.000Z"),
      new Date("2026-08-16T17:40:00.000Z"),
      new Date("2026-08-16T17:35:00.000Z"),
      otherPaymentOutcomeId,
      otherOrganizationId,
      otherUserId,
      otherAgentId,
      otherMandateId,
    ],
  );

  return {
    organizationId,
    otherOrganizationId,
    primaryApprovalId,
    expiredApprovalId,
    rejectableApprovalId,
    otherApprovalId,
    paymentOutcomeId,
    otherPaymentOutcomeId,
  };
}

async function auditCount(pool: Pool, organizationId: string): Promise<string | undefined> {
  return (
    await pool.query<{ count: string }>(
      `select count(*)::text as count from "AdminAuditLog" where "organizationId" = $1::uuid`,
      [organizationId],
    )
  ).rows[0]?.count;
}

async function cleanupFixture(
  pool: Pool,
  organizationId: string,
  otherOrganizationId: string,
): Promise<void> {
  const ids = [organizationId, otherOrganizationId];
  await pool.query(`delete from "AdminAuditLog" where "organizationId" = any($1::uuid[])`, [ids]);
  await pool.query(`delete from "AdminAuditChainHead" where "organizationId" = any($1::uuid[])`, [ids]);
  await pool.query(`delete from "ApprovalRequest" where "organizationId" = any($1::uuid[])`, [ids]);
  await pool.query(`delete from "PaymentOutcome" where "organizationId" = any($1::uuid[])`, [ids]);
  await pool.query(`delete from "AgentMandate" where "organizationId" = any($1::uuid[])`, [ids]);
  await pool.query(`delete from "Policy" where "organizationId" = any($1::uuid[])`, [ids]);
  await pool.query(`delete from "AgentIdentity" where "organizationId" = any($1::uuid[])`, [ids]);
  await pool.query(`delete from "User" where "organizationId" = any($1::uuid[])`, [ids]);
  await pool.query(`delete from "Organization" where "id" = any($1::uuid[])`, [ids]);
}
