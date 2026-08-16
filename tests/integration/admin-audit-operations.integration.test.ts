import { generateKeyPairSync, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DecisionReason } from "../../src/domain/evaluation/decision-reasons.js";
import {
  DecisionVerdict,
  type PolicyDecision,
} from "../../src/domain/evaluation/evaluation.types.js";
import { StaticAuditKeyProvider } from "../../src/infrastructure/crypto/static-key-providers.js";
import { PgSqlAdapter } from "../../src/infrastructure/postgres/pg-sql-adapter.js";
import { PostgresAdminAuditOperations } from "../../src/modules/admin/admin-audit-operations.js";
import {
  PostgresAdminAuditCheckpointIssuer,
  PostgresRetainedAdminAuditVerifier,
} from "../../src/modules/admin/admin-audit-checkpoint-retention.js";
import {
  PostgresAdminChangeAuditLedger,
  PostgresAdminChangeAuditVerifier,
} from "../../src/modules/admin/admin-change-audit-ledger.js";
import type { GatewayAuditEvent } from "../../src/modules/audit/audit-sink.js";
import {
  PostgresAuditLedger,
  PostgresAuditVerifier,
} from "../../src/modules/audit/postgres-audit-ledger.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";
const now = new Date("2026-08-16T19:00:00.000Z");

