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
import { PostgresAdminHighRiskGovernanceService } from "../../src/modules/admin/admin-high-risk-governance.js";
import { MandateTokenService } from "../../src/modules/mandates/mandate-token.service.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";
const NOW = new Date("2026-08-20T13:00:00.000Z");

integration("durable high-risk administrative governance", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("requires a distinct current principal and explicit revalidated apply for policy activation and mandate issuance", async () => {
    const fixture = await createFixture(pool);
    const { service, verifier, mandateTokens } = buildService(pool);

    try {
      const policyProposal = await service.proposePolicyActivation(
        fixture.proposer,
        fixture.inactivePolicyId,
        "activate-policy-v1",
      );
      expect(policyProposal.outcome).toBe("PENDING_GOVERNANCE");
      if (policyProposal.outcome !== "PENDING_GOVERNANCE") throw new Error("expected policy proposal");
      expect(await policyActive(pool, fixture.inactivePolicyId)).toBe(false);

      expect(
        (
          await service.vote(fixture.proposer, policyProposal.governanceRequest.id, {
            decision: "APPROVE",
          })
        ).outcome,
      ).toBe("CONFLICT");
      expect(await policyActive(pool, fixture.inactivePolicyId)).toBe(false);

      const policyApproval = await service.vote(
        fixture.approver,
        policyProposal.governanceRequest.id,
        { decision: "APPROVE", comment: "Approved exact policy activation" },
      );
      expect(policyApproval.outcome).toBe("UPDATED");
      if (policyApproval.outcome !== "UPDATED") throw new Error("expected policy approval");
      expect(policyApproval.governanceRequest.status).toBe("APPROVED");
      expect(policyApproval.governanceRequest.approveCount).toBe(1);
      expect(await policyActive(pool, fixture.inactivePolicyId)).toBe(false);

      const policyApply = await service.apply(
        fixture.proposer,
        policyProposal.governanceRequest.id,
      );
      expect(policyApply.outcome).toBe("APPLIED");
      if (policyApply.outcome !== "APPLIED" || policyApply.action !== "POLICY_ACTIVATE") {
        throw new Error("expected governed policy activation");
      }
      expect(policyApply.policy.active).toBe(true);
      expect(policyApply.governanceRequest.status).toBe("APPLIED");
      expect(await policyActive(pool, fixture.inactivePolicyId)).toBe(true);
      expect(
        (
          await service.apply(fixture.proposer, policyProposal.governanceRequest.id)
        ).outcome,
      ).toBe("REPLAYED");

      const mandateProposal = await service.proposeMandateIssue(fixture.proposer, {
        userId: fixture.userId,
        agentId: fixture.agentId,
        policyId: fixture.activePolicyId,
        expiresAt: "2026-09-20T13:00:00.000Z",
        idempotencyKey: "governed-mandate-1",
      });
      expect(mandateProposal.outcome).toBe("PENDING_GOVERNANCE");
      if (mandateProposal.outcome !== "PENDING_GOVERNANCE") throw new Error("expected mandate proposal");
      expect(await mandateCount(pool, fixture.organizationId)).toBe("0");
      expect(JSON.stringify(mandateProposal.governanceRequest)).not.toContain("governed-mandate-1");

      const mandateApproval = await service.vote(
        fixture.approver,
        mandateProposal.governanceRequest.id,
        { decision: "APPROVE" },
      );
      expect(mandateApproval.outcome).toBe("UPDATED");
      expect(await mandateCount(pool, fixture.organizationId)).toBe("0");

      const mandateApply = await service.apply(
        fixture.proposer,
        mandateProposal.governanceRequest.id,
      );
      expect(mandateApply.outcome).toBe("APPLIED");
      if (mandateApply.outcome !== "APPLIED" || mandateApply.action !== "MANDATE_ISSUE") {
        throw new Error("expected governed mandate issuance");
      }
      expect(mandateApply.mandate.status).toBe("ACTIVE");
      expect(mandateApply.mandateToken.split(".")).toHaveLength(3);
      expect(await mandateCount(pool, fixture.organizationId)).toBe("1");

      const verified = await mandateTokens.verify(mandateApply.mandateToken, NOW);
      expect(verified.claims).toMatchObject({
        mandateId: mandateApply.mandate.id,
        organizationId: fixture.organizationId,
        userId: fixture.userId,
        agentId: fixture.agentId,
        policyVersion: 1,
      });

      const storedRequest = await pool.query<{ executionPayload: unknown; proposalPayload: unknown }>(
        `select "executionPayload", "proposalPayload"
           from "AdminGovernanceRequest" where "id" = $1::uuid`,
        [mandateProposal.governanceRequest.id],
      );
      expect(JSON.stringify(storedRequest.rows[0]?.executionPayload)).toContain("governed-mandate-1");
      expect(JSON.stringify(storedRequest.rows[0]?.proposalPayload)).not.toContain("governed-mandate-1");
      expect(JSON.stringify(storedRequest.rows[0])).not.toContain(mandateApply.mandateToken);

      expect(
        (
          await service.apply(fixture.proposer, mandateProposal.governanceRequest.id)
        ).outcome,
      ).toBe("REPLAYED");
      expect(await mandateCount(pool, fixture.organizationId)).toBe("1");

      const auditRows = await pool.query<{ action: string; permission: string; metadata: unknown }>(
        `select "action", "permission", "metadata"
           from "AdminAuditLog"
          where "organizationId" = $1::uuid
          order by "chainSequence" asc`,
        [fixture.organizationId],
      );
      expect(auditRows.rows.map((row) => row.action)).toEqual([
        "governance.propose",
        "governance.approve",
        "policy.activate",
        "governance.apply",
        "governance.propose",
        "governance.approve",
        "mandate.issue",
        "governance.apply",
      ]);
      expect(auditRows.rows[2]).toMatchObject({ permission: "policy.activate" });
      expect(auditRows.rows[6]).toMatchObject({ permission: "mandate.issue" });
      expect(JSON.stringify(auditRows.rows)).not.toContain(mandateApply.mandateToken);
      expect(JSON.stringify(auditRows.rows)).not.toContain("governed-mandate-1");
      expect(await verifier.verifyOrganization(fixture.organizationId)).toMatchObject({
        valid: true,
        checkedEvents: 8,
      });
    } finally {
      await cleanupFixture(pool, fixture.organizationId);
    }
  });

  it("fails closed as stale when target state or governing authority changes after approval", async () => {
    const targetFixture = await createFixture(pool);
    const authorityFixture = await createFixture(pool);
    const targetService = buildService(pool).service;
    const authorityService = buildService(pool).service;

    try {
      const targetProposal = await targetService.proposePolicyActivation(
        targetFixture.proposer,
        targetFixture.inactivePolicyId,
        "stale-target-policy",
      );
      if (targetProposal.outcome !== "PENDING_GOVERNANCE") throw new Error("expected target proposal");
      expect(
        (
          await targetService.vote(targetFixture.approver, targetProposal.governanceRequest.id, {
            decision: "APPROVE",
          })
        ).outcome,
      ).toBe("UPDATED");
      await pool.query(
        `update "Policy" set "maxBudgetMinor" = "maxBudgetMinor" + 1, "updatedAt" = now()
          where "id" = $1::uuid`,
        [targetFixture.inactivePolicyId],
      );
      const targetApply = await targetService.apply(
        targetFixture.proposer,
        targetProposal.governanceRequest.id,
      );
      expect(targetApply.outcome).toBe("STALE");
      expect(await policyActive(pool, targetFixture.inactivePolicyId)).toBe(false);

      const authorityProposal = await authorityService.proposePolicyActivation(
        authorityFixture.proposer,
        authorityFixture.inactivePolicyId,
        "stale-authority-policy",
      );
      if (authorityProposal.outcome !== "PENDING_GOVERNANCE") throw new Error("expected authority proposal");
      expect(
        (
          await authorityService.vote(authorityFixture.approver, authorityProposal.governanceRequest.id, {
            decision: "APPROVE",
          })
        ).outcome,
      ).toBe("UPDATED");
      await pool.query(
        `update "AdminOrganizationMembership" set "status" = 'SUSPENDED'
          where "id" = $1::uuid`,
        [authorityFixture.approver.membershipId],
      );
      const authorityApply = await authorityService.apply(
        authorityFixture.proposer,
        authorityProposal.governanceRequest.id,
      );
      expect(authorityApply.outcome).toBe("STALE");
      expect(await policyActive(pool, authorityFixture.inactivePolicyId)).toBe(false);
    } finally {
      await cleanupFixture(pool, targetFixture.organizationId);
      await cleanupFixture(pool, authorityFixture.organizationId);
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
  const auditKeys = new StaticAuditKeyProvider(
    { keyId: "admin-governance-audit-k1", privateKey: auditPrivate },
    new Map([["admin-governance-audit-k1", auditPublic]]),
  );
  const audit = new PostgresAdminChangeAuditLedger(sql, auditKeys);
  const mandateTokens = new MandateTokenService(
    new StaticMandateVerificationKeyResolver(new Map([["mandate-governance-k1", mandatePublic]])),
    { issuer: "https://mino.example" },
  );
  return {
    service: new PostgresAdminHighRiskGovernanceService(
      sql,
      audit,
      {
        tokens: mandateTokens,
        signingKey: { keyId: "mandate-governance-k1", privateKey: mandatePrivate },
        issuer: "https://mino.example",
      },
      randomUUID,
      () => NOW,
    ),
    mandateTokens,
    verifier: new PostgresAdminChangeAuditVerifier(sql, auditKeys),
  };
}

async function createFixture(pool: Pool) {
  const organizationId = randomUUID();
  const userId = randomUUID();
  const agentId = randomUUID();
  const activePolicyId = randomUUID();
  const inactivePolicyId = randomUUID();
  const proposer = {
    principalId: randomUUID(),
    membershipId: randomUUID(),
    organizationId,
    roles: ["FINANCE_MANAGER" as const],
  };
  const approver = {
    principalId: randomUUID(),
    membershipId: randomUUID(),
    organizationId,
    roles: ["FINANCE_MANAGER" as const],
  };
  const agentKeys = generateKeyPairSync("ed25519");
  const agentPublic = agentKeys.publicKey.export({ type: "spki", format: "pem" }).toString();

  await pool.query(
    `insert into "Organization" ("id", "name", "createdAt", "updatedAt")
     values ($1::uuid, $2, $3, $3)`,
    [organizationId, `Governance fixture ${organizationId}`, NOW],
  );
  await pool.query(
    `insert into "User" ("id", "organizationId", "email", "status", "createdAt", "updatedAt")
     values ($1::uuid, $2::uuid, $3, 'ACTIVE', $4, $4)`,
    [userId, organizationId, `${userId}@example.test`, NOW],
  );
  await pool.query(
    `insert into "AgentIdentity" (
       "id", "organizationId", "externalAgentId", "status", "publicKey", "keyId", "createdAt", "updatedAt"
     ) values ($1::uuid, $2::uuid, $3, 'ACTIVE', $4, 'agent-governance-k1', $5, $5)`,
    [agentId, organizationId, `agent-${agentId}`, agentPublic, NOW],
  );
  for (const [policyId, name, active] of [
    [activePolicyId, "Mandate policy", true],
    [inactivePolicyId, "Activation policy", false],
  ] as const) {
    await pool.query(
      `insert into "Policy" (
         "id", "organizationId", "name", "version", "active", "baseCurrency",
         "maxBudgetMinor", "rollingDailyLimitMinor", "approvedMerchantDomains",
         "approvedVendorIds", "restrictedCategories", "approvalMode",
         "maxTransactionsPerMinute", "crossMerchantWindowSecs", "maxDistinctMerchants",
         "createdAt", "updatedAt"
       ) values (
         $1::uuid, $2::uuid, $3, 1, $4, 'USD',
         25000, 100000, ARRAY['shop.example.com'], ARRAY['vendor-1'], ARRAY['GAMBLING'],
         'DUAL_SIGNATURE_SLACK', 10, 60, 5, $5, $5
       )`,
      [policyId, organizationId, name, active, NOW],
    );
  }

  for (const actor of [proposer, approver]) {
    await pool.query(
      `insert into "AdminPrincipal" (
         "id", "issuer", "subject", "status", "createdAt", "updatedAt"
       ) values ($1::uuid, 'https://id.example', $2, 'ACTIVE', $3, $3)`,
      [actor.principalId, `admin-${actor.principalId}`, NOW],
    );
    await pool.query(
      `insert into "AdminOrganizationMembership" (
         "id", "organizationId", "principalId", "status", "createdAt", "updatedAt"
       ) values ($1::uuid, $2::uuid, $3::uuid, 'ACTIVE', $4, $4)`,
      [actor.membershipId, organizationId, actor.principalId, NOW],
    );
    await pool.query(
      `insert into "AdminRoleAssignment" ("id", "membershipId", "role", "assignedAt")
       values ($1::uuid, $2::uuid, 'FINANCE_MANAGER', $3)`,
      [randomUUID(), actor.membershipId, NOW],
    );
  }

  return {
    organizationId,
    userId,
    agentId,
    activePolicyId,
    inactivePolicyId,
    proposer,
    approver,
  };
}

async function policyActive(pool: Pool, policyId: string): Promise<boolean | undefined> {
  return (
    await pool.query<{ active: boolean }>(
      `select "active" from "Policy" where "id" = $1::uuid`,
      [policyId],
    )
  ).rows[0]?.active;
}

async function mandateCount(pool: Pool, organizationId: string): Promise<string | undefined> {
  return (
    await pool.query<{ count: string }>(
      `select count(*)::text as count from "AgentMandate" where "organizationId" = $1::uuid`,
      [organizationId],
    )
  ).rows[0]?.count;
}

async function cleanupFixture(pool: Pool, organizationId: string): Promise<void> {
  await pool.query(
    `delete from "AdminGovernanceRequest" where "organizationId" = $1::uuid`,
    [organizationId],
  );
  await pool.query(`delete from "AdminAuditLog" where "organizationId" = $1::uuid`, [organizationId]);
  await pool.query(`delete from "AdminAuditChainHead" where "organizationId" = $1::uuid`, [organizationId]);
  await pool.query(
    `delete from "AdminRoleAssignment" where "membershipId" in (
       select "id" from "AdminOrganizationMembership" where "organizationId" = $1::uuid
     )`,
    [organizationId],
  );
  const principals = await pool.query<{ principalId: string }>(
    `select "principalId" from "AdminOrganizationMembership" where "organizationId" = $1::uuid`,
    [organizationId],
  );
  await pool.query(`delete from "AdminOrganizationMembership" where "organizationId" = $1::uuid`, [organizationId]);
  for (const row of principals.rows) {
    await pool.query(`delete from "AdminPrincipal" where "id" = $1::uuid`, [row.principalId]);
  }
  await pool.query(`delete from "AgentMandate" where "organizationId" = $1::uuid`, [organizationId]);
  await pool.query(`delete from "Policy" where "organizationId" = $1::uuid`, [organizationId]);
  await pool.query(`delete from "AgentIdentity" where "organizationId" = $1::uuid`, [organizationId]);
  await pool.query(`delete from "User" where "organizationId" = $1::uuid`, [organizationId]);
  await pool.query(`delete from "Organization" where "id" = $1::uuid`, [organizationId]);
}
