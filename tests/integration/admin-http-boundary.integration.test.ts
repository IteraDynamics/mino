import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProductionConfig } from "../../src/infrastructure/config/production-config.js";
import { createProductionApplication } from "../../src/production/application.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const issuer = "https://login.example.test/";
const audience = "mino-admin";
const now = new Date("2026-08-15T06:15:00.000Z");

integration("production admin HTTP authentication boundary", () => {
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
       values ($1, 'Admin HTTP org', now(), now()), ($2, 'Other org', now(), now())`,
      [organizationId, otherOrganizationId],
    );
    await pool.query(
      `insert into "AdminPrincipal"
        ("id", "issuer", "subject", "email", "displayName", "status", "createdAt", "updatedAt")
       values ($1, $2, 'alice-subject', 'alice@example.test', 'Alice Admin', 'ACTIVE', now(), now())`,
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
    await pool.query(`delete from "Organization" where "id" = any($1::uuid[])`, [
      [organizationId, otherOrganizationId],
    ]);
    await pool.query(`delete from "AdminPrincipal" where "id" = $1`, [principalId]);
    await pool.end();
  });

  it("keeps the admin route absent unless trusted JWT issuers are explicitly configured", async () => {
    const production = await createProductionApplication(productionConfig(), {
      logger: false,
      now: () => now,
    });
    try {
      const response = await production.app.inject({
        method: "GET",
        url: `/v1/admin/organizations/${organizationId}/access`,
        headers: { authorization: `Bearer ${token(jwtKeys.privateKey)}` },
      });
      expect(response.statusCode).toBe(404);
      expect(production.adminAccess).toBeUndefined();
    } finally {
      await production.close();
    }
  });

  it("authenticates the JWT, applies exact organization RBAC, and exposes the enrolled human-readable access profile", async () => {
    const publicPem = jwtKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const production = await createProductionApplication(productionConfig(), {
      logger: false,
      now: () => now,
      adminJwtIssuers: [
        {
          issuer,
          audience,
          verificationKeys: new Map([["admin-rsa-1", publicPem]]),
        },
      ],
    });

    try {
      const allowed = await production.app.inject({
        method: "GET",
        url: `/v1/admin/organizations/${organizationId}/access`,
        headers: { authorization: `Bearer ${token(jwtKeys.privateKey)}` },
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json()).toMatchObject({
        principalId,
        membershipId,
        organizationId,
        organization: {
          id: organizationId,
          name: "Admin HTTP org",
        },
        principal: {
          id: principalId,
          displayName: "Alice Admin",
          email: "alice@example.test",
        },
        roles: ["FINANCE_MANAGER"],
      });
      expect(allowed.json().permissions).toContain("policy.activate");
      expect(allowed.body).toContain("alice@example.test");
      expect(allowed.body).toContain("Alice Admin");
      expect(allowed.body).not.toContain("alice-subject");
      expect(allowed.body).not.toContain(issuer);

      const wrongAudience = await production.app.inject({
        method: "GET",
        url: `/v1/admin/organizations/${organizationId}/access`,
        headers: {
          authorization: `Bearer ${token(jwtKeys.privateKey, { aud: "different-service" })}`,
        },
      });
      expect(wrongAudience.statusCode).toBe(401);
      expect(wrongAudience.json()).toEqual({ error: "unauthorized" });

      const unenrolledIdentity = await production.app.inject({
        method: "GET",
        url: `/v1/admin/organizations/${organizationId}/access`,
        headers: {
          authorization: `Bearer ${token(jwtKeys.privateKey, { sub: "not-enrolled" })}`,
        },
      });
      expect(unenrolledIdentity.statusCode).toBe(403);
      expect(unenrolledIdentity.json()).toEqual({ error: "forbidden" });

      const wrongOrganization = await production.app.inject({
        method: "GET",
        url: `/v1/admin/organizations/${otherOrganizationId}/access`,
        headers: { authorization: `Bearer ${token(jwtKeys.privateKey)}` },
      });
      expect(wrongOrganization.statusCode).toBe(403);
      expect(wrongOrganization.json()).toEqual({ error: "forbidden" });
    } finally {
      await production.close();
    }
  });
});

function token(privateKey: KeyObject, overrides: Record<string, unknown> = {}): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "admin-rsa-1", typ: "JWT" }),
    "utf8",
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: issuer,
      sub: "alice-subject",
      aud: audience,
      iat: Math.floor(now.getTime() / 1_000) - 60,
      exp: Math.floor(now.getTime() / 1_000) + 300,
      ...overrides,
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