integration("administrative audit and operations read model", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("pages safe independent audit chains, verifies retained anchors, and exposes tenant-scoped worker-relevant state", async () => {
    const primary = fixtureIds();
    const other = fixtureIds();
    const organizationIds = [primary.organizationId, other.organizationId];
    const sql = new PgSqlAdapter(pool);
    const keys = generateKeyPairSync("ed25519");
    const provider = new StaticAuditKeyProvider(
      {
        keyId: "audit-ops-k1",
        privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      },
      new Map([
        [
          "audit-ops-k1",
          keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
        ],
      ]),
    );
    const transactionLedger = new PostgresAuditLedger(sql, provider);
    const transactionVerifier = new PostgresAuditVerifier(sql, provider);
    const adminLedger = new PostgresAdminChangeAuditLedger(sql, provider);
    const adminVerifier = new PostgresAdminChangeAuditVerifier(sql, provider);
    const adminCheckpointIssuer = new PostgresAdminAuditCheckpointIssuer(sql, provider);
    const retainedAdminVerifier = new PostgresRetainedAdminAuditVerifier(
      sql,
      adminVerifier,
      provider,
    );
    const operations = new PostgresAdminAuditOperations(sql, () => now);

    try {
      await seedAuthority(pool, primary, "Primary operations org");
      await seedAuthority(pool, other, "Other operations org");

      await transactionLedger.record(transactionEvent(primary, 1, "ALLOW", "TX-PAYLOAD-SECRET-1"));
      await transactionLedger.record(transactionEvent(primary, 2, "BLOCK", "TX-PAYLOAD-SECRET-2"));
      await transactionLedger.record(transactionEvent(other, 1, "ALLOW", "OTHER-TX-SECRET"));

      await adminLedger.append({
        requestId: randomUUID(),
        organizationId: primary.organizationId,
        principalId: randomUUID(),
        membershipId: randomUUID(),
        timestamp: new Date(now.getTime() - 120_000),
        permission: "policy.activate",
        action: "policy.activate",
        resourceType: "policy",
        resourceId: primary.policyId,
        roles: ["SECURITY_ADMIN"],
        beforeState: { active: false, secret: "ADMIN-BEFORE-SECRET-1" },
        afterState: { active: true },
        requestDigest: "ADMIN-REQUEST-DIGEST-SECRET-1",
        metadata: { internal: "ADMIN-METADATA-SECRET-1" },
      });
      await adminLedger.append({
        requestId: randomUUID(),
        organizationId: primary.organizationId,
        principalId: randomUUID(),
        membershipId: randomUUID(),
        timestamp: new Date(now.getTime() - 60_000),
        permission: "mandate.revoke",
        action: "mandate.revoke",
        resourceType: "mandate",
        resourceId: primary.mandateId,
        roles: ["SECURITY_ADMIN"],
        beforeState: { status: "ACTIVE", secret: "ADMIN-BEFORE-SECRET-2" },
        afterState: { status: "REVOKED" },
        requestDigest: "ADMIN-REQUEST-DIGEST-SECRET-2",
      });
      await adminLedger.append({
        requestId: randomUUID(),
        organizationId: other.organizationId,
        principalId: randomUUID(),
        membershipId: randomUUID(),
        timestamp: new Date(now.getTime() - 30_000),
        permission: "merchant.manage",
        action: "merchant.activate",
        resourceType: "merchant",
        resourceId: "other-merchant",
        roles: ["SECURITY_ADMIN"],
        beforeState: { active: false },
        afterState: { active: true, secret: "OTHER-ADMIN-SECRET" },
        requestDigest: "OTHER-ADMIN-DIGEST",
      });

      await seedOperationalState(pool, primary, other);

      const firstTransactions = await operations.listTransactionAudit(primary.organizationId, {
        limit: 1,
      });
      expect(firstTransactions.items).toHaveLength(1);
      expect(firstTransactions.items[0]).toMatchObject({
        chainSequence: "2",
        verdict: "BLOCK",
        merchantDomain: "shop.example.com",
        signingKeyId: "audit-ops-k1",
      });
      expect(firstTransactions.nextCursor).toBeTruthy();
      const secondTransactions = await operations.listTransactionAudit(primary.organizationId, {
        limit: 1,
        cursor: firstTransactions.nextCursor,
      });
      expect(secondTransactions.items).toHaveLength(1);
      expect(secondTransactions.items[0]).toMatchObject({ chainSequence: "1", verdict: "ALLOW" });

      const filteredTransactions = await operations.listTransactionAudit(primary.organizationId, {
        verdict: "ALLOW",
        merchantDomain: "SHOP.EXAMPLE.COM",
      });
      expect(filteredTransactions.items).toHaveLength(1);
      expect(JSON.stringify(filteredTransactions)).not.toContain("OTHER-TX-SECRET");
      const transactionText = JSON.stringify([
        firstTransactions,
        secondTransactions,
        filteredTransactions,
      ]);
      for (const secret of [
        "TX-PAYLOAD-SECRET-1",
        "TX-PAYLOAD-SECRET-2",
        "TX-REQUEST-DIGEST-1",
        "TX-REQUEST-DIGEST-2",
        "decisionSnapshot",
        "requestedPayload",
        "approvedPayload",
        "integritySignature",
      ]) {
        expect(transactionText).not.toContain(secret);
      }

      const administrative = await operations.listAdministrativeAudit(primary.organizationId, {
        permission: "mandate.revoke",
        resourceType: "mandate",
      });
      expect(administrative.items).toHaveLength(1);
      expect(administrative.items[0]).toMatchObject({
        chainSequence: "2",
        permission: "mandate.revoke",
        action: "mandate.revoke",
        resourceId: primary.mandateId,
      });
      const adminText = JSON.stringify(
        await operations.listAdministrativeAudit(primary.organizationId),
      );
      for (const secret of [
        "ADMIN-BEFORE-SECRET-1",
        "ADMIN-BEFORE-SECRET-2",
        "ADMIN-REQUEST-DIGEST-SECRET-1",
        "ADMIN-REQUEST-DIGEST-SECRET-2",
        "ADMIN-METADATA-SECRET-1",
        "OTHER-ADMIN-SECRET",
        "beforeState",
        "afterState",
        "integritySignature",
      ]) {
        expect(adminText).not.toContain(secret);
      }

      expect(await transactionVerifier.verifyOrganization(primary.organizationId)).toMatchObject({
        valid: true,
        checkedEvents: 2,
        headSequence: "2",
      });
      expect(await adminVerifier.verifyOrganization(primary.organizationId)).toMatchObject({
        valid: true,
        checkedEvents: 2,
        headSequence: "2",
      });

      const transactionCheckpoint = await transactionLedger.issueCheckpoint(
        primary.organizationId,
        now,
      );
      expect(
        await transactionVerifier.verifyOrganization(primary.organizationId, transactionCheckpoint),
      ).toMatchObject({ valid: true, checkedEvents: 2, headSequence: "2" });

      const adminCheckpoint = await adminCheckpointIssuer.issueCheckpoint(primary.organizationId, now);
      expect(
        await retainedAdminVerifier.verifyOrganization(primary.organizationId, adminCheckpoint),
      ).toMatchObject({
        valid: true,
        checkpointSequence: "2",
        currentHeadSequence: "2",
      });

      const snapshot = await operations.operationalSnapshot(primary.organizationId);
      expect(snapshot).toMatchObject({
        capturedAt: now.toISOString(),
        payments: {
          forwarding: 1,
          unknown: 2,
          succeeded: 1,
          failedDefinitive: 0,
          unresolved: 3,
          claimable: 1,
          stale: 1,
          highAttempt: 1,
          leased: 1,
          oldestUnresolvedPaymentId: primary.paymentIds[0],
          oldestUnresolvedAgeSeconds: 1200,
        },
        approvals: {
          pending: 3,
          approved: 1,
          rejected: 1,
          expired: 1,
          expiredPending: 1,
          notificationPending: 2,
          notificationLeased: 1,
          notificationDelivered: 1,
          notificationDeadLetter: 1,
          notificationClaimable: 2,
          oldestUndeliveredAgeSeconds: 1200,
        },
        reservations: {
          reserved: 1,
          committed: 1,
          released: 1,
          expired: 1,
          overdueReserved: 1,
        },
        audit: {
          transaction: { headSequence: "2" },
          administrative: { headSequence: "2" },
        },
      });
    } finally {
      await cleanup(pool, organizationIds);
    }
  });
});

