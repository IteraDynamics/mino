import { generateKeyPairSync, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  StaticAuditKeyProvider,
  StaticMandateVerificationKeyResolver,
} from "../../src/infrastructure/crypto/static-key-providers.js";
import { PgSqlAdapter } from "../../src/infrastructure/postgres/pg-sql-adapter.js";
import {
  PostgresAdminChangeAuditLedger,
  PostgresAdminChangeAuditVerifier,
} from "../../src/modules/admin/admin-change-audit-ledger.js";
import {
  AdminMandateValidationError,
  PostgresAdminMandateManagementService,
} from "../../src/modules/admin/admin-mandate-management.js";
import { MandateTokenService } from "../../src/modules/mandates/mandate-token.service.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";
const now = new Date("2026-08-16T16:00:00.000Z");

integration("administrative mandate issuance and revocation", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("issues an exact policy snapshot, replays safely, and revokes authoritatively", async () => {
    const fixture = await createFixture(pool);
    const { service, verifier, mandateTokens } = buildService(pool);
    const actor = actorFor(fixture.organizationId);
    const request = {
      userId: fixture.userId,
      agentId: fixture.agentId,
      policyId: fixture.policyId,
      expiresAt: "2026-09-16T16:00:00.000Z",
      idempotencyKey: "grant-procurement-2026-08-16",
    };

    try {
      const created = await service.issue(actor, request);
      expect(created.outcome).toBe("CREATED");
      if (created.outcome !== "CREATED") throw new Error("expected mandate creation");
      expect(created.mandate).toMatchObject({
        organizationId: fixture.organizationId,
        userId: fixture.userId,
        agentId: fixture.agentId,
        policyId: fixture.policyId,
        policyVersion: 3,
        currency: "USD",
        maxBudgetMinor: "25000",
        rollingDailyLimitMinor: "100000",
        approvedMerchantDomains: ["shop.example.com"],
        approvedVendorIds: ["vendor-1"],
        restrictedCategories: ["GAMBLING"],
        approvalMode: "DUAL_SIGNATURE_SLACK",
        maxTransactionsPerMinute: 10,
        crossMerchantWindowSecs: 60,
        maxDistinctMerchants: 5,
        status: "ACTIVE",
        signingKeyId: "mandate-k1",
      });
      expect(created.mandateToken.split(".")).toHaveLength(3);

      const verified = await mandateTokens.verify(created.mandateToken, now);
      expect(verified.claims).toMatchObject({
        mandateId: created.mandate.id,
        organizationId: fixture.organizationId,
        userId: fixture.userId,
        agentId: fixture.agentId,
        policyVersion: 3,
      });
      expect(verified.tokenJtiHash).toBe(created.mandate.tokenJtiHash);

      const persisted = await pool.query<{
        issuanceKeyHash: string | null;
        tokenJtiHash: string;
        delegationPayloadHash: string;
      }>(
        `select "issuanceKeyHash", "tokenJtiHash", "delegationPayloadHash"
           from "AgentMandate" where "id" = $1::uuid`,
        [created.mandate.id],
      );
      expect(persisted.rows[0]?.issuanceKeyHash).toBeTruthy();
      expect(persisted.rows[0]?.tokenJtiHash).toBe(created.mandate.tokenJtiHash);
      expect(persisted.rows[0]?.delegationPayloadHash).toBeTruthy();
      expect(JSON.stringify(persisted.rows)).not.toContain(request.idempotencyKey);
      expect(JSON.stringify(persisted.rows)).not.toContain(created.mandateToken);

      const replay = await service.issue(actor, request);
      expect(replay.outcome).toBe("REPLAYED");
      if (replay.outcome !== "REPLAYED") throw new Error("expected issuance replay");
      expect(replay.mandate.id).toBe(created.mandate.id);
      expect(await mandateCount(pool, fixture.organizationId)).toBe("1");
      expect(await auditCount(pool, fixture.organizationId)).toBe("1");

      expect(
        (
          await service.issue(actor, {
            ...request,
            expiresAt: "2026-10-16T16:00:00.000Z",
          })
        ).outcome,
      ).toBe("CONFLICT");
      expect(await mandateCount(pool, fixture.organizationId)).toBe("1");

      const revoked = await service.revoke(actor, created.mandate.id);
      expect(revoked.outcome).toBe("UPDATED");
      if (revoked.outcome !== "UPDATED") throw new Error("expected revocation");
      expect(revoked.mandate.status).toBe("REVOKED");
      expect(revoked.mandate.revokedAt).toBe(now.toISOString());
      expect((await service.revoke(actor, created.mandate.id)).outcome).toBe("REPLAYED");
      expect(await auditCount(pool, fixture.organizationId)).toBe("2");

      const replacement = await service.issue(actor, {
        ...request,
        idempotencyKey: "replacement-grant-after-revocation",
      });
      expect(replacement.outcome).toBe("CREATED");
      if (replacement.outcome !== "CREATED") throw new Error("expected replacement mandate");
      expect(replacement.mandate.id).not.toBe(created.mandate.id);
      expect(await mandateCount(pool, fixture.organizationId)).toBe("2");

      const audits = await pool.query<{ permission: string; action: string; state: string }>(
        `select "permission", "action",
                concat(coalesce("beforeState"::text, ''), coalesce("afterState"::text, ''), coalesce("metadata"::text, '')) as state
           from "AdminAuditLog"
          where "organizationId" = $1::uuid
          order by "chainSequence" asc`,
        [fixture.organizationId],
      );
      expect(audits.rows.map(({ permission, action }) => ({ permission, action }))).toEqual([
        { permission: "mandate.issue", action: "mandate.issue" },
        { permission: "mandate.revoke", action: "mandate.revoke" },
        { permission: "mandate.issue", action: "mandate.issue" },
      ]);
      expect(audits.rows.map((row) => row.state).join(" ")).not.toContain(created.mandateToken);
      expect(audits.rows.map((row) => row.state).join(" ")).not.toContain(request.idempotencyKey);
      expect(await verifier.verifyOrganization(fixture.organizationId)).toMatchObject({
        valid: true,
        checkedEvents: 3,
      });
    } finally {
      await cleanupFixture(pool, fixture.organizationId);
    }
  });

  it("serializes equivalent concurrent issuance into one mandate and one audit event", async () => {
    const fixture = await createFixture(pool);
    const { service } = buildService(pool);
    const actor = actorFor(fixture.organizationId);
    const request = {
      userId: fixture.userId,
      agentId: fixture.agentId,
      policyId: fixture.policyId,
      expiresAt: "2026-09-16T16:00:00.000Z",
      idempotencyKey: "concurrent-grant",
    };

    try {
      const results = await Promise.all([service.issue(actor, request), service.issue(actor, request)]);
      expect(results.map((result) => result.outcome).sort()).toEqual(["CREATED", "REPLAYED"]);
      expect(await mandateCount(pool, fixture.organizationId)).toBe("1");
      expect(await auditCount(pool, fixture.organizationId)).toBe("1");
    } finally {
      await cleanupFixture(pool, fixture.organizationId);
    }
  });

  it("fails closed for inactive or cross-organization authority targets", async () => {
    const fixture = await createFixture(pool);
    const other = await createFixture(pool);
    const { service } = buildService(pool);
    const actor = actorFor(fixture.organizationId);

    try {
      const base = {
        userId: fixture.userId,
        agentId: fixture.agentId,
        policyId: fixture.policyId,
        expiresAt: "2026-09-16T16:00:00.000Z",
      };

      await pool.query(`update "User" set "status" = 'SUSPENDED' where "id" = $1::uuid`, [fixture.userId]);
      expect((await service.issue(actor, { ...base, idempotencyKey: "bad-user" })).outcome).toBe("INVALID_TARGET");
      await pool.query(`update "User" set "status" = 'ACTIVE' where "id" = $1::uuid`, [fixture.userId]);

      await pool.query(`update "AgentIdentity" set "status" = 'SUSPENDED' where "id" = $1::uuid`, [fixture.agentId]);
      expect((await service.issue(actor, { ...base, idempotencyKey: "bad-agent" })).outcome).toBe("INVALID_TARGET");
      await pool.query(`update "AgentIdentity" set "status" = 'ACTIVE' where "id" = $1::uuid`, [fixture.agentId]);

      await pool.query(`update "Policy" set "active" = false where "id" = $1::uuid`, [fixture.policyId]);
      expect((await service.issue(actor, { ...base, idempotencyKey: "bad-policy" })).outcome).toBe("INVALID_TARGET");
      await pool.query(`update "Policy" set "active" = true where "id" = $1::uuid`, [fixture.policyId]);

      expect(
        (
          await service.issue(actor, {
            ...base,
            userId: other.userId,
            idempotencyKey: "cross-org-user",
          })
        ).outcome,
      ).toBe("INVALID_TARGET");

      await expect(
        service.issue(actor, {
          ...base,
          expiresAt: "2026-08-16T15:59:59.000Z",
          idempotencyKey: "expired-request",
        }),
      ).rejects.toBeInstanceOf(AdminMandateValidationError);

      expect(await mandateCount(pool, fixture.organizationId)).toBe("0");
      expect(await auditCount(pool, fixture.organizationId)).toBe("0");
    } finally {
      await cleanupFixture(pool, fixture.organizationId);
      await cleanupFixture(pool, other.organizationId);
    }
  });
});

