import { generateKeyPairSync, randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../../src/generated/prisma/client.js";
import { StaticAuditKeyProvider } from "../../src/infrastructure/crypto/static-key-providers.js";
import { PgSqlAdapter } from "../../src/infrastructure/postgres/pg-sql-adapter.js";
import { PrismaMandateRepository } from "../../src/infrastructure/prisma/control-plane.repositories.js";
import { PostgresAdminBeneficiaryAdministrationService } from "../../src/modules/admin/admin-beneficiary-administration.js";
import {
  PostgresAdminChangeAuditLedger,
  PostgresAdminChangeAuditVerifier,
} from "../../src/modules/admin/admin-change-audit-ledger.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";

integration("administrative beneficiary management", () => {
  let pool: Pool;
  let prisma: PrismaClient;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5_000 }),
    });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await pool.end();
  });

  it("creates a human-readable beneficiary, replays safely, and suspension immediately invalidates bound mandates", async () => {
    const organizationId = randomUUID();
    await pool.query(
      `insert into "Organization" ("id", "name", "createdAt", "updatedAt")
       values ($1::uuid, $2, now(), now())`,
      [organizationId, `Beneficiary pilot ${organizationId}`],
    );
    const { service, verifier } = buildService(pool);
    const actor = actorFor(organizationId);
    const mandateResolver = new PrismaMandateRepository(prisma);

    try {
      const created = await service.createBeneficiary(actor, { email: " Buyer@Example.Test " });
      expect(created.outcome).toBe("CREATED");
      if (created.outcome !== "CREATED") throw new Error("expected beneficiary creation");
      expect(created.beneficiary).toMatchObject({
        organizationId,
        email: "buyer@example.test",
        status: "ACTIVE",
      });
      const beneficiaryId = created.beneficiary.id;

      const replay = await service.createBeneficiary(actor, { email: "buyer@example.test" });
      expect(replay.outcome).toBe("REPLAYED");
      if (replay.outcome !== "REPLAYED") throw new Error("expected beneficiary replay");
      expect(replay.beneficiary.id).toBe(beneficiaryId);
      expect(await auditCount(pool, organizationId)).toBe("1");

      const page = await service.listBeneficiaries({ organizationId, limit: 50 });
      expect(page.items).toEqual([
        expect.objectContaining({ id: beneficiaryId, email: "buyer@example.test", status: "ACTIVE" }),
      ]);
      await expect(service.getBeneficiary(organizationId, beneficiaryId)).resolves.toMatchObject({
        id: beneficiaryId,
        email: "buyer@example.test",
      });

      const agentId = randomUUID();
      const policyId = randomUUID();
      const mandateId = randomUUID();
      const keys = generateKeyPairSync("ed25519");
      await pool.query(
        `insert into "AgentIdentity"
          ("id", "organizationId", "externalAgentId", "status", "publicKey", "keyId", "createdAt", "updatedAt")
         values ($1::uuid, $2::uuid, 'beneficiary-agent', 'ACTIVE', $3, 'agent-k1', now(), now())`,
        [agentId, organizationId, pemPublic(keys.publicKey)],
      );
      await pool.query(
        `insert into "Policy" (
           "id", "organizationId", "name", "version", "active", "baseCurrency",
           "maxBudgetMinor", "rollingDailyLimitMinor", "approvedMerchantDomains", "approvedVendorIds",
           "restrictedCategories", "approvalMode", "maxTransactionsPerMinute",
           "crossMerchantWindowSecs", "maxDistinctMerchants", "createdAt", "updatedAt"
         ) values (
           $1::uuid, $2::uuid, 'Beneficiary policy', 1, true, 'USD',
           50000, 200000, array['merchant.example'], array[]::text[], array[]::text[],
           'AUTO_APPROVE', 10, 60, 5, now(), now()
         )`,
        [policyId, organizationId],
      );
      await pool.query(
        `insert into "AgentMandate" (
           "id", "organizationId", "userId", "agentId", "policyId", "tokenJtiHash",
           "policyVersion", "currency", "maxBudgetMinor", "rollingDailyLimitMinor",
           "approvedMerchantDomains", "approvedVendorIds", "restrictedCategories", "approvalMode",
           "maxTransactionsPerMinute", "crossMerchantWindowSecs", "maxDistinctMerchants",
           "delegationPayloadHash", "signingKeyId", "status", "issuedAt", "expiresAt"
         ) values (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6,
           1, 'USD', 50000, 200000,
           array['merchant.example'], array[]::text[], array[]::text[], 'AUTO_APPROVE',
           10, 60, 5, 'beneficiary-delegation', 'mino-k1', 'ACTIVE', now(), now() + interval '1 day'
         )`,
        [mandateId, organizationId, beneficiaryId, agentId, policyId, `jti-${mandateId}`],
      );
      expect(await mandateResolver.getById(mandateId)).toBeDefined();

      const suspended = await service.suspendBeneficiary(actor, beneficiaryId);
      expect(suspended.outcome).toBe("UPDATED");
      if (suspended.outcome !== "UPDATED") throw new Error("expected beneficiary suspension");
      expect(suspended.beneficiary.status).toBe("SUSPENDED");
      expect(await mandateResolver.getById(mandateId)).toBeUndefined();

      const suspendReplay = await service.suspendBeneficiary(actor, beneficiaryId);
      expect(suspendReplay.outcome).toBe("REPLAYED");
      expect(await auditCount(pool, organizationId)).toBe("2");
      expect((await service.createBeneficiary(actor, { email: "BUYER@example.test" })).outcome).toBe(
        "CONFLICT",
      );

      const auditRows = await pool.query<{ permission: string; action: string }>(
        `select "permission", "action" from "AdminAuditLog"
          where "organizationId" = $1::uuid order by "chainSequence" asc`,
        [organizationId],
      );
      expect(auditRows.rows).toEqual([
        { permission: "beneficiary.create", action: "beneficiary.create" },
        { permission: "beneficiary.suspend", action: "beneficiary.suspend" },
      ]);
      expect(await verifier.verifyOrganization(organizationId)).toMatchObject({
        valid: true,
        checkedEvents: 2,
      });
    } finally {
      await cleanupOrganization(pool, organizationId);
    }
  });

  it("scopes detail and suspension to the exact organization and treats DISABLED as terminal", async () => {
    const organizationId = randomUUID();
    const otherOrganizationId = randomUUID();
    const beneficiaryId = randomUUID();
    await pool.query(
      `insert into "Organization" ("id", "name", "createdAt", "updatedAt")
       values ($1::uuid, 'Beneficiary org', now(), now()),
              ($2::uuid, 'Other beneficiary org', now(), now())`,
      [organizationId, otherOrganizationId],
    );
    await pool.query(
      `insert into "User" ("id", "organizationId", "email", "status", "createdAt", "updatedAt")
       values ($1::uuid, $2::uuid, 'disabled@example.test', 'DISABLED', now(), now())`,
      [beneficiaryId, organizationId],
    );
    const { service } = buildService(pool);

    try {
      await expect(service.getBeneficiary(otherOrganizationId, beneficiaryId)).resolves.toBeUndefined();
      expect(
        (await service.suspendBeneficiary(actorFor(otherOrganizationId), beneficiaryId)).outcome,
      ).toBe("NOT_FOUND");
      expect((await service.suspendBeneficiary(actorFor(organizationId), beneficiaryId)).outcome).toBe(
        "CONFLICT",
      );
      expect(await auditCount(pool, organizationId)).toBe("0");
      expect(await auditCount(pool, otherOrganizationId)).toBe("0");
    } finally {
      await cleanupOrganization(pool, organizationId);
      await cleanupOrganization(pool, otherOrganizationId);
    }
  });
});