interface FixtureIds {
  readonly organizationId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly policyId: string;
  readonly mandateId: string;
  readonly paymentIds: readonly [string, string, string, string];
  readonly approvalIds: readonly [string, string, string, string, string, string];
  readonly reservationIds: readonly [string, string, string, string];
}

function fixtureIds(): FixtureIds {
  return {
    organizationId: randomUUID(),
    userId: randomUUID(),
    agentId: randomUUID(),
    policyId: randomUUID(),
    mandateId: randomUUID(),
    paymentIds: [randomUUID(), randomUUID(), randomUUID(), randomUUID()],
    approvalIds: [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ],
    reservationIds: [randomUUID(), randomUUID(), randomUUID(), randomUUID()],
  };
}

async function seedAuthority(pool: Pool, ids: FixtureIds, name: string): Promise<void> {
  await pool.query(
    `insert into "Organization" ("id", "name", "createdAt", "updatedAt")
     values ($1, $2, $3, $3)`,
    [ids.organizationId, name, now],
  );
  await pool.query(
    `insert into "User" ("id", "organizationId", "email", "status", "createdAt", "updatedAt")
     values ($1, $2, $3, 'ACTIVE', $4, $4)`,
    [ids.userId, ids.organizationId, `${ids.userId}@example.test`, now],
  );
  await pool.query(
    `insert into "AgentIdentity"
      ("id", "organizationId", "externalAgentId", "status", "createdAt", "updatedAt")
     values ($1, $2, $3, 'ACTIVE', $4, $4)`,
    [ids.agentId, ids.organizationId, `audit-operations-${ids.agentId}`, now],
  );
  await pool.query(
    `insert into "Policy" (
       "id", "organizationId", "name", "version", "active", "baseCurrency",
       "maxBudgetMinor", "rollingDailyLimitMinor", "approvedMerchantDomains",
       "approvedVendorIds", "restrictedCategories", "approvalMode",
       "maxTransactionsPerMinute", "crossMerchantWindowSecs", "maxDistinctMerchants",
       "createdAt", "updatedAt"
     ) values (
       $1, $2, $3, 1, true, 'USD', 1000000, 1000000,
       ARRAY['shop.example.com'], ARRAY[]::text[], ARRAY[]::text[], 'AUTO_APPROVE',
       10, 60, 5, $4, $4
     )`,
    [ids.policyId, ids.organizationId, `Audit operations ${ids.policyId}`, now],
  );
  await pool.query(
    `insert into "AgentMandate" (
       "id", "organizationId", "userId", "agentId", "policyId", "tokenJtiHash",
       "policyVersion", "currency", "maxBudgetMinor", "rollingDailyLimitMinor",
       "approvedMerchantDomains", "approvedVendorIds", "restrictedCategories", "approvalMode",
       "maxTransactionsPerMinute", "crossMerchantWindowSecs", "maxDistinctMerchants",
       "delegationPayloadHash", "signingKeyId", "status", "issuedAt", "expiresAt"
     ) values (
       $1, $2, $3, $4, $5, $6, 1, 'USD', 1000000, 1000000,
       ARRAY['shop.example.com'], ARRAY[]::text[], ARRAY[]::text[], 'AUTO_APPROVE',
       10, 60, 5, $7, 'mino-k1', 'ACTIVE', $8, $9
     )`,
    [
      ids.mandateId,
      ids.organizationId,
      ids.userId,
      ids.agentId,
      ids.policyId,
      `audit-operations-jti-${ids.mandateId}`,
      `delegation-${ids.mandateId}`,
      new Date(now.getTime() - 3_600_000),
      new Date(now.getTime() + 86_400_000),
    ],
  );
}

