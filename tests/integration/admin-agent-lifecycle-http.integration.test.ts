import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProductionConfig } from "../../src/infrastructure/config/production-config.js";
import { createProductionApplication } from "../../src/production/application.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const issuer = "https://agent-lifecycle-login.example.test/";
const audience = "mino-admin";
const now = new Date("2026-08-16T02:00:00.000Z");

integration("production administrative agent lifecycle HTTP surface", () => {
  let pool: Pool;
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const principalId = randomUUID();
  const membershipId = randomUUID();
  const agentId = randomUUID();
  const jwtKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const originalAgentKeys = generateKeyPairSync("ed25519");
  const rotatedAgentKeys = generateKeyPairSync("ed25519");
  const originalPublicKey = pemPublic(originalAgentKeys.publicKey);
  const rotatedPublicKey = pemPublic(rotatedAgentKeys.publicKey);

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(
      `insert into "Organization" ("id", "name", "createdAt", "updatedAt")
       values ($1, 'Agent lifecycle HTTP org', now(), now()),
              ($2, 'Agent lifecycle other org', now(), now())`,
      [organizationId, otherOrganizationId],
    );
    await pool.query(
      `insert into "AdminPrincipal"
        ("id", "issuer", "subject", "status", "createdAt", "updatedAt")
       values ($1, $2, 'agent-lifecycle-admin', 'ACTIVE', now(), now())`,
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
    await pool.query(
      `insert into "AgentIdentity"
        ("id", "organizationId", "externalAgentId", "displayName", "status", "publicKey", "keyId", "createdAt", "updatedAt")
       values ($1, $2, 'http-lifecycle-agent', 'HTTP Lifecycle Agent', 'ACTIVE', $3, 'agent-k1', now(), now())`,
      [agentId, organizationId, originalPublicKey],
    );
  });

  afterAll(async () => {
    const organizationIds = [organizationId, otherOrganizationId];
    await pool.query(`delete from "AdminAuditLog" where "organizationId" = any($1::uuid[])`, [organizationIds]);
    await pool.query(`delete from "AdminAuditChainHead" where "organizationId" = any($1::uuid[])`, [organizationIds]);
    await pool.query(`delete from "AgentIdentity" where "organizationId" = any($1::uuid[])`, [organizationIds]);
    await pool.query(`delete from "Organization" where "id" = any($1::uuid[])`, [organizationIds]);
    await pool.query(`delete from "AdminPrincipal" where "id" = $1`, [principalId]);
    await pool.end();
  });

  it("exposes safe detail and makes suspend/reactivate/key rotation effective at the production verification boundary", async () => {
    const publicPem = jwtKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const production = await createProductionApplication(productionConfig(), {
      logger: false,
      now: () => now,
      adminJwtIssuers: [
        {
          issuer,
          audience,
          verificationKeys: new Map([["agent-lifecycle-rsa-1", publicPem]]),
        },
      ],
    });
    const headers = { authorization: `Bearer ${token(jwtKeys.privateKey)}` };
    const base = `/v1/admin/organizations/${organizationId}/agents/${agentId}`;

    try {
      const detail = await production.app.inject({ method: "GET", url: base, headers });
      expect(detail.statusCode).toBe(200);
      expect(detail.headers["cache-control"]).toBe("no-store");
      expect(detail.json()).toMatchObject({
        agent: {
          id: agentId,
          organizationId,
          externalAgentId: "http-lifecycle-agent",
          status: "ACTIVE",
          keyId: "agent-k1",
        },
      });
      expect(detail.body).not.toContain(originalPublicKey);
      expect(await production.repositories.agentKeys.resolveAgentPublicKey(agentId, "agent-k1")).toBe(originalPublicKey);

      const suspended = await production.app.inject({ method: "POST", url: `${base}/suspend`, headers });
      expect(suspended.statusCode).toBe(200);
      expect(suspended.json()).toMatchObject({ outcome: "UPDATED", changed: true, agent: { status: "SUSPENDED" } });
      expect(await production.repositories.agentKeys.resolveAgentPublicKey(agentId, "agent-k1")).toBeUndefined();

      const suspendReplay = await production.app.inject({ method: "POST", url: `${base}/suspend`, headers });
      expect(suspendReplay.statusCode).toBe(200);
      expect(suspendReplay.json()).toMatchObject({ outcome: "REPLAYED", changed: false });

      const reactivated = await production.app.inject({ method: "POST", url: `${base}/reactivate`, headers });
      expect(reactivated.statusCode).toBe(200);
      expect(reactivated.json()).toMatchObject({ outcome: "UPDATED", changed: true, agent: { status: "ACTIVE" } });
      expect(await production.repositories.agentKeys.resolveAgentPublicKey(agentId, "agent-k1")).toBe(originalPublicKey);

      const rotated = await production.app.inject({
        method: "POST",
        url: `${base}/rotate-key`,
        headers,
        payload: { keyId: "agent-k2", publicKey: rotatedPublicKey },
      });
      expect(rotated.statusCode).toBe(200);
      expect(rotated.json()).toMatchObject({ outcome: "UPDATED", changed: true, agent: { keyId: "agent-k2" } });
      expect(rotated.body).not.toContain(rotatedPublicKey);
      expect(await production.repositories.agentKeys.resolveAgentPublicKey(agentId, "agent-k1")).toBeUndefined();
      expect(await production.repositories.agentKeys.resolveAgentPublicKey(agentId, "agent-k2")).toBe(rotatedPublicKey);

      const wrongTenant = await production.app.inject({
        method: "POST",
        url: `/v1/admin/organizations/${otherOrganizationId}/agents/${agentId}/suspend`,
        headers,
      });
      expect(wrongTenant.statusCode).toBe(403);
      expect(wrongTenant.json()).toEqual({ error: "forbidden" });

      const audits = await pool.query<{ action: string }>(
        `select "action" from "AdminAuditLog" where "organizationId" = $1::uuid order by "chainSequence" asc`,
        [organizationId],
      );
      expect(audits.rows.map((row) => row.action)).toEqual([
        "agent.suspend",
        "agent.reactivate",
        "agent.rotate_key",
      ]);
      expect(await production.adminAuditVerifier.verifyOrganization(organizationId)).toMatchObject({ valid: true, checkedEvents: 3 });
    } finally {
      await production.close();
    }
  });
});

function token(privateKey: KeyObject): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "agent-lifecycle-rsa-1", typ: "JWT" }),
    "utf8",
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: issuer,
      sub: "agent-lifecycle-admin",
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
