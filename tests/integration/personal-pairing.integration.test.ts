import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PgSqlAdapter } from "../../src/infrastructure/postgres/pg-sql-adapter.js";
import { PostgresPersonalPairingService } from "../../src/modules/personal/personal-pairing.service.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";
const ISSUER = "https://personal.test";
const now = new Date("2026-08-24T15:30:00.000Z");

integration("Mino Personal bootstrap and pairing", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  beforeEach(async () => {
    await pool.query('delete from "PersonalPairingRequest"');
    const personalOrganizations = await pool.query<{ id: string }>(
      `select "id" from "Organization" where "kind" = 'PERSONAL'`,
    );
    const organizationIds = personalOrganizations.rows.map((row) => row.id);
    if (organizationIds.length > 0) {
      await pool.query('delete from "PaymentOutcome" where "organizationId" = any($1::uuid[])', [organizationIds]);
      await pool.query('delete from "SpendReservation" where "organizationId" = any($1::uuid[])', [organizationIds]);
      await pool.query('delete from "ApprovalRequest" where "organizationId" = any($1::uuid[])', [organizationIds]);
      await pool.query('delete from "AuditLog" where "organizationId" = any($1::uuid[])', [organizationIds]);
      await pool.query('delete from "AgentMandate" where "organizationId" = any($1::uuid[])', [organizationIds]);
      await pool.query('delete from "Policy" where "organizationId" = any($1::uuid[])', [organizationIds]);
      await pool.query('delete from "MerchantEndpoint" where "organizationId" = any($1::uuid[])', [organizationIds]);
      await pool.query('delete from "AgentIdentity" where "organizationId" = any($1::uuid[])', [organizationIds]);
      await pool.query('delete from "User" where "organizationId" = any($1::uuid[])', [organizationIds]);
    }
    await pool.query('delete from "PersonalOwner"');
    await pool.query(`delete from "Organization" where "kind" = 'PERSONAL'`);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("bootstraps one Personal owner, pairs an Ed25519 agent, and grants no economic authority", async () => {
    const service = new PostgresPersonalPairingService(new PgSqlAdapter(pool), undefined, () => now);
    const identity = { issuer: ISSUER, subject: "owner-1" };

    const createdOwner = await service.bootstrap(identity, {
      beneficiaryEmail: "Owner@Example.Test",
      displayName: "Owner One",
    });
    expect(createdOwner.outcome).toBe("CREATED");
    if (createdOwner.outcome !== "CREATED") throw new Error("owner bootstrap failed");
    expect(createdOwner.owner.email).toBe("owner@example.test");

    const replayedOwner = await service.bootstrap(identity, {
      beneficiaryEmail: "owner@example.test",
      displayName: "Owner One",
    });
    expect(replayedOwner.outcome).toBe("REPLAYED");

    const organization = await pool.query<{ kind: string }>(
      'select "kind"::text as "kind" from "Organization" where "id" = $1::uuid',
      [createdOwner.owner.organizationId],
    );
    expect(organization.rows[0]?.kind).toBe("PERSONAL");

    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const pairing = await service.createPairingRequest({
      externalAgentId: "openclaw-home",
      displayName: "OpenClaw",
      keyId: "openclaw-k1",
      publicKey,
    });
    expect(pairing.status).toBe("PENDING");
    expect(pairing.claimSecret.length).toBeGreaterThanOrEqual(32);

    const beforeClaim = await pool.query<{ count: string }>(
      'select count(*)::text as "count" from "AgentIdentity" where "organizationId" = $1::uuid',
      [createdOwner.owner.organizationId],
    );
    expect(beforeClaim.rows[0]?.count).toBe("0");

    const wrongSecret = await service.claimPairingRequest(identity, pairing.id, `${pairing.claimSecret}x`);
    expect(wrongSecret.outcome).toBe("INVALID_SECRET");

    const claimed = await service.claimPairingRequest(identity, pairing.id, pairing.claimSecret);
    expect(claimed.outcome).toBe("CLAIMED");
    if (claimed.outcome !== "CLAIMED") throw new Error("pairing claim failed");
    expect(claimed.pairing.agentId).toBeTruthy();

    const polled = await service.getPairingRequest(pairing.id);
    expect(polled).toMatchObject({
      id: pairing.id,
      status: "CLAIMED",
      agentId: claimed.pairing.agentId,
    });

    const replayedClaim = await service.claimPairingRequest(identity, pairing.id, pairing.claimSecret);
    expect(replayedClaim.outcome).toBe("REPLAYED");

    const authority = await pool.query<{ policies: string; mandates: string }>(
      `select
         (select count(*) from "Policy" where "organizationId" = $1::uuid)::text as "policies",
         (select count(*) from "AgentMandate" where "organizationId" = $1::uuid)::text as "mandates"`,
      [createdOwner.owner.organizationId],
    );
    expect(authority.rows[0]).toEqual({ policies: "0", mandates: "0" });
  });

  it("expires an unclaimed pairing and never creates an agent", async () => {
    let clock = new Date(now);
    const service = new PostgresPersonalPairingService(
      new PgSqlAdapter(pool),
      undefined,
      () => clock,
      60_000,
    );
    const identity = { issuer: ISSUER, subject: "owner-expiry" };
    const owner = await service.bootstrap(identity, { beneficiaryEmail: "expiry@example.test" });
    expect(owner.outcome).toBe("CREATED");
    if (owner.outcome !== "CREATED") throw new Error("owner bootstrap failed");

    const keys = generateKeyPairSync("ed25519");
    const pairing = await service.createPairingRequest({
      externalAgentId: "openclaw-expired",
      keyId: "openclaw-k-expired",
      publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    });

    clock = new Date(now.getTime() + 60_001);
    const result = await service.claimPairingRequest(identity, pairing.id, pairing.claimSecret);
    expect(result.outcome).toBe("EXPIRED");
    expect((await service.getPairingRequest(pairing.id))?.status).toBe("EXPIRED");

    const agents = await pool.query<{ count: string }>(
      'select count(*)::text as "count" from "AgentIdentity" where "organizationId" = $1::uuid',
      [owner.owner.organizationId],
    );
    expect(agents.rows[0]?.count).toBe("0");
  });
});
