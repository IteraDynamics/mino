import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { DecisionReason } from "../../src/domain/evaluation/decision-reasons.js";
import { DecisionVerdict, type PolicyDecision } from "../../src/domain/evaluation/evaluation.types.js";
import {
  AuditVerificationFailure,
  PostgresAuditLedger,
  PostgresAuditVerifier,
  type AuditSigningKey,
  type AuditSqlClient,
  type AuditSqlTransaction,
} from "../../src/modules/audit/postgres-audit-ledger.js";
import type { GatewayAuditEvent } from "../../src/modules/audit/audit-sink.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";

const ids = {
  organization: "40000000-0000-4000-8000-000000000001",
  user: "40000000-0000-4000-8000-000000000002",
  agent: "40000000-0000-4000-8000-000000000003",
  policy: "40000000-0000-4000-8000-000000000004",
  mandate: "40000000-0000-4000-8000-000000000005",
};
const now = new Date("2026-08-14T17:30:00.000Z");

integration("PostgresAuditLedger", () => {
  let pool: Pool;
  let ledger: PostgresAuditLedger;
  let verifier: PostgresAuditVerifier;
  let activeKey: AuditSigningKey;
  let key1: { privateKey: KeyObject; publicKey: KeyObject };
  let key2: { privateKey: KeyObject; publicKey: KeyObject };
  const verificationKeys = new Map<string, KeyObject>();

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 20 });
    key1 = generateKeyPairSync("ed25519");
    key2 = generateKeyPairSync("ed25519");
    verificationKeys.set("audit-k1", key1.publicKey);
    verificationKeys.set("audit-k2", key2.publicKey);
    activeKey = { keyId: "audit-k1", privateKey: key1.privateKey };
    const sql = sqlAdapter(pool);
    ledger = new PostgresAuditLedger(sql, {
      async getActiveSigningKey() {
        return activeKey;
      },
    });
    verifier = new PostgresAuditVerifier(sql, {
      async resolvePublicKey(keyId) {
        return verificationKeys.get(keyId);
      },
    });
  });

  beforeEach(async () => {
    activeKey = { keyId: "audit-k1", privateKey: key1.privateKey };
    await pool.query('delete from "AuditLog" where "organizationId" = $1::uuid', [ids.organization]);
    await pool.query('delete from "AuditChainHead" where "organizationId" = $1::uuid', [ids.organization]);
    await pool.query('delete from "AgentMandate" where "id" = $1::uuid', [ids.mandate]);
    await pool.query('delete from "Policy" where "id" = $1::uuid', [ids.policy]);
    await pool.query('delete from "AgentIdentity" where "id" = $1::uuid', [ids.agent]);
    await pool.query('delete from "User" where "id" = $1::uuid', [ids.user]);
    await pool.query('delete from "Organization" where "id" = $1::uuid', [ids.organization]);

    await pool.query(
      `insert into "Organization" ("id", "name", "createdAt", "updatedAt")
       values ($1::uuid, 'Audit Test Org', $2, $2)`,
      [ids.organization, now],
    );
    await pool.query(
      `insert into "User" ("id", "organizationId", "email", "status", "createdAt", "updatedAt")
       values ($1::uuid, $2::uuid, 'audit@example.test', 'ACTIVE', $3, $3)`,
      [ids.user, ids.organization, now],
    );
    await pool.query(
      `insert into "AgentIdentity" (
         "id", "organizationId", "externalAgentId", "status", "createdAt", "updatedAt"
       ) values ($1::uuid, $2::uuid, 'audit-agent', 'ACTIVE', $3, $3)`,
      [ids.agent, ids.organization, now],
    );
    await pool.query(
      `insert into "Policy" (
         "id", "organizationId", "name", "version", "active", "baseCurrency",
         "maxBudgetMinor", "rollingDailyLimitMinor", "approvedMerchantDomains",
         "approvedVendorIds", "restrictedCategories", "approvalMode",
         "maxTransactionsPerMinute", "crossMerchantWindowSecs", "maxDistinctMerchants",
         "createdAt", "updatedAt"
       ) values (
         $1::uuid, $2::uuid, 'Audit Policy', 1, true, 'USD',
         10000, 20000, array['merchant.example'], array[]::text[], array[]::text[], 'AUTO_APPROVE',
         10, 60, 5, $3, $3
       )`,
      [ids.policy, ids.organization, now],
    );
    await pool.query(
      `insert into "AgentMandate" (
         "id", "organizationId", "userId", "agentId", "policyId", "tokenJtiHash",
         "policyVersion", "currency", "maxBudgetMinor", "rollingDailyLimitMinor",
         "approvedMerchantDomains", "approvedVendorIds", "restrictedCategories", "approvalMode",
         "maxTransactionsPerMinute", "crossMerchantWindowSecs", "maxDistinctMerchants",
         "delegationPayloadHash", "signingKeyId", "status", "issuedAt", "expiresAt"
       ) values (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'audit-jti-hash',
         1, 'USD', 10000, 20000,
         array['merchant.example'], array[]::text[], array[]::text[], 'AUTO_APPROVE',
         10, 60, 5, 'audit-delegation-hash', 'mino-k1', 'ACTIVE', $6, $7
       )`,
      [
        ids.mandate,
        ids.organization,
        ids.user,
        ids.agent,
        ids.policy,
        now,
        new Date(now.getTime() + 3_600_000),
      ],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it("serializes concurrent events into one signed organization chain and redacts secrets defensively", async () => {
    const writes = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) => ledger.record(event(index + 1))),
    );
    expect(writes.filter((result) => result.status === "rejected")).toHaveLength(0);

    const rows = await pool.query<{
      chainSequence: string;
      previousChainDigest: string | null;
      chainDigest: string;
      requestedPayload: { payment_data?: { token?: string; card_number?: string } };
    }>(
      `select "chainSequence"::text as "chainSequence", "previousChainDigest", "chainDigest", "requestedPayload"
         from "AuditLog"
        where "organizationId" = $1::uuid
        order by "chainSequence"`,
      [ids.organization],
    );
    const head = await pool.query<{ chainSequence: string; chainDigest: string | null }>(
      `select "chainSequence"::text as "chainSequence", "chainDigest"
         from "AuditChainHead"
        where "organizationId" = $1::uuid`,
      [ids.organization],
    );

    expect(rows.rows.map((row) => row.chainSequence)).toEqual(
      Array.from({ length: 12 }, (_, index) => String(index + 1)),
    );
    expect(rows.rows[0]?.previousChainDigest).toBeNull();
    for (let index = 1; index < rows.rows.length; index += 1) {
      expect(rows.rows[index]?.previousChainDigest).toBe(rows.rows[index - 1]?.chainDigest);
    }
    expect(head.rows[0]).toEqual({
      chainSequence: "12",
      chainDigest: rows.rows[11]?.chainDigest,
    });
    expect(rows.rows[0]?.requestedPayload.payment_data?.token).toBe("[REDACTED]");
    expect(rows.rows[0]?.requestedPayload.payment_data?.card_number).toBe("[REDACTED]");

    const verified = await verifier.verifyOrganization(ids.organization);
    expect(verified.valid).toBe(true);
    expect(verified.checkedEvents).toBe(12);
    expect(verified.headSequence).toBe("12");
  });

  it("detects direct mutation of a persisted audit event", async () => {
    await ledger.record(event(1));
    await pool.query(
      `update "AuditLog"
          set "requestedPayload" = '{"cart":"tampered"}'::jsonb
        where "organizationId" = $1::uuid and "chainSequence" = 1`,
      [ids.organization],
    );

    const verified = await verifier.verifyOrganization(ids.organization);
    expect(verified).toMatchObject({
      valid: false,
      failure: AuditVerificationFailure.EVENT_DIGEST_MISMATCH,
      brokenSequence: "1",
    });
  });

  it("detects deletion from the middle of the chain", async () => {
    await ledger.record(event(1));
    await ledger.record(event(2));
    await ledger.record(event(3));
    await pool.query(
      `delete from "AuditLog"
        where "organizationId" = $1::uuid and "chainSequence" = 2`,
      [ids.organization],
    );

    const verified = await verifier.verifyOrganization(ids.organization);
    expect(verified).toMatchObject({
      valid: false,
      failure: AuditVerificationFailure.SEQUENCE_GAP,
      brokenSequence: "3",
    });
  });

  it("uses a signed external checkpoint to detect tail truncation even if the mutable local head is rewritten", async () => {
    await ledger.record(event(1));
    await ledger.record(event(2));
    await ledger.record(event(3));
    const checkpoint = await ledger.issueCheckpoint(ids.organization, new Date(now.getTime() + 10_000));
    const sequenceTwo = await pool.query<{ chainDigest: string }>(
      `select "chainDigest"
         from "AuditLog"
        where "organizationId" = $1::uuid and "chainSequence" = 2`,
      [ids.organization],
    );

    await pool.query(
      `delete from "AuditLog"
        where "organizationId" = $1::uuid and "chainSequence" = 3`,
      [ids.organization],
    );
    await pool.query(
      `update "AuditChainHead"
          set "chainSequence" = 2, "chainDigest" = $2
        where "organizationId" = $1::uuid`,
      [ids.organization, sequenceTwo.rows[0]?.chainDigest],
    );

    const localOnly = await verifier.verifyOrganization(ids.organization);
    expect(localOnly.valid).toBe(true);
    expect(localOnly.headSequence).toBe("2");

    const anchored = await verifier.verifyOrganization(ids.organization, checkpoint);
    expect(anchored).toMatchObject({
      valid: false,
      failure: AuditVerificationFailure.CHECKPOINT_TRUNCATED,
      headSequence: "2",
      brokenSequence: "3",
    });
  });

  it("verifies a chain across audit signing-key rotation", async () => {
    await ledger.record(event(1));
    activeKey = { keyId: "audit-k2", privateKey: key2.privateKey };
    await ledger.record(event(2));

    const keys = await pool.query<{ signingKeyId: string }>(
      `select "signingKeyId"
         from "AuditLog"
        where "organizationId" = $1::uuid
        order by "chainSequence"`,
      [ids.organization],
    );
    expect(keys.rows.map((row) => row.signingKeyId)).toEqual(["audit-k1", "audit-k2"]);

    const verified = await verifier.verifyOrganization(ids.organization);
    expect(verified.valid).toBe(true);
    expect(verified.checkedEvents).toBe(2);
  });
});

