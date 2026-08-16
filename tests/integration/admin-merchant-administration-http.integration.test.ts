import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProductionConfig } from "../../src/infrastructure/config/production-config.js";
import { merchantCredentialKey } from "../../src/infrastructure/config/production-config.js";
import { StaticMerchantCredentialProvider } from "../../src/infrastructure/merchant/static-merchant-credential-provider.js";
import { assertRegisteredHttpsTarget } from "../../src/modules/proxy/merchant-client.js";
import { createProductionApplication } from "../../src/production/application.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const issuer = "https://merchant-administration-login.example.test/";
const audience = "mino-admin";
const now = new Date("2026-08-16T15:15:00.000Z");

integration("production administrative merchant administration HTTP surface", () => {
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
       values ($1, 'Merchant administration HTTP org', now(), now()),
              ($2, 'Merchant administration other org', now(), now())`,
      [organizationId, otherOrganizationId],
    );
    await pool.query(
      `insert into "AdminPrincipal"
        ("id", "issuer", "subject", "status", "createdAt", "updatedAt")
       values ($1, $2, 'merchant-administration-admin', 'ACTIVE', now(), now())`,
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
       values ($1, $2, 'SECURITY_ADMIN', now())`,
      [randomUUID(), membershipId],
    );
  });

  afterAll(async () => {
    const organizationIds = [organizationId, otherOrganizationId];
    await pool.query(`delete from "AdminAuditLog" where "organizationId" = any($1::uuid[])`, [organizationIds]);
    await pool.query(`delete from "AdminAuditChainHead" where "organizationId" = any($1::uuid[])`, [organizationIds]);
    await pool.query(`delete from "MerchantEndpoint" where "organizationId" = any($1::uuid[])`, [organizationIds]);
    await pool.query(`delete from "Organization" where "id" = any($1::uuid[])`, [organizationIds]);
    await pool.query(`delete from "AdminPrincipal" where "id" = $1`, [principalId]);
    await pool.end();
  });

  it("changes the production merchant resolver immediately without exposing merchant credentials", async () => {
    const credential = "Bearer merchant-runtime-secret";
    const config = productionConfig(organizationId, credential);
    const publicPem = jwtKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const production = await createProductionApplication(config, {
      logger: false,
      now: () => now,
      adminJwtIssuers: [
        {
          issuer,
          audience,
          verificationKeys: new Map([["merchant-administration-rsa-1", publicPem]]),
        },
      ],
    });
    const credentialProvider = new StaticMerchantCredentialProvider(config.merchantCredentials);
    const headers = { authorization: `Bearer ${token(jwtKeys.privateKey)}` };
    const base = `/v1/admin/organizations/${organizationId}/merchants`;

    try {
      const created = await production.app.inject({
        method: "POST",
        url: base,
        headers,
        payload: {
          externalMerchantId: "merchant-alpha",
          domain: "Shop.Example.com.",
          vendorId: "vendor-1",
          baseUrl: "https://shop.example.com:443/",
        },
      });
      expect(created.statusCode).toBe(201);
      expect(created.headers["cache-control"]).toBe("no-store");
      expect(created.body).not.toContain(credential);
      const createdBody = created.json<{
        merchant: { id: string; active: boolean; domain: string; baseUrl: string };
      }>();
      expect(createdBody.merchant).toMatchObject({
        active: false,
        domain: "shop.example.com",
        baseUrl: "https://shop.example.com",
      });
      const merchantId = createdBody.merchant.id;

      const initialResolved = await production.repositories.merchants.getById(
        organizationId,
        "merchant-alpha",
      );
      expect(initialResolved).toMatchObject({
        id: "merchant-alpha",
        domain: "shop.example.com",
        baseUrl: "https://shop.example.com",
        active: false,
      });
      expect(() => assertRegisteredHttpsTarget(initialResolved!)).toThrow("Merchant is inactive");

      const detail = await production.app.inject({
        method: "GET",
        url: `${base}/${merchantId}`,
        headers,
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.body).not.toContain(credential);
      expect(detail.json()).toMatchObject({
        merchant: {
          id: merchantId,
          organizationId,
          externalMerchantId: "merchant-alpha",
          domain: "shop.example.com",
          baseUrl: "https://shop.example.com",
          active: false,
        },
      });

      const inventory = await production.app.inject({ method: "GET", url: base, headers });
      expect(inventory.statusCode).toBe(200);
      expect(inventory.body).not.toContain(credential);
      expect(inventory.body).not.toContain("baseUrl");

      const activated = await production.app.inject({
        method: "POST",
        url: `${base}/${merchantId}/activate`,
        headers,
      });
      expect(activated.statusCode).toBe(200);
      expect(activated.json()).toMatchObject({
        outcome: "UPDATED",
        changed: true,
        merchant: { active: true },
      });
      const activeResolved = await production.repositories.merchants.getById(
        organizationId,
        "merchant-alpha",
      );
      expect(activeResolved?.active).toBe(true);
      expect(assertRegisteredHttpsTarget(activeResolved!)).toEqual({
        domain: "shop.example.com",
        baseUrl: "https://shop.example.com",
      });

      const liveEdit = await production.app.inject({
        method: "POST",
        url: `${base}/${merchantId}/configuration`,
        headers,
        payload: {
          domain: "api.example.com",
          vendorId: null,
          baseUrl: "https://api.example.com:8443/",
        },
      });
      expect(liveEdit.statusCode).toBe(409);
      expect((await production.repositories.merchants.getById(organizationId, "merchant-alpha"))?.domain).toBe(
        "shop.example.com",
      );

      expect(
        (
          await production.app.inject({
            method: "POST",
            url: `${base}/${merchantId}/deactivate`,
            headers,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (await production.repositories.merchants.getById(organizationId, "merchant-alpha"))?.active,
      ).toBe(false);

      const updated = await production.app.inject({
        method: "POST",
        url: `${base}/${merchantId}/configuration`,
        headers,
        payload: {
          domain: "api.example.com",
          vendorId: null,
          baseUrl: "https://api.example.com:8443/",
        },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.body).not.toContain(credential);
      expect(updated.json()).toMatchObject({
        outcome: "UPDATED",
        merchant: {
          id: merchantId,
          externalMerchantId: "merchant-alpha",
          domain: "api.example.com",
          baseUrl: "https://api.example.com:8443",
          active: false,
        },
      });

      expect(
        (
          await production.app.inject({
            method: "POST",
            url: `${base}/${merchantId}/activate`,
            headers,
          })
        ).statusCode,
      ).toBe(200);
      expect(await production.repositories.merchants.getById(organizationId, "merchant-alpha")).toMatchObject({
        id: "merchant-alpha",
        domain: "api.example.com",
        baseUrl: "https://api.example.com:8443",
        active: true,
      });

      expect(
        await credentialProvider.getAuthorization(organizationId, "merchant-alpha"),
      ).toBe(credential);

      const wrongTenant = await production.app.inject({
        method: "POST",
        url: `/v1/admin/organizations/${otherOrganizationId}/merchants/${merchantId}/deactivate`,
        headers,
      });
      expect(wrongTenant.statusCode).toBe(403);
      expect(wrongTenant.json()).toEqual({ error: "forbidden" });

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
      expect(audits.rows.map((row) => row.action)).toEqual([
        "merchant.create",
        "merchant.activate",
        "merchant.deactivate",
        "merchant.configuration.update",
        "merchant.activate",
      ]);
      expect(JSON.stringify(audits.rows)).not.toContain("merchant-runtime-secret");
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
    JSON.stringify({ alg: "RS256", kid: "merchant-administration-rsa-1", typ: "JWT" }),
    "utf8",
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: issuer,
      sub: "merchant-administration-admin",
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

function productionConfig(organizationId: string, credential: string): ProductionConfig {
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
    merchantCredentials: new Map([
      [merchantCredentialKey(organizationId, "merchant-alpha"), credential],
    ]),
  };
}

function pemPublic(key: KeyObject): string {
  return key.export({ type: "spki", format: "pem" }).toString();
}

function pemPrivate(key: KeyObject): string {
  return key.export({ type: "pkcs8", format: "pem" }).toString();
}