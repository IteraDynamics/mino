import { generateKeyPairSync, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StaticAuditKeyProvider } from "../../src/infrastructure/crypto/static-key-providers.js";
import { PgSqlAdapter } from "../../src/infrastructure/postgres/pg-sql-adapter.js";
import {
  AdminMerchantValidationError,
  PostgresAdminMerchantAdministrationService,
  type AdminMerchantCreateRequest,
} from "../../src/modules/admin/admin-merchant-administration.js";
import {
  PostgresAdminChangeAuditLedger,
  PostgresAdminChangeAuditVerifier,
} from "../../src/modules/admin/admin-change-audit-ledger.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";

integration("administrative merchant administration", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("creates inactive merchants, preserves stable identity, and requires inactive routing maintenance", async () => {
    const organizationId = randomUUID();
    await createOrganization(pool, organizationId);
    const { service, verifier } = buildService(pool);
    const actor = actorFor(organizationId);
    const request: AdminMerchantCreateRequest = {
      externalMerchantId: "merchant-alpha",
      domain: "Shop.Example.com.",
      vendorId: "vendor-1",
      baseUrl: "https://shop.example.com:443/",
    };

    try {
      const created = await service.createMerchant(actor, request);
      expect(created.outcome).toBe("CREATED");
      if (created.outcome !== "CREATED") throw new Error("expected merchant creation");
      expect(created.merchant).toMatchObject({
        organizationId,
        externalMerchantId: "merchant-alpha",
        domain: "shop.example.com",
        vendorId: "vendor-1",
        baseUrl: "https://shop.example.com",
        active: false,
      });

      const replay = await service.createMerchant(actor, {
        ...request,
        domain: "shop.example.com",
        baseUrl: "https://SHOP.example.com/",
      });
      expect(replay.outcome).toBe("REPLAYED");
      expect(await auditCount(pool, organizationId)).toBe("1");

      expect(
        (
          await service.createMerchant(actor, {
            ...request,
            vendorId: "vendor-2",
          })
        ).outcome,
      ).toBe("CONFLICT");
      expect(await auditCount(pool, organizationId)).toBe("1");

      expect((await service.activate(actor, created.merchant.id)).outcome).toBe("UPDATED");
      expect((await service.activate(actor, created.merchant.id)).outcome).toBe("REPLAYED");
      expect(await auditCount(pool, organizationId)).toBe("2");

      const activeEdit = await service.updateConfiguration(actor, created.merchant.id, {
        domain: "api.example.com",
        vendorId: null,
        baseUrl: "https://api.example.com:8443/",
      });
      expect(activeEdit.outcome).toBe("CONFLICT");
      expect((await service.getMerchant(organizationId, created.merchant.id))?.domain).toBe(
        "shop.example.com",
      );

      expect((await service.deactivate(actor, created.merchant.id)).outcome).toBe("UPDATED");
      const updated = await service.updateConfiguration(actor, created.merchant.id, {
        domain: "API.Example.com.",
        vendorId: null,
        baseUrl: "https://api.example.com:8443/",
      });
      expect(updated.outcome).toBe("UPDATED");
      if (updated.outcome !== "UPDATED") throw new Error("expected merchant configuration update");
      expect(updated.merchant).toMatchObject({
        id: created.merchant.id,
        externalMerchantId: "merchant-alpha",
        domain: "api.example.com",
        baseUrl: "https://api.example.com:8443",
        active: false,
      });
      expect(updated.merchant.vendorId).toBeUndefined();

      expect(
        (
          await service.updateConfiguration(actor, created.merchant.id, {
            domain: "api.example.com",
            vendorId: null,
            baseUrl: "https://api.example.com:8443",
          })
        ).outcome,
      ).toBe("REPLAYED");
      expect(await auditCount(pool, organizationId)).toBe("4");

      expect((await service.activate(actor, created.merchant.id)).outcome).toBe("UPDATED");
      expect((await service.getMerchant(organizationId, created.merchant.id))?.active).toBe(true);

      const otherOrganizationId = randomUUID();
      await createOrganization(pool, otherOrganizationId);
      try {
        expect(await service.getMerchant(otherOrganizationId, created.merchant.id)).toBeUndefined();
        expect(
          (
            await service.deactivate(actorFor(otherOrganizationId), created.merchant.id)
          ).outcome,
        ).toBe("NOT_FOUND");
      } finally {
        await cleanupOrganization(pool, otherOrganizationId);
      }

      const audits = await pool.query<{ permission: string; action: string }>(
        `select "permission", "action" from "AdminAuditLog"
          where "organizationId" = $1::uuid order by "chainSequence" asc`,
        [organizationId],
      );
      expect(audits.rows).toEqual([
        { permission: "merchant.manage", action: "merchant.create" },
        { permission: "merchant.manage", action: "merchant.activate" },
        { permission: "merchant.manage", action: "merchant.deactivate" },
        { permission: "merchant.manage", action: "merchant.configuration.update" },
        { permission: "merchant.manage", action: "merchant.activate" },
      ]);
      expect(await verifier.verifyOrganization(organizationId)).toMatchObject({
        valid: true,
        checkedEvents: 5,
      });
    } finally {
      await cleanupOrganization(pool, organizationId);
    }
  });

  it("serializes equivalent concurrent registration into one row and one audit event", async () => {
    const organizationId = randomUUID();
    await createOrganization(pool, organizationId);
    const { service } = buildService(pool);
    const actor = actorFor(organizationId);
    const request = baseMerchantRequest("concurrent-merchant");

    try {
      const results = await Promise.all([
        service.createMerchant(actor, request),
        service.createMerchant(actor, request),
      ]);
      expect(results.map((result) => result.outcome).sort()).toEqual(["CREATED", "REPLAYED"]);
      expect(
        (
          await pool.query<{ count: string }>(
            `select count(*)::text as count from "MerchantEndpoint"
              where "organizationId" = $1::uuid and "externalMerchantId" = $2`,
            [organizationId, request.externalMerchantId],
          )
        ).rows[0]?.count,
      ).toBe("1");
      expect(await auditCount(pool, organizationId)).toBe("1");
    } finally {
      await cleanupOrganization(pool, organizationId);
    }
  });

  it("rejects unsafe routing before merchant or audit persistence", async () => {
    const organizationId = randomUUID();
    await createOrganization(pool, organizationId);
    const { service } = buildService(pool);
    const actor = actorFor(organizationId);

    try {
      for (const request of [
        { ...baseMerchantRequest("http"), baseUrl: "http://shop.example.com" },
        { ...baseMerchantRequest("mismatch"), baseUrl: "https://other.example.com" },
        { ...baseMerchantRequest("ip"), domain: "127.0.0.1", baseUrl: "https://127.0.0.1" },
        { ...baseMerchantRequest("path"), baseUrl: "https://shop.example.com/private" },
      ]) {
        await expect(service.createMerchant(actor, request)).rejects.toBeInstanceOf(
          AdminMerchantValidationError,
        );
      }
      expect(
        (
          await pool.query<{ count: string }>(
            `select count(*)::text as count from "MerchantEndpoint" where "organizationId" = $1::uuid`,
            [organizationId],
          )
        ).rows[0]?.count,
      ).toBe("0");
      expect(await auditCount(pool, organizationId)).toBe("0");
    } finally {
      await cleanupOrganization(pool, organizationId);
    }
  });
});

