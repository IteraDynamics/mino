import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createClient } from "redis";
import { sha256Hex } from "../../src/infrastructure/crypto/canonical-json.js";
import { signEd25519 } from "../../src/infrastructure/crypto/ed25519.js";
import type { ProductionConfig } from "../../src/infrastructure/config/production-config.js";
import { buildAgentSigningPayload } from "../../src/modules/agents/agent-request-verifier.js";
import { MandateTokenService } from "../../src/modules/mandates/mandate-token.service.js";
import type { ACPMerchantClient } from "../../src/modules/proxy/merchant-client.js";
import { createProductionApplication } from "../../src/production/application.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const now = new Date("2026-08-14T18:30:00.000Z");

const ids = {
  organization: "50000000-0000-4000-8000-000000000001",
  user: "50000000-0000-4000-8000-000000000002",
  agent: "50000000-0000-4000-8000-000000000003",
  policy: "50000000-0000-4000-8000-000000000004",
  mandate: "50000000-0000-4000-8000-000000000005",
  merchantRow: "50000000-0000-4000-8000-000000000006",
};
const merchantId = "merchant-production-integration";

integration("production application composition", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await cleanup(pool);
    await pool.end();
  });

  it("starts the real dependency graph and completes an authorized payment end-to-end", async () => {
    await cleanup(pool);
    const redis = createClient({ url: REDIS_URL });
    await redis.connect();
    await redis.flushDb();
    await redis.quit();

    const minoKeys = generateKeyPairSync("ed25519");
    const agentKeys = generateKeyPairSync("ed25519");
    const delegationKeys = generateKeyPairSync("ed25519");
    const auditKeys = generateKeyPairSync("ed25519");
    const minoPublic = pemPublic(minoKeys.publicKey);
    const minoPrivate = pemPrivate(minoKeys.privateKey);
    const agentPublic = pemPublic(agentKeys.publicKey);
    const delegationPrivate = pemPrivate(delegationKeys.privateKey);
    const auditPrivate = pemPrivate(auditKeys.privateKey);
    const auditPublic = pemPublic(auditKeys.publicKey);
    const tokenJti = "production-integration-jti";

    await seed(pool, {
      agentPublic,
      tokenJtiHash: sha256Hex(tokenJti),
    });

    const config: ProductionConfig = {
      databaseUrl: DATABASE_URL,
      redisUrl: REDIS_URL,
      host: "127.0.0.1",
      port: 3000,
      issuer: "https://mino.example",
      mandateVerificationKeys: new Map([["mino-k1", minoPublic]]),
      delegationSigningKey: {
        keyId: "delegation-k1",
        privateKey: delegationPrivate,
      },
      auditSigningKey: {
        keyId: "audit-k1",
        privateKey: auditPrivate,
      },
      auditVerificationKeys: new Map([["audit-k1", auditPublic]]),
      approvalResolutionSecret: "r".repeat(32),
      approvalWebhook: {
        endpoint: "https://approvals.example/webhook",
        secret: "w".repeat(32),
      },
      merchantCredentials: new Map([
        [`${ids.organization}:${merchantId}`, "Bearer server-side-merchant-credential"],
      ]),
    };

    let completeCalls = 0;
    const merchantClient: ACPMerchantClient = {
      async createCheckout() {
        throw new Error("not used");
      },
      async getCheckout() {
        return { status: 200, body: readyCheckout() };
      },
      async completeCheckout() {
        completeCalls += 1;
        return {
          status: 200,
          body: {
            ...readyCheckout(),
            status: "completed",
            order: { id: "order-production-1" },
          },
        };
      },
      async cancelCheckout() {
        throw new Error("not used");
      },
    };

    const production = await createProductionApplication(config, {
      merchantClient,
      now: () => now,
      logger: false,
    });

    try {
      expect(await production.readiness()).toBe(true);
      const ready = await production.app.inject({ method: "GET", url: "/readyz" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toEqual({ status: "ready" });

      const mandateTokens = new MandateTokenService(
        {
          async resolvePublicKey(keyId) {
            return keyId === "mino-k1" ? minoPublic : undefined;
          },
        },
        { issuer: config.issuer },
      );
      const nowSeconds = Math.floor(now.getTime() / 1000);
      const mandateToken = mandateTokens.issue(
        {
          iss: config.issuer,
          sub: ids.agent,
          aud: "mino",
          jti: tokenJti,
          organizationId: ids.organization,
          userId: ids.user,
          agentId: ids.agent,
          mandateId: ids.mandate,
          policyVersion: 1,
          iat: nowSeconds - 10,
          nbf: nowSeconds - 10,
          exp: nowSeconds + 300,
        },
        { keyId: "mino-k1", privateKey: minoPrivate },
      );

      const body = { payment_data: { token: "do-not-persist-this" } };
      const path = `/v1/acp/${merchantId}/checkout_sessions/cs_production/complete`;
      const idempotencyKey = "production-composition-idempotency";
      const timestamp = nowSeconds.toString(10);
      const nonce = "production_nonce_1234567890";
      const signingPayload = buildAgentSigningPayload({
        method: "POST",
        path,
        timestamp,
        nonce,
        body,
        mandateTokenJtiHash: sha256Hex(tokenJti),
        idempotencyKey,
        apiVersion: "2026-04-17",
      });
      const signature = signEd25519(signingPayload, agentKeys.privateKey).toString("base64url");

      const response = await production.app.inject({
        method: "POST",
        url: path,
        headers: {
          authorization: "Bearer request-scoped-merchant-credential",
          "api-version": "2026-04-17",
          "idempotency-key": idempotencyKey,
          "x-mino-mandate-token": mandateToken,
          "x-mino-agent-id": ids.agent,
          "x-mino-agent-key-id": "agent-k1",
          "x-mino-agent-timestamp": timestamp,
          "x-mino-agent-nonce": nonce,
          "x-mino-agent-signature": signature,
        },
        payload: body,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().decision.verdict).toBe("ALLOW");
      expect(completeCalls).toBe(1);

      const outcome = await pool.query<{ status: string }>(
        `select "status" from "PaymentOutcome"
          where "organizationId" = $1::uuid and "idempotencyKey" = $2`,
        [ids.organization, idempotencyKey],
      );
      expect(outcome.rows[0]?.status).toBe("SUCCEEDED");

      const auditVerification = await production.auditVerifier.verifyOrganization(ids.organization);
      expect(auditVerification.valid).toBe(true);
      expect(auditVerification.checkedEvents).toBeGreaterThan(0);

      const audit = await pool.query<{ requestedPayload: { payment_data?: { token?: string } } }>(
        `select "requestedPayload" from "AuditLog"
          where "organizationId" = $1::uuid
          order by "chainSequence" desc limit 1`,
        [ids.organization],
      );
      expect(audit.rows[0]?.requestedPayload.payment_data?.token).toBe("[REDACTED]");

      const repositoryMandate = await production.repositories.mandates.getById(ids.mandate);
      expect(repositoryMandate?.id).toBe(ids.mandate);
      expect(await production.repositories.agentKeys.resolveAgentPublicKey(ids.agent, "agent-k1"))
        .toContain("BEGIN PUBLIC KEY");
    } finally {
      await production.close();
    }
  });
});

function readyCheckout() {
  return {
    id: "cs_production",
    status: "ready_for_payment",
    currency: "usd",
    line_items: [
      {
        id: "line-production",
        item: {
          id: "monitor-production",
          name: "Production integration monitor",
          unit_amount: 5000,
        },
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
}

async function seed(
  pool: Pool,
  input: { readonly agentPublic: string; readonly tokenJtiHash: string },
): Promise<void> {
  await pool.query(
    `insert into "Organization" ("id", "name", "createdAt", "updatedAt")
     values ($1::uuid, 'Production Composition Org', $2, $2)`,
    [ids.organization, now],
  );
  await pool.query(
    `insert into "User" ("id", "organizationId", "email", "status", "createdAt", "updatedAt")
     values ($1::uuid, $2::uuid, 'production-composition@example.test', 'ACTIVE', $3, $3)`,
    [ids.user, ids.organization, now],
  );
  await pool.query(
    `insert into "AgentIdentity" (
       "id", "organizationId", "externalAgentId", "status", "publicKey", "keyId", "createdAt", "updatedAt"
     ) values ($1::uuid, $2::uuid, 'production-agent', 'ACTIVE', $3, 'agent-k1', $4, $4)`,
    [ids.agent, ids.organization, input.agentPublic, now],
  );
  await pool.query(
    `insert into "Policy" (
       "id", "organizationId", "name", "version", "active", "baseCurrency",
       "maxBudgetMinor", "rollingDailyLimitMinor", "approvedMerchantDomains",
       "approvedVendorIds", "restrictedCategories", "approvalMode",
       "maxTransactionsPerMinute", "crossMerchantWindowSecs", "maxDistinctMerchants",
       "createdAt", "updatedAt"
     ) values (
       $1::uuid, $2::uuid, 'Production Policy', 1, true, 'USD',
       10000, 20000, array['merchant.example'], array[]::text[], array['DIGITAL_GIFT_CARD'], 'AUTO_APPROVE',
       10, 60, 5, $3, $3
     )`,
    [ids.policy, ids.organization, now],
  );
  await pool.query(
    `insert into "AgentMandate" (
       "id", "organizationId", "userId", "agentId", "policyId", "tokenJtiHash", "policyVersion",
       "currency", "maxBudgetMinor", "rollingDailyLimitMinor", "approvedMerchantDomains",
       "approvedVendorIds", "restrictedCategories", "approvalMode", "maxTransactionsPerMinute",
       "crossMerchantWindowSecs", "maxDistinctMerchants", "delegationPayloadHash", "signingKeyId",
       "status", "issuedAt", "expiresAt"
     ) values (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, 1,
       'USD', 10000, 20000, array['merchant.example'], array[]::text[], array['DIGITAL_GIFT_CARD'],
       'AUTO_APPROVE', 10, 60, 5, 'production-delegation-hash', 'mino-k1', 'ACTIVE', $7, $8
     )`,
    [
      ids.mandate,
      ids.organization,
      ids.user,
      ids.agent,
      ids.policy,
      input.tokenJtiHash,
      new Date(now.getTime() - 60_000),
      new Date(now.getTime() + 3_600_000),
    ],
  );
  await pool.query(
    `insert into "MerchantEndpoint" (
       "id", "organizationId", "externalMerchantId", "domain", "baseUrl", "active", "createdAt", "updatedAt"
     ) values ($1::uuid, $2::uuid, $3, 'merchant.example', 'https://merchant.example', true, $4, $4)`,
    [ids.merchantRow, ids.organization, merchantId, now],
  );
}

async function cleanup(pool: Pool): Promise<void> {
  await pool.query('delete from "AuditLog" where "organizationId" = $1::uuid', [ids.organization]);
  await pool.query('delete from "AuditChainHead" where "organizationId" = $1::uuid', [ids.organization]);
  await pool.query('delete from "PaymentOutcome" where "organizationId" = $1::uuid', [ids.organization]);
  await pool.query('delete from "ApprovalRequest" where "organizationId" = $1::uuid', [ids.organization]);
  await pool.query('delete from "SpendReservation" where "organizationId" = $1::uuid', [ids.organization]);
  await pool.query('delete from "MerchantEndpoint" where "organizationId" = $1::uuid', [ids.organization]);
  await pool.query('delete from "AgentMandate" where "organizationId" = $1::uuid', [ids.organization]);
  await pool.query('delete from "Policy" where "organizationId" = $1::uuid', [ids.organization]);
  await pool.query('delete from "AgentIdentity" where "organizationId" = $1::uuid', [ids.organization]);
  await pool.query('delete from "User" where "organizationId" = $1::uuid', [ids.organization]);
  await pool.query('delete from "Organization" where "id" = $1::uuid', [ids.organization]);
}

function pemPublic(key: ReturnType<typeof generateKeyPairSync>["publicKey"]): string {
  return key.export({ type: "spki", format: "pem" }).toString();
}

function pemPrivate(key: ReturnType<typeof generateKeyPairSync>["privateKey"]): string {
  return key.export({ type: "pkcs8", format: "pem" }).toString();
}
