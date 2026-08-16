import {
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProductionConfig } from "../../src/infrastructure/config/production-config.js";
import { createProductionApplication } from "../../src/production/application.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const issuer = "https://agent-enrollment-login.example.test/";
const audience = "mino-admin";
const now = new Date("2026-08-16T01:30:00.000Z");

integration("production administrative agent enrollment HTTP surface", () => {
  let pool: Pool;
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const principalId = randomUUID();
  const membershipId = randomUUID();
  const jwtKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const agentKeys = generateKeyPairSync("ed25519");
  const agentPublicKey = agentKeys.publicKey.export({ type: "spki", format: "pem" }).toString();

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(
      `insert into "Organization" ("id", "name", "createdAt", "updatedAt")
       values ($1, 'Agent enrollment HTTP org', now(), now()),
              ($2, 'Agent enrollment other org', now(), now())`,
      [organizationId, otherOrganizationId],
    );
    await pool.query(
      `insert into "AdminPrincipal"
        ("id", "issuer", "subject", "status", "createdAt", "updatedAt")
       values ($1, $2, 'agent-enrollment-admin', 'ACTIVE', now(), now())`,
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
       values ($1, $2, 'AGENT_MANAGER', now())`,
      [randomUUID(), membershipId],
    );
  });

  afterAll(async () => {
    const organizationIds = [organizationId, otherOrganizationId];
    await pool.query(`delete from "AgentIdentity" where "organizationId" = any($1::uuid[])`, [
      organizationIds,
    ]);
    await pool.query(`delete from "AdminAuditLog" where "organizationId" = any($1::uuid[])`, [
      organizationIds,
    ]);
    await pool.query(
      `delete from "AdminAuditChainHead" where "organizationId" = any($1::uuid[])`,
      [organizationIds],
    );
    await pool.query(`delete from "Organization" where "id" = any($1::uuid[])`, [organizationIds]);
    await pool.query(`delete from "AdminPrincipal" where "id" = $1`, [principalId]);
    await pool.end();
  });

  it("creates and audits an agent atomically, replays exactly, and rejects conflicting or wrong-tenant reuse", async () => {
    const publicPem = jwtKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const production = await createProductionApplication(productionConfig(), {
      logger: false,
      now: () => now,
      adminJwtIssuers: [
        {
          issuer,
          audience,
          verificationKeys: new Map([["agent-enrollment-rsa-1", publicPem]]),
        },
      ],
    });
    const headers = { authorization: `Bearer ${token(jwtKeys.privateKey)}` };
    const url = `/v1/admin/organizations/${organizationId}/agents`;
    const payload = {
      externalAgentId: "procurement-bot",
      displayName: "Procurement Bot",
      keyId: "agent-k1",
      publicKey: agentPublicKey,
    };

    try {
      const created = await production.app.inject({ method: "POST", url, headers, payload });
      expect(created.statusCode).toBe(201);
      expect(created.headers["cache-control"]).toBe("no-store");
      expect(created.json()).toMatchObject({
        outcome: "CREATED",
        created: true,
        agent: {
          organizationId,
          externalAgentId: "procurement-bot",
          displayName: "Procurement Bot",
          status: "ACTIVE",
          keyId: "agent-k1",
        },
      });
      expect(created.body).not.toContain(agentPublicKey);

      const persisted = await pool.query<{
        id: string;
        publicKey: string;
        keyId: string;
        status: string;
      }>(
        `select "id", "publicKey", "keyId", "status"
           from "AgentIdentity"
          where "organizationId" = $1::uuid and "externalAgentId" = 'procurement-bot'`,
        [organizationId],
      );
      expect(persisted.rowCount).toBe(1);
      expect(persisted.rows[0]?.publicKey).toContain("BEGIN PUBLIC KEY");
      expect(persisted.rows[0]?.keyId).toBe("agent-k1");
      expect(persisted.rows[0]?.status).toBe("ACTIVE");

      const auditRows = await pool.query<{ action: string; resourceId: string }>(
        `select "action", "resourceId"
           from "AdminAuditLog"
          where "organizationId" = $1::uuid
          order by "chainSequence" asc`,
        [organizationId],
      );
      expect(auditRows.rows).toEqual([
        { action: "agent.create", resourceId: persisted.rows[0]?.id },
      ]);
      expect(await production.adminAuditVerifier.verifyOrganization(organizationId)).toMatchObject({
        valid: true,
        verifiedEvents: 1n,
      });

      const replayed = await production.app.inject({ method: "POST", url, headers, payload });
      expect(replayed.statusCode).toBe(200);
      expect(replayed.json()).toMatchObject({ outcome: "REPLAYED", created: false });
      const auditCountAfterReplay = await pool.query<{ count: string }>(
        `select count(*)::text as count from "AdminAuditLog" where "organizationId" = $1::uuid`,
        [organizationId],
      );
      expect(auditCountAfterReplay.rows[0]?.count).toBe("1");

      const conflict = await production.app.inject({
        method: "POST",
        url,
        headers,
        payload: { ...payload, displayName: "Changed Procurement Bot" },
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ outcome: "CONFLICT", error: "conflict" });

      const wrongTenant = await production.app.inject({
        method: "POST",
        url: `/v1/admin/organizations/${otherOrganizationId}/agents`,
        headers,
        payload,
      });
      expect(wrongTenant.statusCode).toBe(403);
      expect(wrongTenant.json()).toEqual({ error: "forbidden" });
      const otherTenantAgentCount = await pool.query<{ count: string }>(
        `select count(*)::text as count from "AgentIdentity" where "organizationId" = $1::uuid`,
        [otherOrganizationId],
      );
      expect(otherTenantAgentCount.rows[0]?.count).toBe("0");
    } finally {
      await production.close();
    }
  });
});

function token(privateKey: KeyObject): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "agent-enrollment-rsa-1", typ: "JWT" }),
    "utf8",
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: issuer,
      sub: "agent-enrollment-admin",
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