function baseMerchantRequest(externalMerchantId: string): AdminMerchantCreateRequest {
  return {
    externalMerchantId,
    domain: "shop.example.com",
    vendorId: "vendor-1",
    baseUrl: "https://shop.example.com",
  };
}

function buildService(pool: Pool) {
  const auditKeys = generateKeyPairSync("ed25519");
  const privateKey = auditKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKey = auditKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const sql = new PgSqlAdapter(pool);
  const provider = new StaticAuditKeyProvider(
    { keyId: "merchant-administration-audit-k1", privateKey },
    new Map([["merchant-administration-audit-k1", publicKey]]),
  );
  const audit = new PostgresAdminChangeAuditLedger(sql, provider);
  return {
    service: new PostgresAdminMerchantAdministrationService(sql, audit),
    verifier: new PostgresAdminChangeAuditVerifier(sql, provider),
  };
}

function actorFor(organizationId: string) {
  return {
    principalId: randomUUID(),
    membershipId: randomUUID(),
    organizationId,
    roles: ["SECURITY_ADMIN" as const],
  };
}

async function createOrganization(pool: Pool, organizationId: string): Promise<void> {
  await pool.query(
    `insert into "Organization" ("id", "name", "createdAt", "updatedAt")
     values ($1::uuid, $2, now(), now())`,
    [organizationId, `Merchant administration ${organizationId}`],
  );
}

async function auditCount(pool: Pool, organizationId: string): Promise<string | undefined> {
  return (
    await pool.query<{ count: string }>(
      `select count(*)::text as count from "AdminAuditLog" where "organizationId" = $1::uuid`,
      [organizationId],
    )
  ).rows[0]?.count;
}

async function cleanupOrganization(pool: Pool, organizationId: string): Promise<void> {
  await pool.query(`delete from "AdminAuditLog" where "organizationId" = $1::uuid`, [organizationId]);
  await pool.query(`delete from "AdminAuditChainHead" where "organizationId" = $1::uuid`, [organizationId]);
  await pool.query(`delete from "MerchantEndpoint" where "organizationId" = $1::uuid`, [organizationId]);
  await pool.query(`delete from "Organization" where "id" = $1::uuid`, [organizationId]);
}