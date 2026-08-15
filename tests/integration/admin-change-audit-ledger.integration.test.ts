import { generateKeyPairSync, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StaticAuditKeyProvider } from "../../src/infrastructure/crypto/static-key-providers.js";
import { PgSqlAdapter } from "../../src/infrastructure/postgres/pg-sql-adapter.js";
import {
  AdminAuditVerificationFailure,
  PostgresAdminChangeAuditLedger,
  PostgresAdminChangeAuditVerifier,
  type AdminChangeAuditEvent,
} from "../../src/modules/admin/admin-change-audit-ledger.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";

integration("administrative change audit ledger", () => {
  let pool: Pool;
  let sql: PgSqlAdapter;
  let ledger: PostgresAdminChangeAuditLedger;
  let verifier: PostgresAdminChangeAuditVerifier;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
    sql = new PgSqlAdapter(pool);
    const keys = generateKeyPairSync("ed25519");
    const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const provider = new StaticAuditKeyProvider(
      { keyId: "admin-audit-k1", privateKey },
      new Map([["admin-audit-k1", publicKey]]),
    );
    ledger = new PostgresAdminChangeAuditLedger(sql, provider);
    verifier = new PostgresAdminChangeAuditVerifier(sql, provider);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("rolls back both an administrative state change and its signed audit append together", async () => {
    const organizationId = randomUUID();
    await pool.query(
      `insert into "Organization" ("id", "name", "createdAt", "updatedAt")
       values ($1, 'Before rollback', now(), now())`,
      [organizationId],
    );

    const tx = await sql.connect();
    try {
      await tx.query("begin");
      await tx.query(`update "Organization" set "name" = 'Should not persist' where "id" = $1`, [
        organizationId,
      ]);
      await ledger.appendInTransaction(tx, event(organizationId, "organization.update"));
      await tx.query("rollback");
    } finally {
      tx.release();
    }

    const organization = await pool.query<{ name: string }>(
      `select "name" from "Organization" where "id" = $1`,
      [organizationId],
    );
    const auditRows = await pool.query(
      `select 1 from "AdminAuditLog" where "organizationId" = $1`,
      [organizationId],
    );
    const headRows = await pool.query(
      `select 1 from "AdminAuditChainHead" where "organizationId" = $1`,
      [organizationId],
    );

    expect(organization.rows[0]?.name).toBe("Before rollback");
    expect(auditRows.rowCount).toBe(0);
    expect(headRows.rowCount).toBe(0);
    await pool.query(`delete from "Organization" where "id" = $1`, [organizationId]);
  });

  it("commits the administrative state change and audit append atomically and verifies the chain", async () => {
    const organizationId = randomUUID();
    await pool.query(
      `insert into "Organization" ("id", "name", "createdAt", "updatedAt")
       values ($1, 'Before commit', now(), now())`,
      [organizationId],
    );

    const tx = await sql.connect();
    try {
      await tx.query("begin");
      await tx.query(`update "Organization" set "name" = 'After commit' where "id" = $1`, [
        organizationId,
      ]);
      const appended = await ledger.appendInTransaction(tx, event(organizationId, "organization.update"));
      expect(appended.chainSequence).toBe("1");
      await tx.query("commit");
    } catch (error) {
      await tx.query("rollback");
      throw error;
    } finally {
      tx.release();
    }

    const organization = await pool.query<{ name: string }>(
      `select "name" from "Organization" where "id" = $1`,
      [organizationId],
    );
    expect(organization.rows[0]?.name).toBe("After commit");
    expect(await verifier.verifyOrganization(organizationId)).toMatchObject({
      valid: true,
      checkedEvents: 1,
      headSequence: "1",
    });

    await pool.query(`delete from "AdminAuditLog" where "organizationId" = $1`, [organizationId]);
    await pool.query(`delete from "AdminAuditChainHead" where "organizationId" = $1`, [organizationId]);
    await pool.query(`delete from "Organization" where "id" = $1`, [organizationId]);
  });

  it("redacts sensitive before/after/metadata fields before hashing and persistence", async () => {
    const organizationId = randomUUID();
    await pool.query(
      `insert into "Organization" ("id", "name", "createdAt", "updatedAt")
       values ($1, 'Redaction org', now(), now())`,
      [organizationId],
    );

    await ledger.append({
      ...event(organizationId, "agent.rotate_key"),
      beforeState: {
        keyId: "old-key",
        privateKey: "PRIVATE-OLD",
        nested: { authorization: "Bearer old", password: "old-password" },
      },
      afterState: {
        keyId: "new-key",
        private_key: "PRIVATE-NEW",
        access_token: "ACCESS-NEW",
      },
      metadata: {
        client_secret: "CLIENT-SECRET",
        note: "safe-note",
      },
    });

    const row = (
      await pool.query<{
        beforeState: unknown;
        afterState: unknown;
        metadata: unknown;
      }>(
        `select "beforeState", "afterState", "metadata"
           from "AdminAuditLog"
          where "organizationId" = $1`,
        [organizationId],
      )
    ).rows[0];
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("PRIVATE-OLD");
    expect(serialized).not.toContain("PRIVATE-NEW");
    expect(serialized).not.toContain("Bearer old");
    expect(serialized).not.toContain("old-password");
    expect(serialized).not.toContain("ACCESS-NEW");
    expect(serialized).not.toContain("CLIENT-SECRET");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("safe-note");
    expect(await verifier.verifyOrganization(organizationId)).toMatchObject({ valid: true });

    await pool.query(`delete from "AdminAuditLog" where "organizationId" = $1`, [organizationId]);
    await pool.query(`delete from "AdminAuditChainHead" where "organizationId" = $1`, [organizationId]);
    await pool.query(`delete from "Organization" where "id" = $1`, [organizationId]);
  });

  it("detects persisted event mutation, chain-link damage, and signature corruption", async () => {
    const organizationId = randomUUID();
    await pool.query(
      `insert into "Organization" ("id", "name", "createdAt", "updatedAt")
       values ($1, 'Tamper org', now(), now())`,
      [organizationId],
    );
    await ledger.append(event(organizationId, "merchant.create"));
    await ledger.append({
      ...event(organizationId, "merchant.update"),
      resourceId: "merchant-2",
    });
    expect(await verifier.verifyOrganization(organizationId)).toMatchObject({
      valid: true,
      checkedEvents: 2,
    });

    await pool.query(
      `update "AdminAuditLog"
          set "afterState" = '{"active":false}'::jsonb
        where "organizationId" = $1 and "chainSequence" = 1`,
      [organizationId],
    );
    expect(await verifier.verifyOrganization(organizationId)).toMatchObject({
      valid: false,
      failure: AdminAuditVerificationFailure.EVENT_DIGEST_MISMATCH,
      brokenSequence: "1",
    });

    await pool.query(`delete from "AdminAuditLog" where "organizationId" = $1`, [organizationId]);
    await pool.query(`delete from "AdminAuditChainHead" where "organizationId" = $1`, [organizationId]);
    await ledger.append(event(organizationId, "merchant.create"));
    await ledger.append({
      ...event(organizationId, "merchant.update"),
      resourceId: "merchant-2",
    });
    await pool.query(
      `update "AdminAuditLog"
          set "previousChainDigest" = 'broken-link'
        where "organizationId" = $1 and "chainSequence" = 2`,
      [organizationId],
    );
    expect(await verifier.verifyOrganization(organizationId)).toMatchObject({
      valid: false,
      failure: AdminAuditVerificationFailure.PREVIOUS_DIGEST_MISMATCH,
      brokenSequence: "2",
    });

    await pool.query(`delete from "AdminAuditLog" where "organizationId" = $1`, [organizationId]);
    await pool.query(`delete from "AdminAuditChainHead" where "organizationId" = $1`, [organizationId]);
    await ledger.append(event(organizationId, "merchant.create"));
    await pool.query(
      `update "AdminAuditLog"
          set "integritySignature" = 'AAAA'
        where "organizationId" = $1 and "chainSequence" = 1`,
      [organizationId],
    );
    expect(await verifier.verifyOrganization(organizationId)).toMatchObject({
      valid: false,
      failure: AdminAuditVerificationFailure.INVALID_EVENT_SIGNATURE,
      brokenSequence: "1",
    });

    await pool.query(`delete from "AdminAuditLog" where "organizationId" = $1`, [organizationId]);
    await pool.query(`delete from "AdminAuditChainHead" where "organizationId" = $1`, [organizationId]);
    await pool.query(`delete from "Organization" where "id" = $1`, [organizationId]);
  });

  it("detects newest-row deletion while the durable chain head remains ahead", async () => {
    const organizationId = randomUUID();
    await pool.query(
      `insert into "Organization" ("id", "name", "createdAt", "updatedAt")
       values ($1, 'Head mismatch org', now(), now())`,
      [organizationId],
    );
    await ledger.append(event(organizationId, "policy.create"));
    await ledger.append({ ...event(organizationId, "policy.activate"), resourceId: "policy-2" });
    await pool.query(
      `delete from "AdminAuditLog"
        where "organizationId" = $1 and "chainSequence" = 2`,
      [organizationId],
    );

    expect(await verifier.verifyOrganization(organizationId)).toMatchObject({
      valid: false,
      failure: AdminAuditVerificationFailure.HEAD_SEQUENCE_MISMATCH,
      headSequence: "1",
      brokenSequence: "2",
    });

    await pool.query(`delete from "AdminAuditLog" where "organizationId" = $1`, [organizationId]);
    await pool.query(`delete from "AdminAuditChainHead" where "organizationId" = $1`, [organizationId]);
    await pool.query(`delete from "Organization" where "id" = $1`, [organizationId]);
  });
});

function event(organizationId: string, action: string): AdminChangeAuditEvent {
  return {
    requestId: randomUUID(),
    organizationId,
    principalId: randomUUID(),
    membershipId: randomUUID(),
    timestamp: new Date(),
    permission: "organization.manage",
    action,
    resourceType: "organization",
    resourceId: organizationId,
    roles: ["ORGANIZATION_OWNER"],
    beforeState: { name: "before", secret: "DO-NOT-PERSIST" },
    afterState: { name: "after" },
    requestDigest: `sha256:${randomUUID()}`,
  };
}