function buildService(pool: Pool) {
  const auditKeys = generateKeyPairSync("ed25519");
  const privateKey = auditKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKey = pemPublic(auditKeys.publicKey);
  const sql = new PgSqlAdapter(pool);
  const provider = new StaticAuditKeyProvider(
    { keyId: "beneficiary-audit-k1", privateKey },
    new Map([["beneficiary-audit-k1", publicKey]]),
  );
  const audit = new PostgresAdminChangeAuditLedger(sql, provider);
  return {
    service: new PostgresAdminBeneficiaryAdministrationService(sql, audit),
    verifier: new PostgresAdminChangeAuditVerifier(sql, provider),
  };
}

function actorFor(organizationId: string) {
  return {
    principalId: randomUUID(),
    membershipId: randomUUID(),
    organizationId,
    roles: ["FINANCE_MANAGER" as const],
  };
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
  await pool.query(`delete from "AgentMandate" where "organizationId" = $1::uuid`, [organizationId]);
  await pool.query(`delete from "Policy" where "organizationId" = $1::uuid`, [organizationId]);
  await pool.query(`delete from "AgentIdentity" where "organizationId" = $1::uuid`, [organizationId]);
  await pool.query(`delete from "User" where "organizationId" = $1::uuid`, [organizationId]);
  await pool.query(`delete from "Organization" where "id" = $1::uuid`, [organizationId]);
}

function pemPublic(key: import("node:crypto").KeyObject): string {
  return key.export({ type: "spki", format: "pem" }).toString();
}
