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

  it("paginates safe tenant-scoped approval/payment projections", async () => {
    const fixture = await seedFixture(pool);
    const { service } = buildService(pool);

    try {
      const first = await service.listApprovals(fixture.organizationId, {
        status: "PENDING",
        limit: 1,
      });
      expect(first.items).toHaveLength(1);
      expect(first.items[0]).toMatchObject({
        organizationId: fixture.organizationId,
        status: "PENDING",
        amountMinor: "9007199254740993000",
        voteCount: 0,
      });
      if (!first.nextCursor) {
        throw new Error("expected a second approval page");
      }
      const second = await service.listApprovals(fixture.organizationId, {
        status: "PENDING",
        limit: 1,
        cursor: first.nextCursor,
      });
      expect(second.items).toHaveLength(1);
      expect(second.items[0]!.id).not.toBe(first.items[0]!.id);

      const expired = await service.listApprovals(fixture.organizationId, { status: "EXPIRED" });
      expect(expired.items.map((item) => item.id)).toContain(fixture.expiredApprovalId);
      expect(await approvalStatus(pool, fixture.expiredApprovalId)).toBe("PENDING");

      const detail = await service.getApproval(fixture.organizationId, fixture.primaryApprovalId);
      expect(detail?.votes).toEqual([]);
      const approvalText = JSON.stringify(detail);
      for (const secret of [
        "approval-payload-secret",
        "approval-session-secret",
        "approval-idempotency-primary",
        "approval-request-digest-primary",
      ]) {
        expect(approvalText).not.toContain(secret);
      }

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
      for (const secret of [
        "merchant-response-body-secret",
        "merchant-response-header-secret",
        "payment-idempotency-primary",
        "payment-request-digest-primary",
        "lease-worker-secret",
      ]) {
        expect(paymentText).not.toContain(secret);
      }

      expect(
        await service.getApproval(fixture.organizationId, fixture.otherApprovalId),
      ).toBeUndefined();
      expect(
        await service.getPayment(fixture.organizationId, fixture.otherPaymentOutcomeId),
      ).toBeUndefined();
    } finally {
      await cleanupFixture(pool, fixture);
    }
  });

  it("casts distinct admin votes atomically with signed audit and preserves terminal rules", async () => {
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
      if (firstVote.outcome !== "UPDATED") throw new Error("expected first vote");
      expect(firstVote.approval).toMatchObject({
        status: "PENDING",
        requiredSignatures: 2,
        voteCount: 1,
        approveCount: 1,
      });
      expect(await auditCount(pool, fixture.organizationId)).toBe("1");

      const replay = await service.castApprovalVote(firstActor, fixture.primaryApprovalId, {
        decision: "APPROVE",
        comment: "changed comment on an exact decision replay",
      });
      expect(replay.outcome).toBe("REPLAYED");
      expect(await auditCount(pool, fixture.organizationId)).toBe("1");

      expect(
        (
          await service.castApprovalVote(firstActor, fixture.primaryApprovalId, {
            decision: "REJECT",
          })
        ).outcome,
      ).toBe("CONFLICT");
      expect(await auditCount(pool, fixture.organizationId)).toBe("1");

      const secondVote = await service.castApprovalVote(secondActor, fixture.primaryApprovalId, {
        decision: "APPROVE",
      });
      expect(secondVote.outcome).toBe("UPDATED");
      if (secondVote.outcome !== "UPDATED") throw new Error("expected second vote");
      expect(secondVote.approval).toMatchObject({
        status: "APPROVED",
        voteCount: 2,
        approveCount: 2,
      });
      expect(secondVote.approval.votes?.map((vote) => vote.identity.type)).toEqual([
        "ADMIN_PRINCIPAL",
        "ADMIN_PRINCIPAL",
      ]);
      expect(await auditCount(pool, fixture.organizationId)).toBe("2");

      expect(
        (
          await service.castApprovalVote(
            actorFor(fixture.organizationId),
            fixture.primaryApprovalId,
            { decision: "REJECT" },
          )
        ).outcome,
      ).toBe("ALREADY_RESOLVED");
      expect(await auditCount(pool, fixture.organizationId)).toBe("2");

      const expired = await service.castApprovalVote(
        actorFor(fixture.organizationId),
        fixture.expiredApprovalId,
        { decision: "APPROVE" },
      );
      expect(expired.outcome).toBe("ALREADY_RESOLVED");
      expect(await approvalStatus(pool, fixture.expiredApprovalId)).toBe("EXPIRED");
      expect(await auditCount(pool, fixture.organizationId)).toBe("2");

      const rejected = await service.castApprovalVote(
        actorFor(fixture.organizationId),
        fixture.rejectableApprovalId,
        { decision: "REJECT" },
      );
      expect(rejected.outcome).toBe("UPDATED");
      if (rejected.outcome !== "UPDATED") throw new Error("expected rejection");
      expect(rejected.approval.status).toBe("REJECTED");
      expect(await auditCount(pool, fixture.organizationId)).toBe("3");

      const audits = await pool.query<{ permission: string; action: string }>(
        `select "permission", "action" from "AdminAuditLog"
          where "organizationId" = $1::uuid order by "chainSequence" asc`,
        [fixture.organizationId],
      );
      expect(audits.rows).toEqual([
        { permission: "approval.vote", action: "approval.vote" },
        { permission: "approval.vote", action: "approval.vote" },
        { permission: "approval.vote", action: "approval.vote" },
      ]);
      expect(JSON.stringify(audits.rows)).not.toContain("first approval");
      expect(await verifier.verifyOrganization(fixture.organizationId)).toMatchObject({
        valid: true,
        checkedEvents: 3,
      });
    } finally {
      await cleanupFixture(pool, fixture);
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
    service: new PostgresAdminTransactionApprovalOperations(sql, audit, randomUUID, () => now),
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
  const local = await seedAuthority(pool, organizationId, "local");
  const other = await seedAuthority(pool, otherOrganizationId, "other");
  const primaryApprovalId = randomUUID();
  const secondaryApprovalId = randomUUID();
  const expiredApprovalId = randomUUID();
  const rejectableApprovalId = randomUUID();
  const otherApprovalId = randomUUID();
  const paymentOutcomeId = randomUUID();
  const otherPaymentOutcomeId = randomUUID();

  await insertApproval(pool, {
    id: primaryApprovalId,
    ...local,
    createdAt: "2026-08-16T17:20:00.000Z",
    expiresAt: "2026-08-16T18:00:00.000Z",
    idempotencyKey: "approval-idempotency-primary",
    requestDigest: "approval-request-digest-primary",
  });
  await insertApproval(pool, {
    id: secondaryApprovalId,
    ...local,
    createdAt: "2026-08-16T17:10:00.000Z",
    expiresAt: "2026-08-16T18:10:00.000Z",
    idempotencyKey: "approval-idempotency-secondary",
    requestDigest: "approval-request-digest-secondary",
  });
  await insertApproval(pool, {
    id: expiredApprovalId,
    ...local,
    createdAt: "2026-08-16T16:00:00.000Z",
    expiresAt: "2026-08-16T17:00:00.000Z",
    idempotencyKey: "approval-idempotency-expired",
    requestDigest: "approval-request-digest-expired",
  });
  await insertApproval(pool, {
    id: rejectableApprovalId,
    ...local,
    createdAt: "2026-08-16T17:05:00.000Z",
    expiresAt: "2026-08-16T18:05:00.000Z",
    idempotencyKey: "approval-idempotency-reject",
    requestDigest: "approval-request-digest-reject",
  });
  await insertApproval(pool, {
    id: otherApprovalId,
    ...other,
    createdAt: "2026-08-16T17:25:00.000Z",
    expiresAt: "2026-08-16T18:25:00.000Z",
    idempotencyKey: "approval-idempotency-other",
    requestDigest: "approval-request-digest-other",
  });

  await insertPayment(pool, paymentOutcomeId, local, true);
  await insertPayment(pool, otherPaymentOutcomeId, other, false);

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

interface AuthorityIds {
  organizationId: string;
  userId: string;
  agentId: string;
  mandateId: string;
}

async function seedAuthority(pool: Pool, organizationId: string, label: string): Promise<AuthorityIds> {
  const userId = randomUUID();
  const agentId = randomUUID();
  const policyId = randomUUID();
  const mandateId = randomUUID();
  await pool.query(
    `insert into "Organization" ("id", "name", "createdAt", "updatedAt")
     values ($1::uuid, $2, now(), now())`,
    [organizationId, `Admin operations ${label}`],
  );
  await pool.query(
    `insert into "User" ("id", "organizationId", "email", "status", "createdAt", "updatedAt")
     values ($1, $2, $3, 'ACTIVE', now(), now())`,
    [userId, organizationId, `${userId}@example.test`],
  );
  await pool.query(
    `insert into "AgentIdentity" ("id", "organizationId", "externalAgentId", "status", "createdAt", "updatedAt")
     values ($1, $2, $3, 'ACTIVE', now(), now())`,
    [agentId, organizationId, `${label}-agent-${agentId}`],
  );
  await pool.query(
    `insert into "Policy" (
       "id", "organizationId", "name", "version", "active", "baseCurrency", "maxBudgetMinor",
       "rollingDailyLimitMinor", "approvedMerchantDomains", "approvedVendorIds", "restrictedCategories",
       "approvalMode", "maxTransactionsPerMinute", "crossMerchantWindowSecs", "maxDistinctMerchants",
       "createdAt", "updatedAt"
     ) values ($1, $2, $3, 1, true, 'USD', 9007199254740993000, 9223372036854775807,
       ARRAY['shop.example.com'], ARRAY['vendor-1'], ARRAY['GAMBLING'], 'DUAL_SIGNATURE_SLACK',
       10, 60, 5, now(), now())`,
    [policyId, organizationId, `Policy ${label}`],
  );
  await pool.query(
    `insert into "AgentMandate" (
       "id", "organizationId", "userId", "agentId", "policyId", "tokenJtiHash", "policyVersion",
       "currency", "maxBudgetMinor", "rollingDailyLimitMinor", "approvedMerchantDomains",
       "approvedVendorIds", "restrictedCategories", "approvalMode", "maxTransactionsPerMinute",
       "crossMerchantWindowSecs", "maxDistinctMerchants", "delegationPayloadHash", "signingKeyId",
       "status", "issuedAt", "expiresAt"
     ) values ($1, $2, $3, $4, $5, $6, 1, 'USD', 9007199254740993000, 9223372036854775807,
       ARRAY['shop.example.com'], ARRAY['vendor-1'], ARRAY['GAMBLING'], 'DUAL_SIGNATURE_SLACK',
       10, 60, 5, $7, 'mandate-k1', 'ACTIVE', $8, $9)`,
    [
      mandateId,
      organizationId,
      userId,
      agentId,
      policyId,
      `${label}-jti-${mandateId}`,
      `${label}-delegation-hash`,
      new Date("2026-08-16T16:00:00.000Z"),
      new Date("2026-09-16T16:00:00.000Z"),
    ],
  );
  return { organizationId, userId, agentId, mandateId };
}

async function insertApproval(
  pool: Pool,
  input: AuthorityIds & {
    id: string;
    createdAt: string;
    expiresAt: string;
    idempotencyKey: string;
    requestDigest: string;
  },
): Promise<void> {
  await pool.query(
    `insert into "ApprovalRequest" (
       "id", "organizationId", "userId", "agentId", "mandateId", "decisionId", "requestId",
       "idempotencyKey", "requestDigest", "policyVersion", "merchantId", "merchantDomain",
       "checkoutSessionId", "requestedPayload", "sessionSnapshot", "spendSnapshot", "reasonCodes",
       "amountMinor", "currency", "status", "requiredSignatures", "createdAt", "expiresAt"
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, 'merchant-1', 'shop.example.com',
       'checkout-1', $10::jsonb, $11::jsonb, $12::jsonb, ARRAY['TRANSACTION_LIMIT_EXCEEDED'],
       9007199254740993000, 'USD', 'PENDING', 2, $13, $14)`,
    [
      input.id,
      input.organizationId,
      input.userId,
      input.agentId,
      input.mandateId,
      `decision-${input.id}`,
      `request-${input.id}`,
      input.idempotencyKey,
      input.requestDigest,
      JSON.stringify({ card: "approval-payload-secret" }),
      JSON.stringify({ authorization: "approval-session-secret" }),
      JSON.stringify({ committedMinor: "100", reservedMinor: "50" }),
      new Date(input.createdAt),
      new Date(input.expiresAt),
    ],
  );
}

async function insertPayment(
  pool: Pool,
  id: string,
  authority: AuthorityIds,
  unresolved: boolean,
): Promise<void> {
  await pool.query(
    `insert into "PaymentOutcome" (
       "id", "organizationId", "userId", "agentId", "mandateId", "reservationId",
       "idempotencyKey", "requestDigest", "merchantId", "merchantDomain", "checkoutSessionId",
       "amountMinor", "currency", "status", "upstreamStatus", "responseBody", "responseHeaders",
       "lastErrorCode", "forwardedAt", "resolvedAt", "lastReconciledAt", "reconcileAttempts",
       "nextReconcileAt", "reconciliationLeaseOwner", "reconciliationLeaseExpiresAt",
       "createdAt", "updatedAt"
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, 'merchant-1', 'shop.example.com', 'checkout-1',
       $9, 'USD', $10::"PaymentOutcomeStatus", $11, $12::jsonb, $13::jsonb, $14,
       $15, $16, $17, $18, $19, $20, $21, $15, $17)`,
    [
      id,
      authority.organizationId,
      authority.userId,
      authority.agentId,
      authority.mandateId,
      `reservation-${id}`,
      unresolved ? "payment-idempotency-primary" : `payment-idempotency-${id}`,
      unresolved ? "payment-request-digest-primary" : `payment-request-digest-${id}`,
      unresolved ? "9223372036854775807" : "1000",
      unresolved ? "UNKNOWN" : "SUCCEEDED",
      unresolved ? 503 : 200,
      JSON.stringify({ secret: unresolved ? "merchant-response-body-secret" : "other" }),
      JSON.stringify({ authorization: unresolved ? "merchant-response-header-secret" : "other" }),
      unresolved ? "MERCHANT_TRANSPORT_ERROR" : null,
      new Date("2026-08-16T17:15:00.000Z"),
      unresolved ? null : new Date("2026-08-16T17:20:00.000Z"),
      new Date("2026-08-16T17:20:00.000Z"),
      unresolved ? 3 : 0,
      unresolved ? new Date("2026-08-16T17:40:00.000Z") : null,
      unresolved ? "lease-worker-secret" : null,
      unresolved ? new Date("2026-08-16T17:35:00.000Z") : null,
    ],
  );
}

async function approvalStatus(pool: Pool, approvalId: string): Promise<string | undefined> {
  return (
    await pool.query<{ status: string }>(
      `select "status"::text as status from "ApprovalRequest" where "id" = $1::uuid`,
      [approvalId],
    )
  ).rows[0]?.status;
}

async function auditCount(pool: Pool, organizationId: string): Promise<string | undefined> {
  return (
    await pool.query<{ count: string }>(
      `select count(*)::text as count from "AdminAuditLog" where "organizationId" = $1::uuid`,
      [organizationId],
    )
  ).rows[0]?.count;
}

async function cleanupFixture(pool: Pool, fixture: Fixture): Promise<void> {
  const ids = [fixture.organizationId, fixture.otherOrganizationId];
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
