import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProductionConfig } from "../../src/infrastructure/config/production-config.js";
import { createProductionApplication } from "../../src/production/application.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const issuer = "https://operations-login.example.test/";
const audience = "mino-admin";
const now = new Date("2026-08-16T18:30:00.000Z");

integration("production administrative transaction and approval HTTP surface", () => {
  let pool: Pool;
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const approverPrincipalId = randomUUID();
  const approverMembershipId = randomUUID();
  const financePrincipalId = randomUUID();
  const financeMembershipId = randomUUID();
  const userId = randomUUID();
  const agentId = randomUUID();
  const policyId = randomUUID();
  const mandateId = randomUUID();
  const approvalId = randomUUID();
  const paymentId = randomUUID();
  const jwtKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(
      `insert into "Organization" ("id", "name", "createdAt", "updatedAt")
       values ($1, 'Operations HTTP org', now(), now()),
              ($2, 'Operations HTTP other org', now(), now())`,
      [organizationId, otherOrganizationId],
    );
    await pool.query(
      `insert into "User" ("id", "organizationId", "email", "status", "createdAt", "updatedAt")
       values ($1, $2, $3, 'ACTIVE', now(), now())`,
      [userId, organizationId, `${userId}@example.test`],
    );
    await pool.query(
      `insert into "AgentIdentity"
        ("id", "organizationId", "externalAgentId", "status", "createdAt", "updatedAt")
       values ($1, $2, $3, 'ACTIVE', now(), now())`,
      [agentId, organizationId, `operations-agent-${agentId}`],
    );
    await pool.query(
      `insert into "Policy" (
         "id", "organizationId", "name", "version", "active", "baseCurrency",
         "maxBudgetMinor", "rollingDailyLimitMinor", "approvedMerchantDomains", "approvedVendorIds",
         "restrictedCategories", "approvalMode", "maxTransactionsPerMinute",
         "crossMerchantWindowSecs", "maxDistinctMerchants", "createdAt", "updatedAt"
       ) values (
         $1, $2, 'Operations HTTP', 7, true, 'USD', 9007199254740993000, 9223372036854775807,
         ARRAY['shop.example.com'], ARRAY['vendor-1'], ARRAY['GAMBLING'],
         'DUAL_SIGNATURE_SLACK', 10, 60, 5, now(), now()
       )`,
      [policyId, organizationId],
    );
    await pool.query(
      `insert into "AgentMandate" (
         "id", "organizationId", "userId", "agentId", "policyId", "tokenJtiHash", "policyVersion",
         "currency", "maxBudgetMinor", "rollingDailyLimitMinor", "approvedMerchantDomains",
         "approvedVendorIds", "restrictedCategories", "approvalMode", "maxTransactionsPerMinute",
         "crossMerchantWindowSecs", "maxDistinctMerchants", "delegationPayloadHash", "signingKeyId",
         "status", "issuedAt", "expiresAt"
       ) values (
         $1, $2, $3, $4, $5, $6, 7, 'USD', 9007199254740993000, 9223372036854775807,
         ARRAY['shop.example.com'], ARRAY['vendor-1'], ARRAY['GAMBLING'], 'DUAL_SIGNATURE_SLACK',
         10, 60, 5, 'operations-delegation-hash', 'mino-k1', 'ACTIVE', $7, $8
       )`,
      [
        mandateId,
        organizationId,
        userId,
        agentId,
        policyId,
        `operations-jti-${mandateId}`,
        new Date("2026-08-16T18:00:00.000Z"),
        new Date("2026-09-16T18:00:00.000Z"),
      ],
    );
    await pool.query(
      `insert into "ApprovalRequest" (
         "id", "organizationId", "userId", "agentId", "mandateId", "decisionId", "requestId",
         "idempotencyKey", "requestDigest", "policyVersion", "merchantId", "merchantDomain",
         "checkoutSessionId", "requestedPayload", "sessionSnapshot", "spendSnapshot", "reasonCodes",
         "amountMinor", "currency", "status", "requiredSignatures", "createdAt", "expiresAt"
       ) values (
         $1, $2, $3, $4, $5, $6, $7,
         'operations-approval-idempotency-secret', 'operations-approval-digest-secret', 7,
         'merchant-1', 'shop.example.com', 'checkout-1', $8::jsonb, $9::jsonb, $10::jsonb,
         ARRAY['TRANSACTION_LIMIT_EXCEEDED'], 9007199254740993000, 'USD', 'PENDING', 2, $11, $12
       )`,
      [
        approvalId,
        organizationId,
        userId,
        agentId,
        mandateId,
        `decision-${approvalId}`,
        `request-${approvalId}`,
        JSON.stringify({ bearer: "approval-payload-secret" }),
        JSON.stringify({ authorization: "approval-session-secret" }),
        JSON.stringify({ committedMinor: "100", reservedMinor: "50" }),
        new Date("2026-08-16T18:10:00.000Z"),
        new Date("2026-08-16T19:00:00.000Z"),
      ],
    );
    await pool.query(
      `insert into "PaymentOutcome" (
         "id", "organizationId", "userId", "agentId", "mandateId", "reservationId",
         "idempotencyKey", "requestDigest", "merchantId", "merchantDomain", "checkoutSessionId",
         "amountMinor", "currency", "status", "upstreamStatus", "responseBody", "responseHeaders",
         "lastErrorCode", "forwardedAt", "lastReconciledAt", "reconcileAttempts", "nextReconcileAt",
         "reconciliationLeaseOwner", "reconciliationLeaseExpiresAt", "createdAt", "updatedAt"
       ) values (
         $1, $2, $3, $4, $5, 'operations-reservation-1',
         'operations-payment-idempotency-secret', 'operations-payment-digest-secret',
         'merchant-1', 'shop.example.com', 'checkout-1', 9223372036854775807, 'USD', 'UNKNOWN', 503,
         $6::jsonb, $7::jsonb, 'MERCHANT_TRANSPORT_ERROR', $8, $9, 2, $10,
         'operations-lease-secret', $11, $8, $9
       )`,
      [
        paymentId,
        organizationId,
        userId,
        agentId,
        mandateId,
        JSON.stringify({ token: "merchant-response-body-secret" }),
        JSON.stringify({ authorization: "merchant-response-header-secret" }),
        new Date("2026-08-16T18:15:00.000Z"),
        new Date("2026-08-16T18:20:00.000Z"),
        new Date("2026-08-16T18:40:00.000Z"),
        new Date("2026-08-16T18:35:00.000Z"),
      ],
    );

    await pool.query(
      `insert into "AdminPrincipal"
        ("id", "issuer", "subject", "status", "createdAt", "updatedAt")
       values
        ($1, $2, 'operations-approver', 'ACTIVE', now(), now()),
        ($3, $2, 'operations-finance', 'ACTIVE', now(), now())`,
      [approverPrincipalId, issuer, financePrincipalId],
    );
    await pool.query(
      `insert into "AdminOrganizationMembership"
        ("id", "organizationId", "principalId", "status", "createdAt", "updatedAt")
       values
        ($1, $2, $3, 'ACTIVE', now(), now()),
        ($4, $2, $5, 'ACTIVE', now(), now())`,
      [
        approverMembershipId,
        organizationId,
        approverPrincipalId,
        financeMembershipId,
        financePrincipalId,
      ],
    );
    await pool.query(
      `insert into "AdminRoleAssignment" ("id", "membershipId", "role", "assignedAt")
       values
        ($1, $2, 'APPROVER', now()),
        ($3, $4, 'FINANCE_MANAGER', now())`,
      [randomUUID(), approverMembershipId, randomUUID(), financeMembershipId],
    );
  });

  afterAll(async () => {
    const organizationIds = [organizationId, otherOrganizationId];
    await pool.query(`delete from "AdminAuditLog" where "organizationId" = any($1::uuid[])`, [organizationIds]);
    await pool.query(`delete from "AdminAuditChainHead" where "organizationId" = any($1::uuid[])`, [organizationIds]);
    await pool.query(`delete from "ApprovalRequest" where "organizationId" = any($1::uuid[])`, [organizationIds]);
    await pool.query(`delete from "PaymentOutcome" where "organizationId" = any($1::uuid[])`, [organizationIds]);
    await pool.query(`delete from "AgentMandate" where "organizationId" = any($1::uuid[])`, [organizationIds]);
    await pool.query(`delete from "Policy" where "organizationId" = any($1::uuid[])`, [organizationIds]);
    await pool.query(`delete from "AgentIdentity" where "organizationId" = any($1::uuid[])`, [organizationIds]);
    await pool.query(`delete from "User" where "organizationId" = any($1::uuid[])`, [organizationIds]);
    await pool.query(`delete from "Organization" where "id" = any($1::uuid[])`, [organizationIds]);
    await pool.query(`delete from "AdminPrincipal" where "id" = any($1::uuid[])`, [
      [approverPrincipalId, financePrincipalId],
    ]);
    await pool.end();
  });

  it("exposes safe operational reads and routes votes through real JWT/RBAC without payment override authority", async () => {
    const publicPem = pemPublic(jwtKeys.publicKey);
    const production = await createProductionApplication(productionConfig(), {
      logger: false,
      now: () => now,
      adminJwtIssuers: [
        {
          issuer,
          audience,
          verificationKeys: new Map([["operations-rsa-1", publicPem]]),
        },
      ],
    });
    const approverHeaders = {
      authorization: `Bearer ${adminToken(jwtKeys.privateKey, "operations-approver")}`,
    };
    const financeHeaders = {
      authorization: `Bearer ${adminToken(jwtKeys.privateKey, "operations-finance")}`,
    };
    const approvalsBase = `/v1/admin/organizations/${organizationId}/approvals`;
    const paymentsBase = `/v1/admin/organizations/${organizationId}/payments`;

    try {
      const approvals = await production.app.inject({
        method: "GET",
        url: `${approvalsBase}?status=PENDING&merchantId=merchant-1`,
        headers: financeHeaders,
      });
      expect(approvals.statusCode).toBe(200);
      expect(approvals.headers["cache-control"]).toBe("no-store");
      expect(approvals.json()).toMatchObject({
        items: [
          {
            id: approvalId,
            amountMinor: "9007199254740993000",
            status: "PENDING",
            requiredSignatures: 2,
            voteCount: 0,
          },
        ],
      });
      for (const secret of [
        "approval-payload-secret",
        "approval-session-secret",
        "operations-approval-idempotency-secret",
        "operations-approval-digest-secret",
      ]) {
        expect(approvals.body).not.toContain(secret);
      }

      const payment = await production.app.inject({
        method: "GET",
        url: `${paymentsBase}/${paymentId}`,
        headers: financeHeaders,
      });
      expect(payment.statusCode).toBe(200);
      expect(payment.json()).toMatchObject({
        payment: {
          id: paymentId,
          amountMinor: "9223372036854775807",
          status: "UNKNOWN",
          reconciliationState: "PENDING",
          reconcileAttempts: 2,
          lastErrorCode: "MERCHANT_TRANSPORT_ERROR",
        },
      });
      for (const secret of [
        "merchant-response-body-secret",
        "merchant-response-header-secret",
        "operations-payment-idempotency-secret",
        "operations-payment-digest-secret",
        "operations-lease-secret",
      ]) {
        expect(payment.body).not.toContain(secret);
      }

      const financeVote = await production.app.inject({
        method: "POST",
        url: `${approvalsBase}/${approvalId}/votes`,
        headers: financeHeaders,
        payload: { decision: "APPROVE" },
      });
      expect(financeVote.statusCode).toBe(403);
      expect(financeVote.json()).toEqual({ error: "forbidden" });

      const vote = await production.app.inject({
        method: "POST",
        url: `${approvalsBase}/${approvalId}/votes`,
        headers: approverHeaders,
        payload: { decision: "APPROVE", comment: "reviewed in console" },
      });
      expect(vote.statusCode).toBe(200);
      expect(vote.json()).toMatchObject({
        outcome: "UPDATED",
        changed: true,
        approval: {
          id: approvalId,
          status: "PENDING",
          voteCount: 1,
          approveCount: 1,
        },
      });

      const persistedVote = await pool.query<{ approverId: string; decision: string }>(
        `select "approverId", "decision"::text as decision
           from "ApprovalVote"
          where "approvalRequestId" = $1::uuid`,
        [approvalId],
      );
      expect(persistedVote.rows).toEqual([
        {
          approverId: `admin-principal:${approverPrincipalId}`,
          decision: "APPROVE",
        },
      ]);

      const detail = await production.app.inject({
        method: "GET",
        url: `${approvalsBase}/${approvalId}`,
        headers: approverHeaders,
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({
        approval: {
          id: approvalId,
          votes: [
            {
              identity: { type: "ADMIN_PRINCIPAL", principalId: approverPrincipalId },
              decision: "APPROVE",
            },
          ],
        },
      });

      const voteReplay = await production.app.inject({
        method: "POST",
        url: `${approvalsBase}/${approvalId}/votes`,
        headers: approverHeaders,
        payload: { decision: "APPROVE" },
      });
      expect(voteReplay.statusCode).toBe(200);
      expect(voteReplay.json()).toMatchObject({ outcome: "REPLAYED", changed: false });

      const forbiddenPaymentMutation = await production.app.inject({
        method: "POST",
        url: `${paymentsBase}/${paymentId}/succeed`,
        headers: approverHeaders,
        payload: {},
      });
      expect(forbiddenPaymentMutation.statusCode).toBe(404);
      expect(
        (
          await pool.query<{ status: string }>(
            `select "status"::text as status from "PaymentOutcome" where "id" = $1::uuid`,
            [paymentId],
          )
        ).rows[0]?.status,
      ).toBe("UNKNOWN");

      const wrongTenant = await production.app.inject({
        method: "GET",
        url: `/v1/admin/organizations/${otherOrganizationId}/approvals`,
        headers: approverHeaders,
      });
      expect(wrongTenant.statusCode).toBe(403);

      const audits = await pool.query<{ permission: string; action: string }>(
        `select "permission", "action" from "AdminAuditLog"
          where "organizationId" = $1::uuid order by "chainSequence" asc`,
        [organizationId],
      );
      expect(audits.rows).toEqual([{ permission: "approval.vote", action: "approval.vote" }]);
      expect(await production.adminAuditVerifier.verifyOrganization(organizationId)).toMatchObject({
        valid: true,
        checkedEvents: 1,
      });
    } finally {
      await production.close();
    }
  });
});

