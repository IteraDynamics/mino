import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PgSqlAdapter } from "../../src/infrastructure/postgres/pg-sql-adapter.js";
import {
  AuditCheckpointRetentionWorker,
  type AuditCheckpointRetainer,
  type AuditCheckpointRetentionEvent,
} from "../../src/modules/audit/audit-checkpoint-retention.js";
import { PostgresAuditLedger } from "../../src/modules/audit/postgres-audit-ledger.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";

const organizationId = randomUUID();
const firstUpdatedAt = new Date("2026-08-14T20:45:00.000Z");

integration("AuditCheckpointRetentionWorker", () => {
  let pool: Pool;
  let ledger: PostgresAuditLedger;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const pair = generateKeyPairSync("ed25519");
    ledger = new PostgresAuditLedger(new PgSqlAdapter(pool), {
      async getActiveSigningKey() {
        return { keyId: "audit-retention-k1", privateKey: pair.privateKey };
      },
    });
  });

  beforeEach(async () => {
    await pool.query('delete from "AuditChainHead" where "organizationId" = $1::uuid', [organizationId]);
    await pool.query('delete from "Organization" where "id" = $1::uuid', [organizationId]);
    await pool.query(
      `insert into "Organization" ("id", "name", "createdAt", "updatedAt")
       values ($1::uuid, 'Retention Test Org', $2, $2)`,
      [organizationId, firstUpdatedAt],
    );
    await setHead("1", "digest-1", firstUpdatedAt);
  });

  afterAll(async () => {
    await pool.query('delete from "AuditChainHead" where "organizationId" = $1::uuid', [organizationId]);
    await pool.query('delete from "Organization" where "id" = $1::uuid', [organizationId]);
    await pool.end();
  });

  it("publishes one stable checkpoint per observed head and advances when the chain advances", async () => {
    const retained: AuditCheckpointRetentionEvent[] = [];
    const worker = new AuditCheckpointRetentionWorker(pool, ledger, collectingRetainer(retained));

    const firstRun = await worker.runOnce();
    expect(firstRun.failed).toBe(0);
    const firstOrganizationEvents = eventsForOrganization(retained);
    expect(firstOrganizationEvents).toHaveLength(1);
    expect(firstOrganizationEvents[0]?.checkpoint).toMatchObject({
      organizationId,
      chainSequence: "1",
      chainDigest: "digest-1",
      issuedAt: firstUpdatedAt.toISOString(),
      signingKeyId: "audit-retention-k1",
    });

    const secondRun = await worker.runOnce();
    expect(secondRun.failed).toBe(0);
    expect(eventsForOrganization(retained)).toHaveLength(1);

    const secondUpdatedAt = new Date(firstUpdatedAt.getTime() + 60_000);
    await setHead("2", "digest-2", secondUpdatedAt);
    const advanced = await worker.runOnce();
    expect(advanced.failed).toBe(0);
    const advancedEvents = eventsForOrganization(retained);
    expect(advancedEvents).toHaveLength(2);
    expect(advancedEvents[1]?.checkpoint).toMatchObject({
      organizationId,
      chainSequence: "2",
      chainDigest: "digest-2",
      issuedAt: secondUpdatedAt.toISOString(),
    });
    expect(advancedEvents[1]?.eventId).not.toBe(advancedEvents[0]?.eventId);
  });

  it("retries a failed external write with the identical event identity and checkpoint payload", async () => {
    const attempts: AuditCheckpointRetentionEvent[] = [];
    let failOurOrganization = true;
    const retainer: AuditCheckpointRetainer = {
      async retain(event) {
        if (event.checkpoint.organizationId !== organizationId) {
          return;
        }
        attempts.push(event);
        if (failOurOrganization) {
          failOurOrganization = false;
          throw new Error("external retention unavailable");
        }
      },
    };
    const worker = new AuditCheckpointRetentionWorker(pool, ledger, retainer);

    expect((await worker.runOnce()).failed).toBe(1);
    expect((await worker.runOnce()).failed).toBe(0);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
  });

  it("resends the same stable event after a process-style worker restart for downstream deduplication", async () => {
    const first: AuditCheckpointRetentionEvent[] = [];
    const second: AuditCheckpointRetentionEvent[] = [];

    const worker1 = new AuditCheckpointRetentionWorker(pool, ledger, collectingRetainer(first));
    const worker2 = new AuditCheckpointRetentionWorker(pool, ledger, collectingRetainer(second));
    await worker1.runOnce();
    await worker2.runOnce();

    const firstOrganizationEvents = eventsForOrganization(first);
    const secondOrganizationEvents = eventsForOrganization(second);
    expect(firstOrganizationEvents).toHaveLength(1);
    expect(secondOrganizationEvents).toHaveLength(1);
    expect(secondOrganizationEvents[0]).toEqual(firstOrganizationEvents[0]);
  });

  async function setHead(sequence: string, digest: string, updatedAt: Date): Promise<void> {
    await pool.query(
      `insert into "AuditChainHead" ("organizationId", "chainSequence", "chainDigest", "updatedAt")
       values ($1::uuid, $2::bigint, $3, $4)
       on conflict ("organizationId") do update
         set "chainSequence" = excluded."chainSequence",
             "chainDigest" = excluded."chainDigest",
             "updatedAt" = excluded."updatedAt"`,
      [organizationId, sequence, digest, updatedAt],
    );
  }
});

function eventsForOrganization(
  events: readonly AuditCheckpointRetentionEvent[],
): AuditCheckpointRetentionEvent[] {
  return events.filter((event) => event.checkpoint.organizationId === organizationId);
}

function collectingRetainer(target: AuditCheckpointRetentionEvent[]): AuditCheckpointRetainer {
  return {
    async retain(event) {
      target.push(event);
    },
  };
}