function event(sequence: number): GatewayAuditEvent {
  const suffix = sequence.toString(16).padStart(12, "0");
  const requestId = `40000000-0000-4000-8001-${suffix}`;
  const decisionId = `40000000-0000-4000-8002-${suffix}`;
  const timestamp = new Date(now.getTime() + sequence * 1_000);
  const decision: PolicyDecision = {
    decisionId,
    requestId,
    verdict: DecisionVerdict.ALLOW,
    reasons: [DecisionReason.POLICY_ALLOW],
    requestedAmount: { currency: "USD", minorUnits: BigInt(1_000 + sequence) },
    policyAmount: { currency: "USD", minorUnits: BigInt(1_000 + sequence) },
    approvedAmount: { currency: "USD", minorUnits: BigInt(1_000 + sequence) },
    mandateId: ids.mandate,
    policyId: ids.policy,
    policyVersion: 1,
    eligibleForDelegationAssertion: true,
    evaluationLatencyMicros: 25 + sequence,
    evaluatedAt: timestamp,
  };

  return {
    requestId,
    decisionId,
    organizationId: ids.organization,
    userId: ids.user,
    agentId: ids.agent,
    mandateId: ids.mandate,
    timestamp,
    protocol: "ACP",
    operation: "COMPLETE_CHECKOUT",
    merchantDomain: "merchant.example",
    requestedPayload: {
      cart: [{ sku: `monitor-${sequence}`, quantity: 1 }],
      payment_data: {
        token: `secret-token-${sequence}`,
        card_number: "4111111111111111",
      },
    },
    approvedPayload: { checkout_session_id: `cs_${sequence}` },
    decision,
    requestDigest: `request-digest-${sequence}`,
    reservationId: `reservation-${sequence}`,
    upstreamStatus: 200,
  };
}

function sqlAdapter(pool: Pool): AuditSqlClient {
  return {
    async query<R extends QueryResultRow>(text: string, values?: unknown[]) {
      const result = await pool.query<R>(text, values);
      return { rows: result.rows, rowCount: result.rowCount };
    },
    async connect(): Promise<AuditSqlTransaction> {
      return transactionAdapter(await pool.connect());
    },
  };
}

function transactionAdapter(client: PoolClient): AuditSqlTransaction {
  return {
    async query<R extends QueryResultRow>(text: string, values?: unknown[]) {
      const result = await client.query<R>(text, values);
      return { rows: result.rows, rowCount: result.rowCount };
    },
    release() {
      client.release();
    },
  };
}
