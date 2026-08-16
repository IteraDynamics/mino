import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PgSqlAdapter } from "../../src/infrastructure/postgres/pg-sql-adapter.js";
import { StaticAuditKeyProvider } from "../../src/infrastructure/crypto/static-key-providers.js";
import {
  PostgresAdminChangeAuditLedger,
  PostgresAdminChangeAuditVerifier,
} from "../../src/modules/admin/admin-change-audit-ledger.js";
import { PostgresAdminAgentEnrollmentService } from "../../src/modules/admin/admin-agent-enrollment.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";

integration("administrative agent enrollment", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("commits agent creation and signed audit atomically, then replays without a second audit event", async () => {
    const organizationId = randomUUID();
    await seedOrganization(pool, organizationId);
    const { service, verifier } = buildService(pool);
    const request = enrollmentRequest("agent-one");
    const actor = actorFor(organizationId);

    const created = await service.enroll(actor, request);
    expect(created.outcome).toBe("CREATED");
    if (created.outcome !== "CREATED") throw new Error("expected create");

    const agentCount = await pool.query<{ count: string }>(
      `select count(*)::text as count from "AgentIdentity" where "organizationId" = $1::uuid`,
      [organizationId],
    );
    const auditCount = await pool.query<{ count: string }>(
      `select count(*)::text as count from "AdminAuditLog" where "organizationId" = $1::uuid`,
      [organizationId],
    );
    expect(agentCount.rows[0]?.count).toBe("1");
    expect(auditCount.rows[0]?.count).toBe("1");
    expect((await verifier.verifyOrganization(organizationId)).valid).toBe(true);

    const replayed = await service.enroll(actor, request);
    expect(replayed.outcome).toBe("REPLAYED");
    if (replayed.outcome !== "REPLAYED") throw new Error("expected replay");
    expect(replayed.agent.id).toBe(created.agent.id);

    const auditAfterReplay = await pool.query<{ count: string }>(
      `select count(*)::text as count from "AdminAuditLog" where "organizationId" = $1::uuid`,
      [organizationId],
    );
    expect(auditAfterReplay.rows[0]?.count).toBe("1");

    await cleanupOrganization(pool, organizationId);
  });

  it("rejects conflicting reuse of an external agent id without changing state", async () => {
    const organizationId = randomUUID();
    await seedOrganization(pool, organizationId);
    const { service } = buildService(pool);
    const actor = actorFor(organizationId);
    const first = enrollmentRequest("agent-conflict");
    const second = enrollmentRequest("agent-conflict");

    expect((await service.enroll(actor, first)).outcome).toBe("CREATED");
    expect((await service.enroll(actor, second)).outcome).toBe("CONFLICT");

    const counts = await pool.query<{ agents: string; audits: string }>(
      `select
         (select count(*) from "AgentIdentity" where "organizationId" = $1::uuid)::text as agents,
         (select count(*) from "AdminAuditLog" where "organizationId" = $1::uuid)::text as audits`,
      [organizationId],
    );
    expect(counts.rows[0]).toEqual({ agents: "1", audits: "1" });
    await cleanupOrganization(pool, organizationId);
  });

  it("serializes concurrent identical enrollment into one creation and one replay", async () => {
    const organizationId = randomUUID();
    await seedOrganization(pool, organizationId);
    const { service } = buildService(pool);
    const actor = actorFor(organizationId);
    const request = enrollmentRequest("agent-concurrent", true);

    const results = await Promise.all([
      service.enroll(actor, request),
      service.enroll(actor, request),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual(["CREATED", "REPLAYED"]);

    const counts = await pool.query<{ agents: string; audits: string }>(
      `select
         (select count(*) from "AgentIdentity" where "organizationId" = $1::uuid)::text as agents,
         (select count(*) from "AdminAuditLog" where "organizationId" = $1::uuid)::text as audits`,
      [organizationId],
    );
    expect(counts.rows[0]).toEqual({ agents: "1", audits: "1" });
    await cleanupOrganization(pool, organizationId);
  });
});

function buildService(pool: Pool) {
  const keys = generateKeyPairSync("ed25519");
  const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const sql = new PgSqlAdapter(pool);
  const keyProvider = new StaticAuditKeyProvider(
    { keyId: "admin-enrollment-audit-k1", privateKey },
    new Map([["admin-enrollment-audit-k1", publicKey]]),
  );
  const audit = new PostgresAdminChangeAuditLedger(sql, keyProvider);
  return {
    service: new PostgresAdminAgentEnrollmentService(sql, audit),
    verifier: new PostgresAdminChangeAuditVerifier(sql, keyProvider),
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

function enrollmentRequest(externalAgentId: string, stable = false) {
  const keys = stable ? stableEnrollmentKeyPair : generateKeyPairSync("ed25519");
  return {
    externalAgentId,
    displayName: "Procurement Agent",
    keyId: "agent-key-1",
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

const stableEnrollmentKeyPair = generateKeyPairSync("ed25519");

async function seedOrganization(pool: Pool, organizationId: string): Promise<void> {
  await pool.query(
    `insert into "Organization" ("id", "name", "createdAt", "updatedAt")
     values ($1::uuid, $2, now(), now())`,
    [organizationId, `Admin Enrollment ${organizationId}`],
  );
}

async function cleanupOrganization(pool: Pool, organizationId: string): Promise<void> {
  await pool.query(`delete from "AdminAuditLog" where "organizationId" = $1::uuid`, [organizationId]);
  await pool.query(`delete from "AdminAuditChainHead" where "organizationId" = $1::uuid`, [organizationId]);
  await pool.query(`delete from "AgentIdentity" where "organizationId" = $1::uuid`, [organizationId]);
  await pool.query(`delete from "Organization" where "id" = $1::uuid`, [organizationId]);
}