function transactionEvent(
  ids: FixtureIds,
  sequence: number,
  verdict: "ALLOW" | "BLOCK",
  payloadSecret: string,
): GatewayAuditEvent {
  const requestId = randomUUID();
  const decisionId = randomUUID();
  const timestamp = new Date(now.getTime() - (10 - sequence) * 60_000);
  const decision: PolicyDecision = {
    decisionId,
    requestId,
    verdict: verdict === "ALLOW" ? DecisionVerdict.ALLOW : DecisionVerdict.BLOCK,
    reasons: [verdict === "ALLOW" ? DecisionReason.POLICY_ALLOW : DecisionReason.TRANSACTION_LIMIT_EXCEEDED],
    requestedAmount: { currency: "USD", minorUnits: BigInt(10_000 + sequence) },
    policyAmount: { currency: "USD", minorUnits: BigInt(10_000 + sequence) },
    ...(verdict === "ALLOW"
      ? { approvedAmount: { currency: "USD", minorUnits: BigInt(10_000 + sequence) } }
      : {}),
    mandateId: ids.mandateId,
    policyId: ids.policyId,
    policyVersion: 1,
    eligibleForDelegationAssertion: verdict === "ALLOW",
    evaluationLatencyMicros: 100 + sequence,
    evaluatedAt: timestamp,
  };
  return {
    requestId,
    decisionId,
    organizationId: ids.organizationId,
    userId: ids.userId,
    agentId: ids.agentId,
    mandateId: ids.mandateId,
    timestamp,
    protocol: "ACP",
    operation: sequence === 1 ? "retrieve_checkout" : "complete_checkout",
    merchantDomain: "shop.example.com",
    requestedPayload: { cart: [{ sku: payloadSecret }], authorization: payloadSecret },
    approvedPayload: { token: `${payloadSecret}-APPROVED` },
    decision,
    requestDigest: `TX-REQUEST-DIGEST-${sequence}`,
    ...(verdict === "ALLOW" ? { reservationId: `reservation-audit-${sequence}` } : {}),
    upstreamStatus: verdict === "ALLOW" ? 200 : 422,
  };
}