function adminToken(privateKey: KeyObject, subject: string): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "operations-rsa-1", typ: "JWT" }),
    "utf8",
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: issuer,
      sub: subject,
      aud: audience,
      iat: Math.floor(now.getTime() / 1_000) - 60,
      exp: Math.floor(now.getTime() / 1_000) + 300,
    }),
    "utf8",
  ).toString("base64url");
  const signingInput = Buffer.from(`${header}.${payload}`, "ascii");
  return `${header}.${payload}.${sign("RSA-SHA256", signingInput, privateKey).toString("base64url")}`;
}

function productionConfig(): ProductionConfig {
  const mandateKeys = generateKeyPairSync("ed25519");
  const delegationKeys = generateKeyPairSync("ed25519");
  const auditKeys = generateKeyPairSync("ed25519");
  return {
    databaseUrl: DATABASE_URL,
    redisUrl: REDIS_URL,
    host: "127.0.0.1",
    port: 3000,
    issuer: "https://mino.example",
    mandateVerificationKeys: new Map([["mino-k1", pemPublic(mandateKeys.publicKey)]]),
    delegationSigningKey: {
      keyId: "delegation-k1",
      privateKey: pemPrivate(delegationKeys.privateKey),
    },
    auditSigningKey: { keyId: "audit-k1", privateKey: pemPrivate(auditKeys.privateKey) },
    auditVerificationKeys: new Map([["audit-k1", pemPublic(auditKeys.publicKey)]]),
    approvalResolutionSecret: "r".repeat(32),
    approvalWebhook: { endpoint: "https://approvals.example/webhook", secret: "w".repeat(32) },
    merchantCredentials: new Map(),
  };
}

function pemPublic(key: KeyObject): string {
  return key.export({ type: "spki", format: "pem" }).toString();
}

function pemPrivate(key: KeyObject): string {
  return key.export({ type: "pkcs8", format: "pem" }).toString();
}
