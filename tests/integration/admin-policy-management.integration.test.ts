import { generateKeyPairSync, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StaticAuditKeyProvider } from "../../src/infrastructure/crypto/static-key-providers.js";
import { PgSqlAdapter } from "../../src/infrastructure/postgres/pg-sql-adapter.js";
import {
  AdminPolicyValidationError,
  PostgresAdminPolicyManagementService,
  type AdminPolicyCreateRequest,
} from "../../src/modules/admin/admin-policy-management.js";
import {
  PostgresAdminChangeAuditLedger,
  PostgresAdminChangeAuditVerifier,
} from "../../src/modules/admin/admin-change-audit-ledger.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";

integration("administrative policy management", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("creates immutable inactive versions, replays exact retries, and changes activation explicitly", async () => {
    const organizationId = randomUUID();
    await createOrganization(pool, organizationId);
    const { service, verifier } = buildService(pool);
    const actor = actorFor(organizationId);
    const initialRequest: AdminPolicyCreateRequest = {
      name: "Procurement",
      baseCurrency: "usd",
      maxBudgetMinor: "25000",
      rollingDailyLimitMinor: "100000",
      approvedMerchantDomains: ["Shop.Example.com.", "example.com", "example.com"],
      approvedVendorIds: ["vendor-b", "vendor-a", "vendor-a"],
      restrictedCategories: ["gift cards", "GAMBLING", "gift-cards"],
      approvalMode: "DUAL_SIGNATURE_SLACK",
      maxTransactionsPerMinute: 10,
      crossMerchantWindowSecs: 60,
      maxDistinctMerchants: 5,
    };

    try {
      const created = await service.createPolicy(actor, initialRequest);
      expect(created.outcome).toBe("CREATED");
      if (created.outcome !== "CREATED") throw new Error("expected policy creation");
      expect(created.policy).toMatchObject({
        name: "Procurement",
        version: 1,
        active: false,
        baseCurrency: "USD",
        maxBudgetMinor: "25000",
        approvedMerchantDomains: ["example.com", "shop.example.com"],
        approvedVendorIds: ["vendor-a", "vendor-b"],
        restrictedCategories: ["GAMBLING", "GIFT_CARDS"],
      });

      const replay = await service.createPolicy(actor, initialRequest);
      expect(replay.outcome).toBe("REPLAYED");
      expect(await auditCount(pool, organizationId)).toBe("1");

      const activatedV1 = await service.activate(actor, created.policy.id);
      expect(activatedV1.outcome).toBe("UPDATED");
      expect((await service.activate(actor, created.policy.id)).outcome).toBe("REPLAYED");
      expect(await auditCount(pool, organizationId)).toBe("2");

      const versionTwoRequest = {
        version: 2,
        baseCurrency: "USD",
        maxBudgetMinor: "40000",
        rollingDailyLimitMinor: "150000",
        approvedMerchantDomains: ["example.com"],
        approvedVendorIds: ["vendor-a"],
        restrictedCategories: ["GAMBLING"],
        approvalMode: "HARD_BLOCK" as const,
        maxTransactionsPerMinute: 8,
        crossMerchantWindowSecs: 90,
        maxDistinctMerchants: 4,
      };
      const versionTwo = await service.createVersion(actor, created.policy.id, versionTwoRequest);
      expect(versionTwo.outcome).toBe("CREATED");
      if (versionTwo.outcome !== "CREATED") throw new Error("expected version creation");
      expect(versionTwo.policy).toMatchObject({
        name: "Procurement",
        version: 2,
        active: false,
        maxBudgetMinor: "40000",
      });

      const versionReplay = await service.createVersion(actor, created.policy.id, versionTwoRequest);
      expect(versionReplay.outcome).toBe("REPLAYED");
      expect(await auditCount(pool, organizationId)).toBe("3");

      const changedReuse = await service.createVersion(actor, created.policy.id, {
        ...versionTwoRequest,
        maxBudgetMinor: "40001",
      });
      expect(changedReuse.outcome).toBe("CONFLICT");
      expect(await auditCount(pool, organizationId)).toBe("3");

      expect((await service.activate(actor, versionTwo.policy.id)).outcome).toBe("UPDATED");
      expect((await service.getPolicy(organizationId, created.policy.id))?.active).toBe(true);
      expect((await service.getPolicy(organizationId, versionTwo.policy.id))?.active).toBe(true);

      expect((await service.deactivate(actor, created.policy.id)).outcome).toBe("UPDATED");
      expect((await service.deactivate(actor, created.policy.id)).outcome).toBe("REPLAYED");
      expect((await service.getPolicy(organizationId, created.policy.id))?.active).toBe(false);
      expect((await service.getPolicy(organizationId, versionTwo.policy.id))?.active).toBe(true);

      const branchAttempt = await service.createVersion(actor, created.policy.id, {
        ...versionTwoRequest,
        version: 3,
      });
      expect(branchAttempt.outcome).toBe("CONFLICT");

      const audits = await pool.query<{ permission: string; action: string }>(
        `select "permission", "action" from "AdminAuditLog"
          where "organizationId" = $1::uuid order by "chainSequence" asc`,
        [organizationId],
      );
      expect(audits.rows).toEqual([
        { permission: "policy.create", action: "policy.create" },
        { permission: "policy.activate", action: "policy.activate" },
        { permission: "policy.create", action: "policy.version.create" },
        { permission: "policy.activate", action: "policy.activate" },
        { permission: "policy.deactivate", action: "policy.deactivate" },
      ]);
      expect(await verifier.verifyOrganization(organizationId)).toMatchObject({
        valid: true,
        checkedEvents: 5,
      });
    } finally {
      await cleanupOrganization(pool, organizationId);
    }
  });

  it("serializes competing equivalent version creation into one durable version and one audit event", async () => {
    const organizationId = randomUUID();
    await createOrganization(pool, organizationId);
    const { service } = buildService(pool);
    const actor = actorFor(organizationId);

    try {
      const created = await service.createPolicy(actor, basePolicyRequest("Concurrent"));
      if (created.outcome !== "CREATED") throw new Error("expected policy creation");
      const request = {
        version: 2,
        ...baseConfiguration({ maxBudgetMinor: "30000" }),
      };
      const results = await Promise.all([
        service.createVersion(actor, created.policy.id, request),
        service.createVersion(actor, created.policy.id, request),
      ]);
      expect(results.map((result) => result.outcome).sort()).toEqual(["CREATED", "REPLAYED"]);
      expect(
        (
          await pool.query<{ count: string }>(
            `select count(*)::text as count from "Policy"
              where "organizationId" = $1::uuid and "name" = 'Concurrent'`,
            [organizationId],
          )
        ).rows[0]?.count,
      ).toBe("2");
      expect(await auditCount(pool, organizationId)).toBe("2");
    } finally {
      await cleanupOrganization(pool, organizationId);
    }
  });

  it("rejects unusable monetary, currency, and domain configuration before persistence", async () => {
    const organizationId = randomUUID();
    await createOrganization(pool, organizationId);
    const { service } = buildService(pool);
    const actor = actorFor(organizationId);

    try {
      await expect(
        service.createPolicy(actor, {
          ...basePolicyRequest("Bad currency"),
          baseCurrency: "XYZ",
        }),
      ).rejects.toBeInstanceOf(AdminPolicyValidationError);
      await expect(
        service.createPolicy(actor, {
          ...basePolicyRequest("Overflow"),
          maxBudgetMinor: "9223372036854775808",
        }),
      ).rejects.toBeInstanceOf(AdminPolicyValidationError);
      await expect(
        service.createPolicy(actor, {
          ...basePolicyRequest("Bad domain"),
          approvedMerchantDomains: ["https://example.com/path"],
        }),
      ).rejects.toBeInstanceOf(AdminPolicyValidationError);
      expect(
        (
          await pool.query<{ count: string }>(
            `select count(*)::text as count from "Policy" where "organizationId" = $1::uuid`,
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

function basePolicyRequest(name: string): AdminPolicyCreateRequest {
  return { name, ...baseConfiguration() };
}

function baseConfiguration(overrides: Partial<AdminPolicyCreateRequest> = {}) {
  return {
    baseCurrency: "USD",
    maxBudgetMinor: "25000",
    rollingDailyLimitMinor: "100000",
    approvedMerchantDomains: ["example.com"],
    approvedVendorIds: ["vendor-1"],
    restrictedCategories: ["GAMBLING"],
    approvalMode: "DUAL_SIGNATURE_SLACK" as const,
    maxTransactionsPerMinute: 10,
    crossMerchantWindowSecs: 60,
    maxDistinctMerchants: 5,
    ...overrides,
  };
}

function buildService(pool: Pool) {
  const auditKeys = generateKeyPairSync("ed25519");
  const privateKey = auditKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKey = auditKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const sql = new PgSqlAdapter(pool);
  const provider = new StaticAuditKeyProvider(
    { keyId: "policy-management-audit-k1", privateKey },
    new Map([["policy-management-audit-k1", publicKey]]),
  );
  const audit = new PostgresAdminChangeAuditLedger(sql, provider);
  return {
    service: new PostgresAdminPolicyManagementService(sql, audit),
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

async function createOrganization(pool: Pool, organizationId: string): Promise<void> {
  await pool.query(
    `insert into "Organization" ("id", "name", "createdAt", "updatedAt")
     values ($1::uuid, $2, now(), now())`,
    [organizationId, `Policy management ${organizationId}`],
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
  await pool.query(`delete from "Policy" where "organizationId" = $1::uuid`, [organizationId]);
  await pool.query(`delete from "Organization" where "id" = $1::uuid`, [organizationId]);
}
