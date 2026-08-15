import { generateKeyPairSync, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StaticAuditKeyProvider } from "../../src/infrastructure/crypto/static-key-providers.js";
import { PgSqlAdapter } from "../../src/infrastructure/postgres/pg-sql-adapter.js";
import {
  AdminAuditCheckpointRetentionWorker,
  AdminAuditCheckpointVerificationFailure,
  PostgresAdminAuditCheckpointIssuer,
  PostgresRetainedAdminAuditVerifier,
  adminRetentionEvent,
  type AdminAuditCheckpointRetentionEvent,
  type AdminAuditCheckpointRetainer,
} from "../../src/modules/admin/admin-audit-checkpoint-retention.js";
import {
  PostgresAdminChangeAuditLedger,
  PostgresAdminChangeAuditVerifier,
  type AdminChangeAuditEvent,
} from "../../src/modules/admin/admin-change-audit-ledger.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";

class CapturingRetainer implements AdminAuditCheckpointRetainer {
  public readonly events: AdminAuditCheckpointRetentionEvent[] = [];

  public async retain(event: AdminAuditCheckpointRetentionEvent): Promise<void> {
    this.events.push(event);
  }
}

integration("administrative audit checkpoint retention", () => {
  let pool: Pool;
  let sql: PgSqlAdapter;
  let ledger: PostgresAdminChangeAuditLedger;
  let chainVerifier: PostgresAdminChangeAuditVerifier;
  let issuer: PostgresAdminAuditCheckpointIssuer;
  let retainedVerifier: PostgresRetainedAdminAuditVerifier;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
    sql = new PgSqlAdapter(pool);
    const keys = generateKeyPairSync("ed25519");
    const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const provider = new StaticAuditKeyProvider(
      { keyId: "admin-checkpoint-k1", privateKey },
      new Map([["admin-checkpoint-k1", publicKey]]),
    );
    ledger = new PostgresAdminChangeAuditLedger(sql, provider);
    chainVerifier = new PostgresAdminChangeAuditVerifier(sql, provider);
    issuer = new PostgresAdminAuditCheckpointIssuer(sql, provider);
    retainedVerifier = new PostgresRetainedAdminAuditVerifier(sql, chainVerifier, provider);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("proves coherent database head rewind against an independently retained checkpoint", async () => {
    const organizationId = randomUUID();
    await pool.query(
      `insert into "Organization" ("id", "name", "createdAt", "updatedAt")
       values ($1, 'Checkpoint rewind org', now(), now())`,
      [organizationId],
    );
    await ledger.append(event(organizationId, "policy.create", "policy-1"));
    await ledger.append(event(organizationId, "policy.activate", "policy-1"));

    const checkpoint = await issuer.issueCheckpoint(organizationId, new Date("2026-08-15T06:50:00Z"));
    expect(checkpoint).toMatchObject({
      version: 1,
      organizationId,
      chainSequence: "2",
      signingKeyId: "admin-checkpoint-k1",
    });
    expect(checkpoint.chainDigest).toBeTruthy();
    expect(await retainedVerifier.verifyOrganization(organizationId, checkpoint)).toMatchObject({
      valid: true,
      checkpointSequence: "2",
      currentHeadSequence: "2",
    });

    await pool.query(`delete from "AdminAuditLog" where "organizationId" = $1`, [organizationId]);
    await pool.query(
      `update "AdminAuditChainHead"
          set "chainSequence" = 0,
              "chainDigest" = null,
              "updatedAt" = now()
        where "organizationId" = $1`,
      [organizationId],
    );

    expect(await chainVerifier.verifyOrganization(organizationId)).toEqual({
      valid: true,
      checkedEvents: 0,
      headSequence: "0",
    });
    expect(await retainedVerifier.verifyOrganization(organizationId, checkpoint)).toMatchObject({
      valid: false,
      checkpointSequence: "2",
      currentHeadSequence: "0",
      failure: AdminAuditCheckpointVerificationFailure.CHECKPOINT_TRUNCATED,
    });

    await pool.query(`delete from "AdminAuditChainHead" where "organizationId" = $1`, [organizationId]);
    await pool.query(`delete from "Organization" where "id" = $1`, [organizationId]);
  });

  it("detects checkpoint tampering and organization substitution before trusting database state", async () => {
    const organizationId = randomUUID();
    const otherOrganizationId = randomUUID();
    await pool.query(
      `insert into "Organization" ("id", "name", "createdAt", "updatedAt")
       values ($1, 'Checkpoint tamper org', now(), now()), ($2, 'Checkpoint other org', now(), now())`,
      [organizationId, otherOrganizationId],
    );
    await ledger.append(event(organizationId, "merchant.create", "merchant-1"));
    const checkpoint = await issuer.issueCheckpoint(organizationId, new Date("2026-08-15T06:51:00Z"));

    expect(
      await retainedVerifier.verifyOrganization(organizationId, {
        ...checkpoint,
        chainDigest: "tampered-digest",
      }),
    ).toMatchObject({
      valid: false,
      failure: AdminAuditCheckpointVerificationFailure.INVALID_CHECKPOINT_SIGNATURE,
    });
    expect(await retainedVerifier.verifyOrganization(otherOrganizationId, checkpoint)).toMatchObject({
      valid: false,
      failure: AdminAuditCheckpointVerificationFailure.CHECKPOINT_ORGANIZATION_MISMATCH,
    });

    await pool.query(`delete from "AdminAuditLog" where "organizationId" = $1`, [organizationId]);
    await pool.query(`delete from "AdminAuditChainHead" where "organizationId" = $1`, [organizationId]);
    await pool.query(`delete from "Organization" where "id" = any($1::uuid[])`, [
      [organizationId, otherOrganizationId],
    ]);
  });

  it("delivers a stable admin checkpoint event at least once and suppresses unchanged repeats in-process", async () => {
    const organizationId = randomUUID();
    await pool.query(
      `insert into "Organization" ("id", "name", "createdAt", "updatedAt")
       values ($1, 'Checkpoint worker org', now(), now())`,
      [organizationId],
    );
    await ledger.append(event(organizationId, "agent.create", "agent-1"));

    const retainer = new CapturingRetainer();
    const worker = new AdminAuditCheckpointRetentionWorker(sql, issuer, retainer, { batchSize: 100 });
    expect(await worker.runOnce()).toMatchObject({ delivered: 1, failed: 0 });
    expect(retainer.events).toHaveLength(1);
    expect(retainer.events[0]).toMatchObject({
      type: "mino.admin.audit.checkpoint.retention.v1",
      checkpoint: { organizationId, chainSequence: "1" },
    });
    expect(adminRetentionEvent(retainer.events[0]!.checkpoint).eventId).toBe(retainer.events[0]!.eventId);

    expect(await worker.runOnce()).toMatchObject({ alreadyDelivered: 1, delivered: 0, failed: 0 });
    expect(retainer.events).toHaveLength(1);

    await ledger.append(event(organizationId, "agent.suspend", "agent-1"));
    expect(await worker.runOnce()).toMatchObject({ delivered: 1, failed: 0 });
    expect(retainer.events).toHaveLength(2);
    expect(retainer.events[1]!.eventId).not.toBe(retainer.events[0]!.eventId);

    await pool.query(`delete from "AdminAuditLog" where "organizationId" = $1`, [organizationId]);
    await pool.query(`delete from "AdminAuditChainHead" where "organizationId" = $1`, [organizationId]);
    await pool.query(`delete from "Organization" where "id" = $1`, [organizationId]);
  });
});

function event(
  organizationId: string,
  action: string,
  resourceId: string,
): AdminChangeAuditEvent {
  return {
    requestId: randomUUID(),
    organizationId,
    principalId: randomUUID(),
    membershipId: randomUUID(),
    timestamp: new Date(),
    permission: "audit.verify",
    action,
    resourceType: action.split(".")[0] ?? "admin",
    resourceId,
    roles: ["AUDITOR"],
    beforeState: { active: false },
    afterState: { active: true },
    requestDigest: `sha256:${randomUUID()}`,
  };
}