function buildService(pool: Pool) {
  const auditPair = generateKeyPairSync("ed25519");
  const auditPrivate = auditPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const auditPublic = auditPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const mandatePair = generateKeyPairSync("ed25519");
  const mandatePrivate = mandatePair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const mandatePublic = mandatePair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const sql = new PgSqlAdapter(pool);
  const auditProvider = new StaticAuditKeyProvider(
    { keyId: "mandate-management-audit-k1", privateKey: auditPrivate },
    new Map([["mandate-management-audit-k1", auditPublic]]),
  );
  const audit = new PostgresAdminChangeAuditLedger(sql, auditProvider);
  const mandateTokens = new MandateTokenService(
    new StaticMandateVerificationKeyResolver(new Map([["mandate-k1", mandatePublic]])),
    { issuer: "https://mino.example" },
  );
  return {
    service: new PostgresAdminMandateManagementService(
      sql,
      audit,
      mandateTokens,
      { keyId: "mandate-k1", privateKey: mandatePrivate },
      "https://mino.example",
      randomUUID,
      () => now,
    ),
    mandateTokens,
    verifier: new PostgresAdminChangeAuditVerifier(sql, auditProvider),
  };
}

async function createFixture(pool: Pool) {
  const organizationId = randomUUID();
  const userId = randomUUID();
  const agentId = randomUUID();
  const policyId = randomUUID();
  const agentKeys = generateKeyPairSync("ed25519");
  const agentPublic = agentKeys.publicKey.export({ type: "spki", format: "pem" }).toString();

  await pool.query(
    `insert into "Organization" ("id", "name", "createdAt", "updatedAt") values ($1::uuid, $2, now(), now())`,
    [organizationId, `Mandate fixture ${organizationId}`],
  );
  await pool.query(
    `insert into "User" ("id", "organizationId", "email", "status", "createdAt", "updatedAt")
     values ($1::uuid, $2::uuid, $3, 'ACTIVE', now(), now())`,
    [userId, organizationId, `${userId}@example.test`],
  );
  await pool.query(
    `insert into "AgentIdentity" (
       "id", "organizationId", "externalAgentId", "status", "publicKey", "keyId", "createdAt", "updatedAt"
     ) values ($1::uuid, $2::uuid, $3, 'ACTIVE', $4, 'agent-k1', now(), now())`,
    [agentId, organizationId, `agent-${agentId}`, agentPublic],
  );
  await pool.query(
    `insert into "Policy" (
       "id", "organizationId", "name", "version", "active", "baseCurrency",
       "maxBudgetMinor", "rollingDailyLimitMinor", "approvedMerchantDomains",
       "approvedVendorIds", "restrictedCategories", "approvalMode",
       "maxTransactionsPerMinute", "crossMerchantWindowSecs", "maxDistinctMerchants",
       "createdAt", "updatedAt"
     ) values (
       $1::uuid, $2::uuid, 'Procurement', 3, true, 'USD',
       25000, 100000, ARRAY['shop.example.com'], ARRAY['vendor-1'], ARRAY['GAMBLING'],
       'DUAL_SIGNATURE_SLACK', 10, 60, 5, now(), now()
     )`,
    [policyId, organizationId],
  );
  return { organizationId, userId, agentId, policyId };
}

