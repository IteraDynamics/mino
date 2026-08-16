import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DecisionReason } from "../../src/domain/evaluation/decision-reasons.js";
import { DecisionVerdict, type PolicyDecision } from "../../src/domain/evaluation/evaluation.types.js";
import type { ProductionConfig } from "../../src/infrastructure/config/production-config.js";
import { StaticAuditKeyProvider } from "../../src/infrastructure/crypto/static-key-providers.js";
import { PgSqlAdapter } from "../../src/infrastructure/postgres/pg-sql-adapter.js";
import {
  PostgresAdminAuditCheckpointIssuer,
  type AdminAuditChainCheckpoint,
} from "../../src/modules/admin/admin-audit-checkpoint-retention.js";
import { PostgresAdminChangeAuditLedger } from "../../src/modules/admin/admin-change-audit-ledger.js";
import type { GatewayAuditEvent } from "../../src/modules/audit/audit-sink.js";
import { PostgresAuditLedger, type AuditChainCheckpoint } from "../../src/modules/audit/postgres-audit-ledger.js";
import { createProductionApplication } from "../../src/production/application.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const issuer = "https://audit-operations-login.example.test/";
const audience = "mino-admin";
const now = new Date("2026-08-16T20:00:00.000Z");

integration("production administrative audit and operations HTTP surface", () => {
  let pool: Pool;
  let transactionCheckpoint: AuditChainCheckpoint;
  let adminCheckpoint: AdminAuditChainCheckpoint;

  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const userId = randomUUID();
  const agentId = randomUUID();
  const policyId = randomUUID();
  const mandateId = randomUUID();
  const paymentId = randomUUID();
  const approvalId = randomUUID();
  const financePrincipalId = randomUUID();
  const financeMembershipId = randomUUID();
  const auditorPrincipalId = randomUUID();
  const auditorMembershipId = randomUUID();
  const jwtKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const auditKeys = generateKeyPairSync("ed25519");

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await seedAuthority();
    await seedOperations();
    await seedAdminIdentities();

    const provider = new StaticAuditKeyProvider(
      { keyId: "audit-http-k1", privateKey: pemPrivate(auditKeys.privateKey) },
      new Map([["audit-http-k1", pemPublic(auditKeys.publicKey)]]),
    );
    const sql = new PgSqlAdapter(pool);
    const transactionLedger = new PostgresAuditLedger(sql, provider);
    const adminLedger = new PostgresAdminChangeAuditLedger(sql, provider);
    const adminCheckpointIssuer = new PostgresAdminAuditCheckpointIssuer(sql, provider);

    await transactionLedger.record(transactionEvent());
    await adminLedger.append({
      requestId: randomUUID(),
      organizationId,
      principalId: financePrincipalId,
      membershipId: financeMembershipId,
      timestamp: new Date(now.getTime() - 5 * 60_000),
      permission: "mandate.revoke",
      action: "mandate.revoke",
      resourceType: "mandate",
      resourceId: mandateId,
      roles: ["FINANCE_MANAGER"],
      beforeState: { status: "ACTIVE", token: "HTTP-ADMIN-STATE-SECRET" },
      afterState: { status: "REVOKED" },
      requestDigest: "HTTP-ADMIN-DIGEST-SECRET",
      metadata: { authorization: "HTTP-ADMIN-METADATA-SECRET" },
    });
    transactionCheckpoint = await transactionLedger.issueCheckpoint(organizationId, now);
    adminCheckpoint = await adminCheckpointIssuer.issueCheckpoint(organizationId, now);
  });

  afterAll(async () => {
    const organizations = [organizationId, otherOrganizationId];
    for (const table of [
      "AdminAuditLog",
      "AdminAuditChainHead",
      "AuditLog",
      "AuditChainHead",
      "ApprovalRequest",
      "PaymentOutcome",
      "AgentMandate",
      "Policy",
      "AgentIdentity",
      "User",
    ]) {
      await pool.query(`delete from "${table}" where "organizationId" = any($1::uuid[])`, [
        organizations,
      ]);
    }
    await pool.query(`delete from "Organization" where "id" = any($1::uuid[])`, [organizations]);
    await pool.query(`delete from "AdminPrincipal" where "id" = any($1::uuid[])`, [
      [financePrincipalId, auditorPrincipalId],
    ]);
    await pool.end();
  });

  it("exposes safe evidence, separates read/verify authority, and cannot mutate economic or audit truth", async () => {
    const production = await createProductionApplication(productionConfig(), {
      logger: false,
      now: () => now,
      adminJwtIssuers: [
        {
          issuer,
          audience,
          verificationKeys: new Map([["audit-http-rsa-1", pemPublic(jwtKeys.publicKey)]]),
        },
      ],
    });
    const financeHeaders = authHeaders("audit-finance");
    const auditorHeaders = authHeaders("audit-auditor");
    const base = `/v1/admin/organizations/${organizationId}`;

    try {
      const transactions = await production.app.inject({
        method: "GET",
        url: `${base}/audit/transactions`,
        headers: financeHeaders,
      });
      expect(transactions.statusCode).toBe(200);
      expect(transactions.headers["cache-control"]).toBe("no-store");
      expect(transactions.json()).toMatchObject({
        items: [{ chainSequence: "1", verdict: "ALLOW", operation: "complete_checkout" }],
      });
      for (const hidden of [
        "HTTP-TX-PAYLOAD-SECRET",
        "HTTP-TX-DIGEST-SECRET",
        "requestedPayload",
        "decisionSnapshot",
        "integritySignature",
      ]) {
        expect(transactions.body).not.toContain(hidden);
      }

      const administrative = await production.app.inject({
        method: "GET",
        url: `${base}/audit/administrative`,
        headers: financeHeaders,
      });
      expect(administrative.statusCode).toBe(200);
      expect(administrative.json()).toMatchObject({
        items: [
          {
            chainSequence: "1",
            permission: "mandate.revoke",
            action: "mandate.revoke",
            resourceId: mandateId,
          },
        ],
      });
      for (const hidden of [
        "HTTP-ADMIN-STATE-SECRET",
        "HTTP-ADMIN-DIGEST-SECRET",
        "HTTP-ADMIN-METADATA-SECRET",
        "beforeState",
        "afterState",
        "integritySignature",
      ]) {
        expect(administrative.body).not.toContain(hidden);
      }

      const operations = await production.app.inject({
        method: "GET",
        url: `${base}/operations`,
        headers: financeHeaders,
      });
      expect(operations.statusCode).toBe(200);
      expect(operations.json()).toMatchObject({
        operations: {
          payments: {
            unknown: 1,
            unresolved: 1,
            claimable: 1,
            stale: 1,
            highAttempt: 1,
            oldestUnresolvedPaymentId: paymentId,
          },
          approvals: { pending: 1, notificationPending: 1, notificationClaimable: 1 },
          audit: {
            transaction: { headSequence: "1" },
            administrative: { headSequence: "1" },
          },
        },
      });
      expect(operations.body).not.toContain("HTTP-PAYMENT-DIGEST-SECRET");
      expect(operations.body).not.toContain("HTTP-APPROVAL-PAYLOAD-SECRET");

      const financeVerify = await production.app.inject({
        method: "POST",
        url: `${base}/audit/transactions/verify`,
        headers: financeHeaders,
        payload: {},
      });
      expect(financeVerify.statusCode).toBe(403);

      const transactionVerify = await production.app.inject({
        method: "POST",
        url: `${base}/audit/transactions/verify`,
        headers: auditorHeaders,
        payload: { retainedCheckpoint: transactionCheckpoint },
      });
      expect(transactionVerify.statusCode).toBe(200);
      expect(transactionVerify.json()).toMatchObject({
        chain: "transaction",
        databaseVerification: { valid: true, checkedEvents: 1, headSequence: "1" },
        retainedCheckpointVerification: { valid: true, checkedEvents: 1, headSequence: "1" },
      });
      expect(transactionVerify.body).not.toContain(transactionCheckpoint.signature);

      const adminVerify = await production.app.inject({
        method: "POST",
        url: `${base}/audit/administrative/verify`,
        headers: auditorHeaders,
        payload: { retainedCheckpoint: adminCheckpoint },
      });
      expect(adminVerify.statusCode).toBe(200);
      expect(adminVerify.json()).toMatchObject({
        chain: "administrative",
        databaseVerification: { valid: true, checkedEvents: 1, headSequence: "1" },
        retainedCheckpointVerification: {
          valid: true,
          checkpointSequence: "1",
          currentHeadSequence: "1",
        },
      });
      expect(adminVerify.body).not.toContain(adminCheckpoint.signature);

      expect(
        (
          await production.app.inject({
            method: "GET",
            url: `/v1/admin/organizations/${otherOrganizationId}/operations`,
            headers: auditorHeaders,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await production.app.inject({
            method: "POST",
            url: `${base}/operations/reconcile`,
            headers: auditorHeaders,
            payload: {},
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await production.app.inject({
            method: "POST",
            url: `${base}/audit/transactions/repair`,
            headers: auditorHeaders,
            payload: {},
          })
        ).statusCode,
      ).toBe(404);

      const outcome = await pool.query<{ status: string }>(
        `select "status"::text as status from "PaymentOutcome" where "id" = $1::uuid`,
        [paymentId],
      );
      expect(outcome.rows[0]?.status).toBe("UNKNOWN");
      const adminHead = await pool.query<{ chainSequence: string }>(
        `select "chainSequence"::text as "chainSequence"
           from "AdminAuditChainHead" where "organizationId" = $1::uuid`,
        [organizationId],
      );
      expect(adminHead.rows[0]?.chainSequence).toBe("1");
    } finally {
      await production.close();
    }
  });

  async function seedAuthority(): Promise<void> {
    await pool.query(
      `insert into "Organization" ("id", "name", "createdAt", "updatedAt")
       values ($1, 'Audit HTTP org', $3, $3), ($2, 'Other audit HTTP org', $3, $3)`,
      [organizationId, otherOrganizationId, now],
    );
    await pool.query(
      `insert into "User" ("id", "organizationId", "email", "status", "createdAt", "updatedAt")
       values ($1, $2, $3, 'ACTIVE', $4, $4)`,
      [userId, organizationId, `${userId}@example.test`, now],
    );
    await pool.query(
      `insert into "AgentIdentity"
        ("id", "organizationId", "externalAgentId", "status", "createdAt", "updatedAt")
       values ($1, $2, $3, 'ACTIVE', $4, $4)`,
      [agentId, organizationId, `audit-http-agent-${agentId}`, now],
    );
    await pool.query(
      `insert into "Policy" (
         "id", "organizationId", "name", "version", "active", "baseCurrency",
         "maxBudgetMinor", "rollingDailyLimitMinor", "approvedMerchantDomains", "approvedVendorIds",
         "restrictedCategories", "approvalMode", "maxTransactionsPerMinute",
         "crossMerchantWindowSecs", "maxDistinctMerchants", "createdAt", "updatedAt"
       ) values (
         $1, $2, 'Audit HTTP Policy', 1, true, 'USD', 1000000, 1000000,
         ARRAY['shop.example.com'], ARRAY[]::text[], ARRAY[]::text[], 'AUTO_APPROVE',
         10, 60, 5, $3, $3
       )`,
      [policyId, organizationId, now],
    );
    await pool.query(
      `insert into "AgentMandate" (
         "id", "organizationId", "userId", "agentId", "policyId", "tokenJtiHash", "policyVersion",
         "currency", "maxBudgetMinor", "rollingDailyLimitMinor", "approvedMerchantDomains",
         "approvedVendorIds", "restrictedCategories", "approvalMode", "maxTransactionsPerMinute",
         "crossMerchantWindowSecs", "maxDistinctMerchants", "delegationPayloadHash", "signingKeyId",
         "status", "issuedAt", "expiresAt"
       ) values (
         $1, $2, $3, $4, $5, $6, 1, 'USD', 1000000, 1000000,
         ARRAY['shop.example.com'], ARRAY[]::text[], ARRAY[]::text[], 'AUTO_APPROVE',
         10, 60, 5, $7, 'mino-k1', 'ACTIVE', $8, $9
       )`,
      [
        mandateId,
        organizationId,
        userId,
        agentId,
        policyId,
        `audit-http-jti-${mandateId}`,
        `audit-http-delegation-${mandateId}`,
        new Date(now.getTime() - 3_600_000),
        new Date(now.getTime() + 86_400_000),
      ],
    );
  }

  async function seedOperations(): Promise<void> {
    await pool.query(
      `insert into "PaymentOutcome" (
         "id", "organizationId", "userId", "agentId", "mandateId", "reservationId",
         "idempotencyKey", "requestDigest", "merchantId", "merchantDomain", "checkoutSessionId",
         "amountMinor", "currency", "status", "lastErrorCode", "reconcileAttempts", "nextReconcileAt",
         "createdAt", "updatedAt"
       ) values (
         $1, $2, $3, $4, $5, $6, $7, 'HTTP-PAYMENT-DIGEST-SECRET',
         'merchant-1', 'shop.example.com', 'checkout-http', 25000, 'USD', 'UNKNOWN',
         'MERCHANT_TRANSPORT_ERROR', 8, $8, $9, $10
       )`,
      [
        paymentId,
        organizationId,
        userId,
        agentId,
        mandateId,
        `http-payment-reservation-${paymentId}`,
        `http-payment-idempotency-${paymentId}`,
        new Date(now.getTime() - 60_000),
        new Date(now.getTime() - 20 * 60_000),
        new Date(now.getTime() - 10 * 60_000),
      ],
    );
    await pool.query(
      `insert into "ApprovalRequest" (
         "id", "organizationId", "userId", "agentId", "mandateId", "decisionId", "requestId",
         "idempotencyKey", "requestDigest", "policyVersion", "merchantId", "merchantDomain",
         "checkoutSessionId", "requestedPayload", "reasonCodes", "amountMinor", "currency",
         "status", "requiredSignatures", "createdAt", "expiresAt"
       ) values (
         $1, $2, $3, $4, $5, $6, $7, $8, 'HTTP-APPROVAL-DIGEST-SECRET', 1,
         'merchant-1', 'shop.example.com', 'checkout-http', $9::jsonb,
         ARRAY['TRANSACTION_LIMIT_EXCEEDED'], 1000, 'USD', 'PENDING', 2, $10, $11
       )`,
      [
        approvalId,
        organizationId,
        userId,
        agentId,
        mandateId,
        randomUUID(),
        randomUUID(),
        `http-approval-idempotency-${approvalId}`,
        JSON.stringify({ token: "HTTP-APPROVAL-PAYLOAD-SECRET" }),
        new Date(now.getTime() - 10 * 60_000),
        new Date(now.getTime() + 30 * 60_000),
      ],
    );
  }

  async function seedAdminIdentities(): Promise<void> {
    await pool.query(
      `insert into "AdminPrincipal"
        ("id", "issuer", "subject", "status", "createdAt", "updatedAt")
       values
        ($1, $2, 'audit-finance', 'ACTIVE', $5, $5),
        ($3, $4, 'audit-auditor', 'ACTIVE', $5, $5)`,
      [financePrincipalId, issuer, auditorPrincipalId, issuer, now],
    );
    await pool.query(
      `insert into "AdminOrganizationMembership"
        ("id", "organizationId", "principalId", "status", "createdAt", "updatedAt")
       values
        ($1, $2, $3, 'ACTIVE', $6, $6),
        ($4, $2, $5, 'ACTIVE', $6, $6)`,
      [
        financeMembershipId,
        organizationId,
        financePrincipalId,
        auditorMembershipId,
        auditorPrincipalId,
        now,
      ],
    );
    await pool.query(
      `insert into "AdminRoleAssignment" ("id", "membershipId", "role", "assignedAt")
       values ($1, $2, 'FINANCE_MANAGER', $5), ($3, $4, 'AUDITOR', $5)`,
      [randomUUID(), financeMembershipId, randomUUID(), auditorMembershipId, now],
    );
  }

  function transactionEvent(): GatewayAuditEvent {
    const requestId = randomUUID();
    const decisionId = randomUUID();
    const timestamp = new Date(now.getTime() - 10 * 60_000);
    const decision: PolicyDecision = {
      decisionId,
      requestId,
      verdict: DecisionVerdict.ALLOW,
      reasons: [DecisionReason.POLICY_ALLOW],
      requestedAmount: { currency: "USD", minorUnits: 25000n },
      policyAmount: { currency: "USD", minorUnits: 25000n },
      approvedAmount: { currency: "USD", minorUnits: 25000n },
      mandateId,
      policyId,
      policyVersion: 1,
      eligibleForDelegationAssertion: true,
      evaluationLatencyMicros: 150,
      evaluatedAt: timestamp,
    };
    return {
      requestId,
      decisionId,
      organizationId,
      userId,
      agentId,
      mandateId,
      timestamp,
      protocol: "ACP",
      operation: "complete_checkout",
      merchantDomain: "shop.example.com",
      requestedPayload: {
        cart: [{ sku: "HTTP-TX-PAYLOAD-SECRET" }],
        authorization: "HTTP-TX-PAYLOAD-SECRET",
      },
      approvedPayload: { token: "HTTP-TX-APPROVED-SECRET" },
      decision,
      requestDigest: "HTTP-TX-DIGEST-SECRET",
      reservationId: `http-audit-reservation-${randomUUID()}`,
      upstreamStatus: 200,
    };
  }

  function authHeaders(subject: string) {
    return { authorization: `Bearer ${adminToken(jwtKeys.privateKey, subject)}` };
  }

  function productionConfig(): ProductionConfig {
    const mandateKeys = generateKeyPairSync("ed25519");
    const delegationKeys = generateKeyPairSync("ed25519");
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
      auditSigningKey: { keyId: "audit-http-k1", privateKey: pemPrivate(auditKeys.privateKey) },
      auditVerificationKeys: new Map([["audit-http-k1", pemPublic(auditKeys.publicKey)]]),
      approvalResolutionSecret: "r".repeat(32),
      approvalWebhook: { endpoint: "https://approvals.example/webhook", secret: "w".repeat(32) },
      merchantCredentials: new Map(),
    };
  }
});

function adminToken(privateKey: KeyObject, subject: string): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "audit-http-rsa-1", typ: "JWT" }),
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

function pemPublic(key: KeyObject): string {
  return key.export({ type: "spki", format: "pem" }).toString();
}

function pemPrivate(key: KeyObject): string {
  return key.export({ type: "pkcs8", format: "pem" }).toString();
}
