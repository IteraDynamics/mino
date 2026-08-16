import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProductionConfig } from "../../src/infrastructure/config/production-config.js";
import { StaticMandateVerificationKeyResolver } from "../../src/infrastructure/crypto/static-key-providers.js";
import { MandateTokenService } from "../../src/modules/mandates/mandate-token.service.js";
import { createProductionApplication } from "../../src/production/application.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const issuer = "https://mandate-administration-login.example.test/";
const audience = "mino-admin";
const now = new Date("2026-08-16T16:30:00.000Z");
const mandateSigningKeys = generateKeyPairSync("ed25519");

integration("production administrative mandate issuance and revocation HTTP surface", () => {
  let pool: Pool;
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const principalId = randomUUID();
  const membershipId = randomUUID();
  const userId = randomUUID();
  const agentId = randomUUID();
  const policyId = randomUUID();
  const jwtKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const agentKeys = generateKeyPairSync("ed25519");

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(
      `insert into "Organization" ("id", "name", "createdAt", "updatedAt")
       values ($1, 'Mandate administration HTTP org', now(), now()),
              ($2, 'Mandate administration other org', now(), now())`,
      [organizationId, otherOrganizationId],
    );
    await pool.query(
      `insert into "User" ("id", "organizationId", "email", "status", "createdAt", "updatedAt")
       values ($1, $2, $3, 'ACTIVE', now(), now())`,
      [userId, organizationId, `${userId}@example.test`],
    );
    await pool.query(
      `insert into "AgentIdentity" (
         "id", "organizationId", "externalAgentId", "status", "publicKey", "keyId", "createdAt", "updatedAt"
       ) values ($1, $2, $3, 'ACTIVE', $4, 'agent-http-k1', now(), now())`,
      [agentId, organizationId, `agent-${agentId}`, pemPublic(agentKeys.publicKey)],
    );
    await pool.query(
      `insert into "Policy" (
         "id", "organizationId", "name", "version", "active", "baseCurrency",
         "maxBudgetMinor", "rollingDailyLimitMinor", "approvedMerchantDomains", "approvedVendorIds",
         "restrictedCategories", "approvalMode", "maxTransactionsPerMinute",
         "crossMerchantWindowSecs", "maxDistinctMerchants", "createdAt", "updatedAt"
       ) values (
         $1, $2, 'HTTP Procurement', 4, true, 'USD',
         9007199254740993000, 9223372036854775807,
         ARRAY['shop.example.com'], ARRAY['vendor-1'], ARRAY['GAMBLING'],
         'DUAL_SIGNATURE_SLACK', 9, 75, 4, now(), now()
       )`,
      [policyId, organizationId],
    );
    await pool.query(
      `insert into "AdminPrincipal"
        ("id", "issuer", "subject", "status", "createdAt", "updatedAt")
       values ($1, $2, 'mandate-administration-admin', 'ACTIVE', now(), now())`,
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

  it("issues one-time bearer authority and makes revocation immediate at the production resolver", async () => {
    const config = productionConfig();
    const jwtPublic = pemPublic(jwtKeys.publicKey);
    const production = await createProductionApplication(config, {
      logger: false,
      now: () => now,
      adminJwtIssuers: [
        {
          issuer,
          audience,
          verificationKeys: new Map([["mandate-administration-rsa-1", jwtPublic]]),
        },
      ],
    });
    const headers = {
      authorization: `Bearer ${adminToken(jwtKeys.privateKey)}`,
      "idempotency-key": "http-grant-2026-08-16",
    };
    const base = `/v1/admin/organizations/${organizationId}/mandates`;
    const payload = {
      userId,
      agentId,
      policyId,
      expiresAt: "2026-09-16T16:30:00.000Z",
    };

    try {
      const issued = await production.app.inject({
        method: "POST",
        url: base,
        headers,
        payload,
      });
      expect(issued.statusCode).toBe(201);
      expect(issued.headers["cache-control"]).toBe("no-store");
      const issuedBody = issued.json<{
        mandateToken: string;
        mandate: {
          id: string;
          tokenJtiHash: string;
          policyVersion: number;
          maxBudgetMinor: string;
          rollingDailyLimitMinor: string;
        };
      }>();
      expect(issuedBody.mandate).toMatchObject({
        policyVersion: 4,
        maxBudgetMinor: "9007199254740993000",
        rollingDailyLimitMinor: "9223372036854775807",
      });
      expect(issuedBody.mandateToken.split(".")).toHaveLength(3);
      const mandateId = issuedBody.mandate.id;

      const verifier = new MandateTokenService(
        new StaticMandateVerificationKeyResolver(config.mandateVerificationKeys),
        { issuer: config.issuer },
      );
      const verified = await verifier.verify(issuedBody.mandateToken, now);
      const resolved = await production.repositories.mandates.getById(mandateId);
      expect(resolved).toMatchObject({
        id: mandateId,
        organizationId,
        userId,
        agentId,
        policyVersion: 4,
        currency: "USD",
        maxBudgetMinor: 9007199254740993000n,
        rollingDailyLimitMinor: 9223372036854775807n,
      });
      verifier.assertBoundToMandate(verified, resolved!);
      expect(verified.tokenJtiHash).toBe(issuedBody.mandate.tokenJtiHash);

      const detail = await production.app.inject({
        method: "GET",
        url: `${base}/${mandateId}`,
        headers: { authorization: headers.authorization },
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.body).not.toContain(issuedBody.mandateToken);
      expect(detail.body).not.toContain("mandateToken");

      const inventory = await production.app.inject({
        method: "GET",
        url: base,
        headers: { authorization: headers.authorization },
      });
      expect(inventory.statusCode).toBe(200);
      expect(inventory.body).not.toContain(issuedBody.mandateToken);
      expect(inventory.body).not.toContain("tokenJtiHash");
      expect(inventory.json()).toMatchObject({
        items: [
          {
            id: mandateId,
            userId,
            agentId,
            policyId,
            policyVersion: 4,
            maxBudgetMinor: "9007199254740993000",
            rollingDailyLimitMinor: "9223372036854775807",
            status: "ACTIVE",
          },
        ],
      });

      const replay = await production.app.inject({
        method: "POST",
        url: base,
        headers,
        payload,
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({
        outcome: "REPLAYED",
        changed: false,
        mandate: { id: mandateId },
      });
      expect(replay.body).not.toContain("mandateToken");

      const changedReuse = await production.app.inject({
        method: "POST",
        url: base,
        headers,
        payload: { ...payload, expiresAt: "2026-10-16T16:30:00.000Z" },
      });
      expect(changedReuse.statusCode).toBe(409);
      expect(changedReuse.json()).toMatchObject({ error: "conflict" });

      const wrongTenant = await production.app.inject({
        method: "POST",
        url: `/v1/admin/organizations/${otherOrganizationId}/mandates/${mandateId}/revoke`,
        headers: { authorization: headers.authorization },
      });
      expect(wrongTenant.statusCode).toBe(403);
      expect(wrongTenant.json()).toEqual({ error: "forbidden" });

      const revoked = await production.app.inject({
        method: "POST",
        url: `${base}/${mandateId}/revoke`,
        headers: { authorization: headers.authorization },
      });
      expect(revoked.statusCode).toBe(200);
      expect(revoked.json()).toMatchObject({
        outcome: "UPDATED",
        changed: true,
        mandate: { id: mandateId, status: "REVOKED" },
      });
      expect(await production.repositories.mandates.getById(mandateId)).toBeUndefined();

      // Cryptographic validity alone is intentionally insufficient after durable revocation.
      expect((await verifier.verify(issuedBody.mandateToken, now)).claims.mandateId).toBe(mandateId);

      const revokeReplay = await production.app.inject({
        method: "POST",
        url: `${base}/${mandateId}/revoke`,
        headers: { authorization: headers.authorization },
      });
      expect(revokeReplay.statusCode).toBe(200);
      expect(revokeReplay.json()).toMatchObject({ outcome: "REPLAYED", changed: false });

      const audits = await pool.query<{
        action: string;
        beforeState: unknown;
        afterState: unknown;
        metadata: unknown;
      }>(
        `select "action", "beforeState", "afterState", "metadata"
           from "AdminAuditLog"
          where "organizationId" = $1::uuid
          order by "chainSequence" asc`,
        [organizationId],
      );
      expect(audits.rows.map((row) => row.action)).toEqual(["mandate.issue", "mandate.revoke"]);
      const auditText = JSON.stringify(audits.rows);
      expect(auditText).not.toContain(issuedBody.mandateToken);
      expect(auditText).not.toContain("http-grant-2026-08-16");
      expect(await production.adminAuditVerifier.verifyOrganization(organizationId)).toMatchObject({
        valid: true,
        checkedEvents: 2,
      });
    } finally {
      await production.close();
    }
  });
});

function adminToken(privateKey: KeyObject): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "mandate-administration-rsa-1", typ: "JWT" }),
    "utf8",
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: issuer,
      sub: "mandate-administration-admin",
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
  const delegationKeys = generateKeyPairSync("ed25519");
  const auditKeys = generateKeyPairSync("ed25519");
  return {
    databaseUrl: DATABASE_URL,
    redisUrl: REDIS_URL,
    host: "127.0.0.1",
    port: 3000,
    issuer: "https://mino.example",
    mandateVerificationKeys: new Map([["mandate-http-k1", pemPublic(mandateSigningKeys.publicKey)]]),
    mandateSigningKey: {
      keyId: "mandate-http-k1",
      privateKey: pemPrivate(mandateSigningKeys.privateKey),
    },
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
