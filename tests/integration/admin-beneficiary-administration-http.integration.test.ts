import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProductionConfig } from "../../src/infrastructure/config/production-config.js";
import { createProductionApplication } from "../../src/production/application.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const issuer = "https://beneficiary-admin-login.example.test/";
const audience = "mino-admin";
const now = new Date("2026-08-20T18:30:00.000Z");

integration("production beneficiary administration HTTP surface", () => {
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
       values ($1::uuid, 'Beneficiary HTTP org', now(), now()),
              ($2::uuid, 'Other beneficiary HTTP org', now(), now())`,
      [organizationId, otherOrganizationId],
    );
    await pool.query(
      `insert into "AdminPrincipal"
        ("id", "issuer", "subject", "displayName", "status", "createdAt", "updatedAt")
       values ($1::uuid, $2, 'beneficiary-finance-admin', 'Beneficiary Finance Admin', 'ACTIVE', now(), now())`,
      [principalId, issuer],
    );
    await pool.query(
      `insert into "AdminOrganizationMembership"
        ("id", "organizationId", "principalId", "status", "createdAt", "updatedAt")
       values ($1::uuid, $2::uuid, $3::uuid, 'ACTIVE', now(), now())`,
      [membershipId, organizationId, principalId],
    );
    await pool.query(
      `insert into "AdminRoleAssignment" ("id", "membershipId", "role", "assignedAt")
       values ($1::uuid, $2::uuid, 'FINANCE_MANAGER', now())`,
      [randomUUID(), membershipId],
    );
  });

  afterAll(async () => {
    const organizations = [organizationId, otherOrganizationId];
    await pool.query(`delete from "AdminAuditLog" where "organizationId" = any($1::uuid[])`, [organizations]);
    await pool.query(`delete from "AdminAuditChainHead" where "organizationId" = any($1::uuid[])`, [organizations]);
    await pool.query(`delete from "User" where "organizationId" = any($1::uuid[])`, [organizations]);
    await pool.query(`delete from "Organization" where "id" = any($1::uuid[])`, [organizations]);
    await pool.query(`delete from "AdminPrincipal" where "id" = $1::uuid`, [principalId]);
    await pool.end();
  });

  it("creates, lists, selects, and fail-closed suspends a beneficiary through real JWT/RBAC", async () => {
    const publicPem = jwtKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const production = await createProductionApplication(productionConfig(), {
      logger: false,
      now: () => now,
      adminJwtIssuers: [
        {
          issuer,
          audience,
          verificationKeys: new Map([["beneficiary-admin-rsa-1", publicPem]]),
        },
      ],
    });
    const headers = { authorization: `Bearer ${token(jwtKeys.privateKey)}` };
    const base = `/v1/admin/organizations/${organizationId}/beneficiaries`;

    try {
      const created = await production.app.inject({
        method: "POST",
        url: base,
        headers,
        payload: { email: " Pilot.Buyer@Example.Test " },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({
        outcome: "CREATED",
        changed: true,
        beneficiary: {
          organizationId,
          email: "pilot.buyer@example.test",
          status: "ACTIVE",
        },
      });
      const beneficiaryId = created.json<{ beneficiary: { id: string } }>().beneficiary.id;

      const replay = await production.app.inject({
        method: "POST",
        url: base,
        headers,
        payload: { email: "pilot.buyer@example.test" },
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({
        outcome: "REPLAYED",
        changed: false,
        beneficiary: { id: beneficiaryId },
      });

      const inventory = await production.app.inject({ method: "GET", url: `${base}?limit=50`, headers });
      expect(inventory.statusCode).toBe(200);
      expect(inventory.json()).toMatchObject({
        items: [{ id: beneficiaryId, email: "pilot.buyer@example.test", status: "ACTIVE" }],
      });

      const detail = await production.app.inject({
        method: "GET",
        url: `${base}/${beneficiaryId}`,
        headers,
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({ beneficiary: { id: beneficiaryId } });

      const wrongOrganization = await production.app.inject({
        method: "GET",
        url: `/v1/admin/organizations/${otherOrganizationId}/beneficiaries/${beneficiaryId}`,
        headers,
      });
      expect(wrongOrganization.statusCode).toBe(403);
      expect(wrongOrganization.json()).toEqual({ error: "forbidden" });

      const suspended = await production.app.inject({
        method: "POST",
        url: `${base}/${beneficiaryId}/suspend`,
        headers,
      });
      expect(suspended.statusCode).toBe(200);
      expect(suspended.json()).toMatchObject({
        outcome: "UPDATED",
        changed: true,
        beneficiary: { id: beneficiaryId, status: "SUSPENDED" },
      });

      const recreateSuspended = await production.app.inject({
        method: "POST",
        url: base,
        headers,
        payload: { email: "PILOT.BUYER@example.test" },
      });
      expect(recreateSuspended.statusCode).toBe(409);
      expect(recreateSuspended.json()).toMatchObject({ error: "conflict" });

      const absentReactivation = await production.app.inject({
        method: "POST",
        url: `${base}/${beneficiaryId}/reactivate`,
        headers,
      });
      expect(absentReactivation.statusCode).toBe(404);

      const audits = await pool.query<{ action: string; permission: string }>(
        `select "action", "permission" from "AdminAuditLog"
          where "organizationId" = $1::uuid order by "chainSequence" asc`,
        [organizationId],
      );
      expect(audits.rows).toEqual([
        { action: "beneficiary.create", permission: "beneficiary.create" },
        { action: "beneficiary.suspend", permission: "beneficiary.suspend" },
      ]);
      expect(await production.adminAuditVerifier.verifyOrganization(organizationId)).toMatchObject({
        valid: true,
        checkedEvents: 2,
      });
    } finally {
      await production.close();
    }
  });
});

function token(privateKey: KeyObject): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "beneficiary-admin-rsa-1", typ: "JWT" }),
    "utf8",
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: issuer,
      sub: "beneficiary-finance-admin",
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
    mandateSigningKey: { keyId: "mino-k1", privateKey: pemPrivate(mandateKeys.privateKey) },
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