async function seedOperationalState(
  pool: Pool,
  ids: FixtureIds,
  other: FixtureIds,
): Promise<void> {
  const [unknownOld, forwardingFresh, succeeded, unknownLeased] = ids.paymentIds;
  const paymentRows = [
    {
      id: unknownOld,
      status: "UNKNOWN",
      amount: "25000",
      attempts: 8,
      createdAt: new Date(now.getTime() - 20 * 60_000),
      updatedAt: new Date(now.getTime() - 10 * 60_000),
      nextAt: new Date(now.getTime() - 5 * 60_000),
      leaseOwner: null,
      leaseExpiresAt: null,
    },
    {
      id: forwardingFresh,
      status: "FORWARDING",
      amount: "12000",
      attempts: 0,
      createdAt: new Date(now.getTime() - 10_000),
      updatedAt: new Date(now.getTime() - 10_000),
      nextAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    },
    {
      id: succeeded,
      status: "SUCCEEDED",
      amount: "15000",
      attempts: 1,
      createdAt: new Date(now.getTime() - 30 * 60_000),
      updatedAt: new Date(now.getTime() - 25 * 60_000),
      nextAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    },
    {
      id: unknownLeased,
      status: "UNKNOWN",
      amount: "18000",
      attempts: 2,
      createdAt: new Date(now.getTime() - 2 * 60_000),
      updatedAt: new Date(now.getTime() - 60_000),
      nextAt: new Date(now.getTime() - 60_000),
      leaseOwner: "active-reconciler",
      leaseExpiresAt: new Date(now.getTime() + 5 * 60_000),
    },
  ] as const;

  for (const [index, row] of paymentRows.entries()) {
    await pool.query(
      `insert into "PaymentOutcome" (
         "id", "organizationId", "userId", "agentId", "mandateId", "reservationId",
         "idempotencyKey", "requestDigest", "merchantId", "merchantDomain", "checkoutSessionId",
         "amountMinor", "currency", "status", "reconcileAttempts", "nextReconcileAt",
         "reconciliationLeaseOwner", "reconciliationLeaseExpiresAt", "createdAt", "updatedAt"
       ) values (
         $1, $2, $3, $4, $5, $6, $7, $8, 'merchant-1', 'shop.example.com', $9,
         $10::bigint, 'USD', $11::"PaymentOutcomeStatus", $12, $13, $14, $15, $16, $17
       )`,
      [
        row.id,
        ids.organizationId,
        ids.userId,
        ids.agentId,
        ids.mandateId,
        `ops-payment-reservation-${row.id}`,
        `ops-payment-idempotency-${row.id}`,
        `ops-payment-digest-${row.id}`,
        `checkout-${index}`,
        row.amount,
        row.status,
        row.attempts,
        row.nextAt,
        row.leaseOwner,
        row.leaseExpiresAt,
        row.createdAt,
        row.updatedAt,
      ],
    );
  }

  await pool.query(
    `insert into "PaymentOutcome" (
       "id", "organizationId", "userId", "agentId", "mandateId", "reservationId",
       "idempotencyKey", "requestDigest", "merchantId", "merchantDomain", "checkoutSessionId",
       "amountMinor", "currency", "status", "createdAt", "updatedAt"
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, 'other-merchant', 'other.example.com', 'other-checkout',
       999, 'USD', 'UNKNOWN', $9, $9
     )`,
    [
      other.paymentIds[0],
      other.organizationId,
      other.userId,
      other.agentId,
      other.mandateId,
      `other-reservation-${other.paymentIds[0]}`,
      `other-idempotency-${other.paymentIds[0]}`,
      `other-digest-${other.paymentIds[0]}`,
      new Date(now.getTime() - 60 * 60_000),
    ],
  );

  const approvalSpecs = [
    {
      id: ids.approvalIds[0],
      status: "PENDING",
      createdAt: new Date(now.getTime() - 10 * 60_000),
      expiresAt: new Date(now.getTime() + 30 * 60_000),
      notification: null,
    },
    {
      id: ids.approvalIds[1],
      status: "PENDING",
      createdAt: new Date(now.getTime() - 20 * 60_000),
      expiresAt: new Date(now.getTime() + 30 * 60_000),
      notification: {
        status: "LEASED",
        attempts: 1,
        leaseOwner: "approval-worker",
        leaseExpiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
        lastAttemptAt: new Date(now.getTime() - 5_000).toISOString(),
      },
    },
    {
      id: ids.approvalIds[2],
      status: "PENDING",
      createdAt: new Date(now.getTime() - 15 * 60_000),
      expiresAt: new Date(now.getTime() - 5 * 60_000),
      notification: {
        status: "PENDING",
        attempts: 2,
        nextAttemptAt: new Date(now.getTime() - 60_000).toISOString(),
      },
    },
    {
      id: ids.approvalIds[3],
      status: "APPROVED",
      createdAt: new Date(now.getTime() - 40 * 60_000),
      expiresAt: new Date(now.getTime() + 10 * 60_000),
      notification: {
        status: "DELIVERED",
        attempts: 1,
        deliveredAt: new Date(now.getTime() - 35 * 60_000).toISOString(),
      },
    },
    {
      id: ids.approvalIds[4],
      status: "REJECTED",
      createdAt: new Date(now.getTime() - 50 * 60_000),
      expiresAt: new Date(now.getTime() - 30 * 60_000),
      notification: {
        status: "DEAD_LETTER",
        attempts: 12,
        lastErrorCode: "DELIVERY_ATTEMPTS_EXHAUSTED",
      },
    },
    {
      id: ids.approvalIds[5],
      status: "EXPIRED",
      createdAt: new Date(now.getTime() - 60 * 60_000),
      expiresAt: new Date(now.getTime() - 45 * 60_000),
      notification: null,
    },
  ] as const;

  for (const [index, spec] of approvalSpecs.entries()) {
    await pool.query(
      `insert into "ApprovalRequest" (
         "id", "organizationId", "userId", "agentId", "mandateId", "decisionId", "requestId",
         "idempotencyKey", "requestDigest", "policyVersion", "merchantId", "merchantDomain",
         "checkoutSessionId", "requestedPayload", "reasonCodes", "amountMinor", "currency",
         "status", "requiredSignatures", "approvalData", "createdAt", "expiresAt", "resolvedAt"
       ) values (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, 1, 'merchant-1', 'shop.example.com', $10,
         $11::jsonb, ARRAY['TRANSACTION_LIMIT_EXCEEDED'], 1000, 'USD', $12::"ApprovalStatus", 2,
         $13::jsonb, $14, $15, $16
       )`,
      [
        spec.id,
        ids.organizationId,
        ids.userId,
        ids.agentId,
        ids.mandateId,
        randomUUID(),
        randomUUID(),
        `ops-approval-idempotency-${spec.id}`,
        `ops-approval-digest-${spec.id}`,
        `approval-checkout-${index}`,
        JSON.stringify({ token: `approval-secret-${index}` }),
        spec.status,
        spec.notification ? JSON.stringify({ notification: spec.notification }) : null,
        spec.createdAt,
        spec.expiresAt,
        spec.status === "PENDING" ? null : new Date(spec.createdAt.getTime() + 60_000),
      ],
    );
  }

  const reservationStatuses = ["RESERVED", "COMMITTED", "RELEASED", "EXPIRED"] as const;
  for (const [index, status] of reservationStatuses.entries()) {
    const reservedAt = new Date(now.getTime() - (index + 1) * 60_000);
    const expiresAt =
      status === "RESERVED"
        ? new Date(now.getTime() - 60_000)
        : new Date(now.getTime() + 10 * 60_000);
    await pool.query(
      `insert into "SpendReservation" (
         "id", "organizationId", "userId", "agentId", "mandateId", "idempotencyKey",
         "merchantDomain", "currency", "amountMinor", "status", "reservedAt", "expiresAt",
         "committedAt", "releasedAt"
       ) values (
         $1, $2, $3, $4, $5, $6, 'shop.example.com', 'USD', 1000,
         $7::"SpendReservationStatus", $8, $9, $10, $11
       )`,
      [
        ids.reservationIds[index],
        ids.organizationId,
        ids.userId,
        ids.agentId,
        ids.mandateId,
        `ops-reservation-idempotency-${ids.reservationIds[index]}`,
        status,
        reservedAt,
        expiresAt,
        status === "COMMITTED" ? new Date(reservedAt.getTime() + 10_000) : null,
        status === "RELEASED" ? new Date(reservedAt.getTime() + 10_000) : null,
      ],
    );
  }
}