function actorFor(organizationId: string) {
  return {
    principalId: randomUUID(),
    membershipId: randomUUID(),
    organizationId,
    roles: ["FINANCE_MANAGER" as const],
  };
}

async function mandateCount(pool: Pool, organizationId: string): Promise<string | undefined> {
  return (
    await pool.query<{ count: string }>(
      `select count(*)::text as count from "AgentMandate" where "organizationId" = $1::uuid`,
      [organizationId],
    )
  ).rows[0]?.count;
}

async function auditCount(pool: Pool, organizationId: string): Promise<string | undefined> {
  return (
    await pool.query<{ count: string }>(
      `select count(*)::text as count from "AdminAuditLog" where "organizationId" = $1::uuid`,
      [organizationId],
    )
  ).rows[0]?.count;
}

async function cleanupFixture(pool: Pool, organizationId: string): Promise<void> {
  await pool.query(`delete from "AdminAuditLog" where "organizationId" = $1::uuid`, [organizationId]);
  await pool.query(`delete from "AdminAuditChainHead" where "organizationId" = $1::uuid`, [organizationId]);
  await pool.query(`delete from "AgentMandate" where "organizationId" = $1::uuid`, [organizationId]);
  await pool.query(`delete from "Policy" where "organizationId" = $1::uuid`, [organizationId]);
  await pool.query(`delete from "AgentIdentity" where "organizationId" = $1::uuid`, [organizationId]);
  await pool.query(`delete from "User" where "organizationId" = $1::uuid`, [organizationId]);
  await pool.query(`delete from "Organization" where "id" = $1::uuid`, [organizationId]);
}
