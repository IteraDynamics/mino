import { generateKeyPairSync, randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../../src/generated/prisma/client.js";
import { StaticAuditKeyProvider } from "../../src/infrastructure/crypto/static-key-providers.js";
import { PgSqlAdapter } from "../../src/infrastructure/postgres/pg-sql-adapter.js";
import { PrismaAgentVerificationKeyResolver } from "../../src/infrastructure/prisma/control-plane.repositories.js";
import { PostgresAdminAgentLifecycleService } from "../../src/modules/admin/admin-agent-lifecycle.js";
import {
  PostgresAdminChangeAuditLedger,
  PostgresAdminChangeAuditVerifier,
} from "../../src/modules/admin/admin-change-audit-ledger.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";

integration("administrative agent lifecycle", () => {
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

  it("suspends immediately, reactivates explicitly, and rotates the only accepted agent key", async () => {
    const organizationId = randomUUID();
    const agentId = randomUUID();
    const originalKeys = generateKeyPairSync("ed25519");
    const rotatedKeys = generateKeyPairSync("ed25519");
    const originalPublicKey = pemPublic(originalKeys.publicKey);
    const rotatedPublicKey = pemPublic(rotatedKeys.publicKey);
    await pool.query(
      `insert into "Organization" ("id", "name", "createdAt", "updatedAt")
       values ($1::uuid, $2, now(), now())`,
      [organizationId, `Agent lifecycle ${organizationId}`],
    );
    await pool.query(
      `insert into "AgentIdentity"
        ("id", "organizationId", "externalAgentId", "displayName", "status", "publicKey", "keyId", "createdAt", "updatedAt")
       values ($1::uuid, $2::uuid, 'lifecycle-agent', 'Lifecycle Agent', 'ACTIVE', $3, 'agent-k1', now(), now())`,
      [agentId, organizationId, originalPublicKey],
    );

    const { service, verifier } = buildService(pool);
    const resolver = new PrismaAgentVerificationKeyResolver(prisma);
    const actor = actorFor(organizationId);

    try {
      const detail = await service.getAgent(organizationId, agentId);
      expect(detail).toMatchObject({
        id: agentId,
        organizationId,
        externalAgentId: "lifecycle-agent",
        displayName: "Lifecycle Agent",
        status: "ACTIVE",
        keyId: "agent-k1",
      });
      expect(JSON.stringify(detail)).not.toContain(originalPublicKey);
      expect(await resolver.resolveAgentPublicKey(agentId, "agent-k1")).toContain("BEGIN PUBLIC KEY");

      const suspended = await service.suspend(actor, agentId);
      expect(suspended.outcome).toBe("UPDATED");
      if (suspended.outcome !== "UPDATED") throw new Error("expected suspension");
      expect(suspended.agent.status).toBe("SUSPENDED");
      expect(await resolver.resolveAgentPublicKey(agentId, "agent-k1")).toBeUndefined();

      const suspendReplay = await service.suspend(actor, agentId);
      expect(suspendReplay.outcome).toBe("REPLAYED");
      expect(await auditCount(pool, organizationId)).toBe("1");

      const reactivated = await service.reactivate(actor, agentId);
      expect(reactivated.outcome).toBe("UPDATED");
      if (reactivated.outcome !== "UPDATED") throw new Error("expected reactivation");
      expect(reactivated.agent.status).toBe("ACTIVE");
      expect(await resolver.resolveAgentPublicKey(agentId, "agent-k1")).toBe(originalPublicKey);

      const rotated = await service.rotateKey(actor, agentId, {
        keyId: "agent-k2",
        publicKey: rotatedPublicKey,
      });
      expect(rotated.outcome).toBe("UPDATED");
      if (rotated.outcome !== "UPDATED") throw new Error("expected rotation");
      expect(rotated.agent.keyId).toBe("agent-k2");
      expect(await resolver.resolveAgentPublicKey(agentId, "agent-k1")).toBeUndefined();
      expect(await resolver.resolveAgentPublicKey(agentId, "agent-k2")).toBe(rotatedPublicKey);

      const rotationReplay = await service.rotateKey(actor, agentId, {
        keyId: "agent-k2",
        publicKey: rotatedPublicKey,
      });
      expect(rotationReplay.outcome).toBe("REPLAYED");
      expect(await auditCount(pool, organizationId)).toBe("3");

      const audit = await pool.query<{ permission: string; action: string }>(
        `select "permission", "action" from "AdminAuditLog"
          where "organizationId" = $1::uuid order by "chainSequence" asc`,
        [organizationId],
      );
      expect(audit.rows).toEqual([
        { permission: "agent.suspend", action: "agent.suspend" },
        { permission: "agent.reactivate", action: "agent.reactivate" },
        { permission: "agent.rotate_key", action: "agent.rotate_key" },
      ]);
      expect((await verifier.verifyOrganization(organizationId)).valid).toBe(true);
    } finally {
      await cleanupOrganization(pool, organizationId);
    }
  });

  it("treats REVOKED as terminal for suspend, reactivate, and key rotation", async () => {
    const organizationId = randomUUID();
    const agentId = randomUUID();
    const keys = generateKeyPairSync("ed25519");
    const replacement = generateKeyPairSync("ed25519");
    await pool.query(
      `insert into "Organization" ("id", "name", "createdAt", "updatedAt")
       values ($1::uuid, $2, now(), now())`,
      [organizationId, `Revoked agent ${organizationId}`],
    );
    await pool.query(
      `insert into "AgentIdentity"
        ("id", "organizationId", "externalAgentId", "status", "publicKey", "keyId", "createdAt", "updatedAt")
       values ($1::uuid, $2::uuid, 'revoked-agent', 'REVOKED', $3, 'agent-k1', now(), now())`,
      [agentId, organizationId, pemPublic(keys.publicKey)],
    );
    const { service } = buildService(pool);
    const actor = actorFor(organizationId);

    try {
      expect((await service.suspend(actor, agentId)).outcome).toBe("CONFLICT");
      expect((await service.reactivate(actor, agentId)).outcome).toBe("CONFLICT");
      expect(
        (
          await service.rotateKey(actor, agentId, {
            keyId: "agent-k2",
            publicKey: pemPublic(replacement.publicKey),
          })
        ).outcome,
      ).toBe("CONFLICT");
      expect(await auditCount(pool, organizationId)).toBe("0");
    } finally {
      await cleanupOrganization(pool, organizationId);
    }
  });
});

function buildService(pool: Pool) {
  const auditKeys = generateKeyPairSync("ed25519");
  const privateKey = auditKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKey = pemPublic(auditKeys.publicKey);
  const sql = new PgSqlAdapter(pool);
  const provider = new StaticAuditKeyProvider(
    { keyId: "agent-lifecycle-audit-k1", privateKey },
    new Map([["agent-lifecycle-audit-k1", publicKey]]),
  );
  const audit = new PostgresAdminChangeAuditLedger(sql, provider);
  return {
    service: new PostgresAdminAgentLifecycleService(sql, audit),
    verifier: new PostgresAdminChangeAuditVerifier(sql, provider),
  };
}

function actorFor(organizationId: string) {
  return {
    principalId: randomUUID(),
    membershipId: randomUUID(),
    organizationId,
    roles: ["AGENT_MANAGER" as const],
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
  await pool.query(`delete from "AgentIdentity" where "organizationId" = $1::uuid`, [organizationId]);
  await pool.query(`delete from "Organization" where "id" = $1::uuid`, [organizationId]);
}

function pemPublic(key: import("node:crypto").KeyObject): string {
  return key.export({ type: "spki", format: "pem" }).toString();
}