async function cleanup(pool: Pool, organizationIds: readonly string[]): Promise<void> {
  await pool.query(`delete from "AdminAuditLog" where "organizationId" = any($1::uuid[])`, [
    organizationIds,
  ]);
  await pool.query(`delete from "AdminAuditChainHead" where "organizationId" = any($1::uuid[])`, [
    organizationIds,
  ]);
  await pool.query(`delete from "AuditLog" where "organizationId" = any($1::uuid[])`, [
    organizationIds,
  ]);
  await pool.query(`delete from "AuditChainHead" where "organizationId" = any($1::uuid[])`, [
    organizationIds,
  ]);
  await pool.query(`delete from "ApprovalRequest" where "organizationId" = any($1::uuid[])`, [
    organizationIds,
  ]);
  await pool.query(`delete from "PaymentOutcome" where "organizationId" = any($1::uuid[])`, [
    organizationIds,
  ]);
  await pool.query(`delete from "SpendReservation" where "organizationId" = any($1::uuid[])`, [
    organizationIds,
  ]);
  await pool.query(`delete from "AgentMandate" where "organizationId" = any($1::uuid[])`, [
    organizationIds,
  ]);
  await pool.query(`delete from "Policy" where "organizationId" = any($1::uuid[])`, [
    organizationIds,
  ]);
  await pool.query(`delete from "AgentIdentity" where "organizationId" = any($1::uuid[])`, [
    organizationIds,
  ]);
  await pool.query(`delete from "User" where "organizationId" = any($1::uuid[])`, [
    organizationIds,
  ]);
  await pool.query(`delete from "Organization" where "id" = any($1::uuid[])`, [organizationIds]);
}
