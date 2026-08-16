import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProductionConfig } from "../../src/infrastructure/config/production-config.js";
import { createProductionApplication } from "../../src/production/application.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const issuer = "https://policy-management-login.example.test/";
const audience = "mino-admin";
const now = new Date("2026-08-16T14:15:00.000Z");

integration("production administrative policy management HTTP surface", () => {
  let pool: Pool;
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const principalId = randomUUID();
  const membershipId = randomUUID();
  const userId = randomUUID();
  const agentId = randomUUID();
  const mandateId = randomUUID();
  const jwtKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(
      `insert into "Organization" ("id", "name", "createdAt", "updatedAt")
       values ($1, 'Policy management HTTP org', now(), now()),
              ($2, 'Policy management other org', now(), now())`,
      [organizationId, otherOrganizationId],
    );
    await pool.query(
      `insert into "AdminPrincipal"
        ("id", "issuer", "subject", "status", "createdAt", "updatedAt")
       values ($1, $2, 'policy-management-admin', 'ACTIVE', now(), now())`,
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
      `insert into "User" ("id", "organizationId", "email", "status", "createdAt", "updatedAt")
       values ($1, $2, $3, 'ACTIVE', now(), now())`,
      [userId, organizationId, `policy-user-${userId}@example.test`],
    );
    await pool.query(
      `insert into "AgentIdentity"
        ("id", "organizationId", "externalAgentId", "status", "createdAt", "updatedAt")
       values ($1, $2, $3, 'ACTIVE', now(), now())`,
      [agentId, organizationId, `policy-agent-${agentId}`],
    );
  });

  afterAll(async () => {
    const organizationIds = [organizationId, otherOrganizationId];
    await pool.query(`delete from "AdminAuditLog" where "organizationId" = any($1::uuid[])`, [organizationIds]);
    await pool.query(`delete from "AdminAuditChainHead" where "organizationId" = any($1::uuid[])`, [organizationIds]);
    await pool.query(`delete from "AgentMandate" where "organizationId" = any($1::uuid[])`, [organizationIds]);
    await pool.query(`delete from "Policy" where "organizationId" = any($1::uuid[])`, [organizationIds]);
    await pool.query(`delete from "AgentIdentity" where "organizationId" = any($1::uuid[])`, [organizationIds]);
    await pool.query(`delete from "User" where "organizationId" = any($1::uuid[])`, [organizationIds]);
    await pool.query(`delete from "Organization" where "id" = any($1::uuid[])`, [organizationIds]);
    await pool.query(`delete from "AdminPrincipal" where "id" = $1`, [principalId]);
    await pool.end();
  });

  it("creates, versions, and activates policies through signed JWT/RBAC while preserving version-local activation", async () => {
    const publicPem = jwtKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const production = await createProductionApplication(productionConfig(), {
      logger: false,
      now: () => now,
      adminJwtIssuers: [
        {
          issuer,
          audience,
          verificationKeys: new Map([["policy-management-rsa-1", publicPem]]),
        },
      ],
    });
    const headers = { authorization: `Bearer ${token(jwtKeys.privateKey)}` };
    const base = `/v1/admin/organizations/${organizationId}/policies`;
    const initialPayload = {
      name: "Enterprise Procurement",
      baseCurrency: "USD",
      maxBudgetMinor: "9007199254740993000",
      rollingDailyLimitMinor: "9223372036854775807",
      approvedMerchantDomains: ["example.com"],
      approvedVendorIds: ["vendor-1"],
      restrictedCategories: ["GAMBLING"],
      approvalMode: "DUAL_SIGNATURE_SLACK",
      maxTransactionsPerMinute: 10,
      crossMerchantWindowSecs: 60,
      maxDistinctMerchants: 5,
    };

    try {
      const created = await production.app.inject({
        method: "POST",
        url: base,
        headers,
        payload: initialPayload,
      });
      expect(created.statusCode).toBe(201);
      expect(created.headers["cache-control"]).toBe("no-store");
      const createdBody = created.json<{
        policy: { id: string; version: number; active: boolean; maxBudgetMinor: string; rollingDailyLimitMinor: string };
      }>();
      expect(createdBody.policy).toMatchObject({
        version: 1,
        active: false,
        maxBudgetMinor: "9007199254740993000",
        rollingDailyLimitMinor: "9223372036854775807",
      });
      const policyV1Id = createdBody.policy.id;

      const detail = await production.app.inject({
        method: "GET",
        url: `${base}/${policyV1Id}`,
        headers,
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({
        policy: {
          id: policyV1Id,
          organizationId,
          name: "Enterprise Procurement",
          version: 1,
          active: false,
        },
      });

      const activatedV1 = await production.app.inject({
        method: "POST",
        url: `${base}/${policyV1Id}/activate`,
        headers,
      });
      expect(activatedV1.statusCode).toBe(200);
      expect(activatedV1.json()).toMatchObject({ outcome: "UPDATED", changed: true, policy: { active: true } });
      expect((await production.repositories.policies.getById(policyV1Id))?.active).toBe(true);

      await pool.query(
        `insert into "AgentMandate" (
           "id", "organizationId", "userId", "agentId", "policyId",
           "tokenJtiHash", "policyVersion", "currency", "maxBudgetMinor", "rollingDailyLimitMinor",
           "approvedMerchantDomains", "approvedVendorIds", "restrictedCategories", "approvalMode",
           "maxTransactionsPerMinute", "crossMerchantWindowSecs", "maxDistinctMerchants",
           "delegationPayloadHash", "signingKeyId", "status", "issuedAt", "expiresAt"
         ) values (
           $1, $2, $3, $4, $5,
           $6, 1, 'USD', 50000, 200000,
           ARRAY['example.com']::text[], ARRAY['vendor-1']::text[], ARRAY['GAMBLING']::text[], 'DUAL_SIGNATURE_SLACK',
           10, 60, 5,
           'delegation-payload-hash', 'mino-k1', 'ACTIVE', $7, $8
         )`,
        [
          mandateId,
          organizationId,
          userId,
          agentId,
          policyV1Id,
          `policy-management-jti-${mandateId}`,
          now,
          new Date("2027-08-16T14:15:00.000Z"),
        ],
      );
      expect(await production.repositories.mandates.getById(mandateId)).toBeDefined();

      const versionTwo = await production.app.inject({
        method: "POST",
        url: `${base}/${policyV1Id}/versions`,
        headers,
        payload: {
          version: 2,
          baseCurrency: "USD",
          maxBudgetMinor: "50000",
          rollingDailyLimitMinor: "200000",
          approvedMerchantDomains: ["example.com", "shop.example.com"],
          approvedVendorIds: ["vendor-1"],
          restrictedCategories: ["GAMBLING", "CRYPTO"],
          approvalMode: "HARD_BLOCK",
          maxTransactionsPerMinute: 8,
          crossMerchantWindowSecs: 90,
          maxDistinctMerchants: 4,
        },
      });
      expect(versionTwo.statusCode).toBe(201);
      const versionTwoBody = versionTwo.json<{ policy: { id: string; version: number; active: boolean } }>();
      expect(versionTwoBody.policy).toMatchObject({ version: 2, active: false });
      const policyV2Id = versionTwoBody.policy.id;

      const versionReplay = await production.app.inject({
        method: "POST",
        url: `${base}/${policyV1Id}/versions`,
        headers,
        payload: {
          version: 2,
          baseCurrency: "USD",
          maxBudgetMinor: "50000",
          rollingDailyLimitMinor: "200000",
          approvedMerchantDomains: ["shop.example.com", "example.com"],
          approvedVendorIds: ["vendor-1"],
          restrictedCategories: ["CRYPTO", "GAMBLING"],
          approvalMode: "HARD_BLOCK",
          maxTransactionsPerMinute: 8,
          crossMerchantWindowSecs: 90,
          maxDistinctMerchants: 4,
        },
      });
      expect(versionReplay.statusCode).toBe(200);
      expect(versionReplay.json()).toMatchObject({ outcome: "REPLAYED", changed: false });

      expect(
        (
          await production.app.inject({
            method: "POST",
            url: `${base}/${policyV2Id}/activate`,
            headers,
          })
        ).statusCode,
      ).toBe(200);
      expect((await production.repositories.policies.getById(policyV1Id))?.active).toBe(true);
      expect((await production.repositories.policies.getById(policyV2Id))?.active).toBe(true);
      expect(await production.repositories.mandates.getById(mandateId)).toBeDefined();

      expect(
        (
          await production.app.inject({
            method: "POST",
            url: `${base}/${policyV1Id}/deactivate`,
            headers,
          })
        ).statusCode,
      ).toBe(200);
      expect((await production.repositories.policies.getById(policyV1Id))?.active).toBe(false);
      expect((await production.repositories.policies.getById(policyV2Id))?.active).toBe(true);
      expect(await production.repositories.mandates.getById(mandateId)).toBeUndefined();

      const wrongTenant = await production.app.inject({
        method: "POST",
        url: `/v1/admin/organizations/${otherOrganizationId}/policies/${policyV2Id}/deactivate`,
        headers,
      });
      expect(wrongTenant.statusCode).toBe(403);
      expect(wrongTenant.json()).toEqual({ error: "forbidden" });

      const audits = await pool.query<{ action: string }>(
        `select "action" from "AdminAuditLog"
          where "organizationId" = $1::uuid order by "chainSequence" asc`,
        [organizationId],
      );
      expect(audits.rows.map((row) => row.action)).toEqual([
        "policy.create",
        "policy.activate",
        "policy.version.create",
        "policy.activate",
        "policy.deactivate",
      ]);
      expect(await production.adminAuditVerifier.verifyOrganization(organizationId)).toMatchObject({
        valid: true,
        checkedEvents: 5,
      });
    } finally {
      await production.close();
    }
  });
});

function token(privateKey: KeyObject): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "policy-management-rsa-1", typ: "JWT" }),
    "utf8",
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: issuer,
      sub: "policy-management-admin",
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
    delegationSigningKey: { keyId: "delegation-k1", privateKey: pemPrivate(delegationKeys.privateKey) },
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
