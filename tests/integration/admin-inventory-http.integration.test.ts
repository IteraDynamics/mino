import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProductionConfig } from "../../src/infrastructure/config/production-config.js";
import { createProductionApplication } from "../../src/production/application.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const issuer = "https://inventory-login.example.test/";
const audience = "mino-admin";
const now = new Date("2026-08-15T06:30:00.000Z");

integration("production admin inventory HTTP surface", () => {
  let pool: Pool;
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const principalId = randomUUID();
  const membershipId = randomUUID();
  const jwtKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(
      `insert into "Organization" ("id", "name", "createdAt", "updatedAt")
       values ($1, 'Inventory HTTP org', now(), now()), ($2, 'Inventory other org', now(), now())`,
      [organizationId, otherOrganizationId],
    );
    await pool.query(
      `insert into "AdminPrincipal"
        ("id", "issuer", "subject", "status", "createdAt", "updatedAt")
       values ($1, $2, 'inventory-admin', 'ACTIVE', now(), now())`,
      [principalId, issuer],
    );
    await pool.query(
      `insert into "AdminOrganizationMembership"
        ("id", "organizationId", "principalId", "status", "createdAt", "updatedAt")
       values ($1, $2, $3, 'ACTIVE', now(), now())`,
      [membershipId, organizationId, principalId],
    );
    await pool.query(
      `insert into "AdminRoleAssignment" ("id", "membershipId", "role", "assignedAt")
       values ($1, $2, 'FINANCE_MANAGER', now())`,
      [randomUUID(), membershipId],
    );

    await pool.query(
      `insert into "AgentIdentity"
        ("id", "organizationId", "externalAgentId", "displayName", "status", "publicKey", "keyId", "createdAt", "updatedAt")
       values
        ($1, $2, 'inventory-agent', 'Inventory Agent', 'ACTIVE', 'DO-NOT-EXPOSE-PUBLIC-KEY', 'agent-key-1', now(), now()),
        ($3, $4, 'other-agent', 'Other Agent', 'ACTIVE', null, null, now(), now())`,
      [randomUUID(), organizationId, randomUUID(), otherOrganizationId],
    );
    await pool.query(
      `insert into "Policy"
        ("id", "organizationId", "name", "version", "active", "baseCurrency", "maxBudgetMinor",
         "rollingDailyLimitMinor", "approvedMerchantDomains", "approvedVendorIds", "restrictedCategories",
         "approvalMode", "maxTransactionsPerMinute", "crossMerchantWindowSecs", "maxDistinctMerchants",
         "createdAt", "updatedAt")
       values
        ($1, $2, 'Inventory Policy', 1, true, 'USD', $3, $4, ARRAY['merchant.example'], ARRAY[]::text[],
         ARRAY['gift-card'], 'DUAL_SIGNATURE_SLACK', 10, 60, 5, now(), now()),
        ($5, $6, 'Other Policy', 1, true, 'USD', 100, 200, ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[],
         'HARD_BLOCK', 10, 60, 5, now(), now())`,
      [
        randomUUID(),
        organizationId,
        "9007199254740993123",
        "9007199254740993999",
        randomUUID(),
        otherOrganizationId,
      ],
    );
    await pool.query(
      `insert into "MerchantEndpoint"
        ("id", "organizationId", "externalMerchantId", "domain", "vendorId", "baseUrl", "active", "createdAt", "updatedAt")
       values
        ($1, $2, 'inventory-merchant', 'merchant.example', 'vendor-1', 'https://secret-upstream.example/acp', true, now(), now()),
        ($3, $4, 'other-merchant', 'other.example', null, 'https://other-secret.example/acp', true, now(), now())`,
      [randomUUID(), organizationId, randomUUID(), otherOrganizationId],
    );
  });

  afterAll(async () => {
    await pool.query(`delete from "Organization" where "id" = any($1::uuid[])`, [
      [organizationId, otherOrganizationId],
    ]);
    await pool.query(`delete from "AdminPrincipal" where "id" = $1`, [principalId]);
    await pool.end();
  });

  it("returns only tenant-scoped safe inventory through the real JWT and RBAC boundary", async () => {
    const publicPem = jwtKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const production = await createProductionApplication(productionConfig(), {
      logger: false,
      now: () => now,
      adminJwtIssuers: [
        {
          issuer,
          audience,
          verificationKeys: new Map([["inventory-rsa-1", publicPem]]),
        },
      ],
    });
    const headers = { authorization: `Bearer ${token(jwtKeys.privateKey)}` };

    try {
      const agents = await production.app.inject({
        method: "GET",
        url: `/v1/admin/organizations/${organizationId}/agents`,
        headers,
      });
      expect(agents.statusCode).toBe(200);
      expect(agents.json().items).toHaveLength(1);
      expect(agents.json().items[0]).toMatchObject({
        externalAgentId: "inventory-agent",
        displayName: "Inventory Agent",
        keyId: "agent-key-1",
      });
      expect(agents.body).not.toContain("DO-NOT-EXPOSE-PUBLIC-KEY");
      expect(agents.body).not.toContain("other-agent");

      const policies = await production.app.inject({
        method: "GET",
        url: `/v1/admin/organizations/${organizationId}/policies`,
        headers,
      });
      expect(policies.statusCode).toBe(200);
      expect(policies.json().items).toHaveLength(1);
      expect(policies.json().items[0]).toMatchObject({
        name: "Inventory Policy",
        maxBudgetMinor: "9007199254740993123",
        rollingDailyLimitMinor: "9007199254740993999",
      });
      expect(policies.body).not.toContain("Other Policy");

      const merchants = await production.app.inject({
        method: "GET",
        url: `/v1/admin/organizations/${organizationId}/merchants`,
        headers,
      });
      expect(merchants.statusCode).toBe(200);
      expect(merchants.json().items).toHaveLength(1);
      expect(merchants.json().items[0]).toMatchObject({
        externalMerchantId: "inventory-merchant",
        domain: "merchant.example",
        vendorId: "vendor-1",
      });
      expect(merchants.body).not.toContain("secret-upstream");
      expect(merchants.body).not.toContain("other-merchant");
      expect(merchants.headers["cache-control"]).toBe("no-store");

      const wrongTenant = await production.app.inject({
        method: "GET",
        url: `/v1/admin/organizations/${otherOrganizationId}/agents`,
        headers,
      });
      expect(wrongTenant.statusCode).toBe(403);
      expect(wrongTenant.json()).toEqual({ error: "forbidden" });
    } finally {
      await production.close();
    }
  });
});

function token(privateKey: KeyObject): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "inventory-rsa-1", typ: "JWT" }),
    "utf8",
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: issuer,
      sub: "inventory-admin",
      aud: audience,
      iat: Math.floor(now.getTime() / 1_000) - 60,
      exp: Math.floor(now.getTime() / 1_000) + 300,
    }),
    "utf8",
  ).toString("base64url");
  const signingInput = Buffer.from(`${header}.${payload}`, "ascii");
  const signature = sign("RSA-SHA256", signingInput, privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
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
    auditSigningKey: {
      keyId: "audit-k1",
      privateKey: pemPrivate(auditKeys.privateKey),
    },
    auditVerificationKeys: new Map([["audit-k1", pemPublic(auditKeys.publicKey)]]),
    approvalResolutionSecret: "r".repeat(32),
    approvalWebhook: {
      endpoint: "https://approvals.example/webhook",
      secret: "w".repeat(32),
    },
    merchantCredentials: new Map(),
  };
}

function pemPublic(key: KeyObject): string {
  return key.export({ type: "spki", format: "pem" }).toString();
}

function pemPrivate(key: KeyObject): string {
  return key.export({ type: "pkcs8", format: "pem" }).toString();
}
