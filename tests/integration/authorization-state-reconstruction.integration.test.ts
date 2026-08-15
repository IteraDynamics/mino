import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createClient } from "redis";
import { ApprovalMode, type AgentSpendMandate } from "../../src/domain/mandates/mandate.types.js";
import { PgSqlAdapter } from "../../src/infrastructure/postgres/pg-sql-adapter.js";
import {
  AuthorizationReservationService,
  ReservationStatus,
  type RedisScriptClient,
} from "../../src/modules/spending/authorization-reservation.service.js";
import {
  AuthorizationStateUnavailableError,
  ReconstructingAuthorizationReservations,
  RedisAuthorizationStateReconstructor,
} from "../../src/modules/spending/authorization-state-reconstruction.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const now = new Date("2026-08-15T01:30:00.000Z");

const ids = {
  organization: randomUUID(),
  user: randomUUID(),
  agent: randomUUID(),
  policy: randomUUID(),
  mandate: randomUUID(),
};

integration("Redis authorization state reconstruction", () => {
  let pool: Pool;
  let redis: ReturnType<typeof createClient>;
  let redisScripts: RedisScriptClient;
  let reconstructor: RedisAuthorizationStateReconstructor;
  let rawReservations: AuthorizationReservationService;
  let reservations: ReconstructingAuthorizationReservations;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    redis = createClient({ url: REDIS_URL });
    redis.on("error", () => undefined);
    await redis.connect();
    redisScripts = {
      eval(script, options) {
        return redis.eval(script, {
          keys: [...options.keys],
          arguments: [...options.arguments],
        });
      },
    };
  });

  beforeEach(async () => {
    await cleanup();
    await redis.flushDb();
    await seedMandate();
    reconstructor = new RedisAuthorizationStateReconstructor(new PgSqlAdapter(pool), redisScripts);
    rawReservations = new AuthorizationReservationService(redisScripts);
    reservations = new ReconstructingAuthorizationReservations(
      rawReservations,
      reconstructor,
      () => now,
    );
  });

  afterAll(async () => {
    await cleanup();
    redis.destroy();
    await pool.end();
  });

  it("rebuilds recent committed spend and unresolved holds before authorizing after a cold Redis loss", async () => {
    await seedPaymentOutcome({
      amountMinor: 6_000n,
      status: "SUCCEEDED",
      createdAt: new Date(now.getTime() - 90 * 60_000),
      resolvedAt: new Date(now.getTime() - 60 * 60_000),
      reservationId: "recovered-committed",
    });
    await seedPaymentOutcome({
      amountMinor: 3_000n,
      status: "UNKNOWN",
      createdAt: new Date(now.getTime() - 30 * 60_000),
      reservationId: "recovered-unknown",
    });

    const first = await reservations.tryReserve(reservationInput("new-1", 2_000n));
    expect(first.status).toBe(ReservationStatus.DAILY_LIMIT);
    expect(first.spend.committedDailySpend.minorUnits).toBe(6_000n);
    expect(first.spend.reservedDailySpend.minorUnits).toBe(3_000n);
    expect(await reconstructor.isMandateReady(ids.mandate)).toBe(true);

    expect(await redis.zRange(baseKey("committed"), 0, -1)).toContain(
      "recovered-committed|6000",
    );
    expect(await redis.zRange(baseKey("reservations"), 0, -1)).toContain(
      "recovered-unknown|3000",
    );

    await redis.flushDb();
    expect(await reconstructor.isMandateReady(ids.mandate)).toBe(false);

    const afterLoss = await reservations.tryReserve(reservationInput("new-2", 2_000n));
    expect(afterLoss.status).toBe(ReservationStatus.DAILY_LIMIT);
    expect(afterLoss.spend.committedDailySpend.minorUnits).toBe(6_000n);
    expect(afterLoss.spend.reservedDailySpend.minorUnits).toBe(3_000n);
    expect(await reconstructor.isMandateReady(ids.mandate)).toBe(true);
  });

  it("restores reservation detail so unresolved payments can renew their reconciliation hold", async () => {
    await seedPaymentOutcome({
      amountMinor: 3_500n,
      status: "UNKNOWN",
      createdAt: new Date(now.getTime() - 5 * 60_000),
      reservationId: "unknown-hold",
    });

    expect(await reservations.holdForReconciliation(ids.mandate, "unknown-hold", now)).toBe(true);
    const detail = JSON.parse(
      (await redis.get(`${baseKey("reservation")}:unknown-hold`)) ?? "{}",
    ) as { status?: string; reconciliation_hold?: boolean; reconstructed?: boolean };
    expect(detail.status).toBe("RESERVED");
    expect(detail.reconciliation_hold).toBe(true);
    expect(detail.reconstructed).toBe(true);
  });

  it("rebuilds recent blocked attempts from the durable audit ledger before velocity enforcement", async () => {
    await seedAuditAttempt("one.example", new Date(now.getTime() - 20_000), 1);
    await seedAuditAttempt("two.example", new Date(now.getTime() - 10_000), 2);

    const result = await reservations.tryReserve({
      ...reservationInput("velocity-3", 100n),
      merchantDomain: "merchant.example",
    });

    expect(result.status).toBe(ReservationStatus.RATE_LIMIT);
    expect(result.velocity.transactionsLastMinute).toBe(2);
  });

  it("fails closed and leaves the recovery marker absent when durable money exceeds Redis exact-integer range", async () => {
    await seedPaymentOutcome({
      amountMinor: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      status: "SUCCEEDED",
      createdAt: new Date(now.getTime() - 60_000),
      resolvedAt: new Date(now.getTime() - 30_000),
      reservationId: "unsafe-amount",
    });

    await expect(reconstructor.ensureMandateReady(ids.mandate, now)).rejects.toBeInstanceOf(
      AuthorizationStateUnavailableError,
    );
    expect(await reconstructor.isMandateReady(ids.mandate)).toBe(false);
  });

  function mandate(): AgentSpendMandate {
    return {
      id: ids.mandate,
      organizationId: ids.organization,
      userId: ids.user,
      agentId: ids.agent,
      policyId: ids.policy,
      policyVersion: 1,
      currency: "USD",
      maxBudgetPerTransactionMinor: 20_000n,
      rollingDailyLimitMinor: 10_000n,
      approvedMerchantDomains: ["merchant.example", "one.example", "two.example"],
      approvedVendorIds: [],
      restrictedCategories: [],
      approvalMode: ApprovalMode.AUTO_APPROVE,
      velocity: {
        maxTransactionsPerMinute: 2,
        crossMerchantWindowSeconds: 60,
        maxDistinctMerchantsInWindow: 10,
      },
      issuedAt: new Date(now.getTime() - 60 * 60_000),
      expiresAt: new Date(now.getTime() + 24 * 60 * 60_000),
      signingKeyId: "reconstruction-k1",
      tokenJtiHash: `reconstruction-${ids.mandate}`,
    };
  }

  function reservationInput(suffix: string, amountMinor: bigint) {
    return {
      mandate: mandate(),
      amount: { currency: "USD", minorUnits: amountMinor },
      merchantDomain: "merchant.example",
      requestId: `request-${suffix}`,
      reservationId: `reservation-${suffix}`,
      idempotencyKey: `idem-${suffix}`,
      requestDigest: `digest-${suffix}`,
      now,
    };
  }

  function baseKey(part: "committed" | "reservations" | "reservation"): string {
    return `mino:v1:auth:{${ids.mandate}}:${part}`;
  }

  async function seedMandate(): Promise<void> {
    await pool.query(
      `insert into "Organization" ("id", "name", "createdAt", "updatedAt")
       values ($1::uuid, 'Redis Recovery Org', $2, $2)`,
      [ids.organization, now],
    );
    await pool.query(
      `insert into "User" ("id", "organizationId", "email", "status", "createdAt", "updatedAt")
       values ($1::uuid, $2::uuid, $3, 'ACTIVE', $4, $4)`,
      [ids.user, ids.organization, `redis-recovery-${ids.user}@example.test`, now],
    );
    await pool.query(
      `insert into "AgentIdentity" (
         "id", "organizationId", "externalAgentId", "status", "createdAt", "updatedAt"
       ) values ($1::uuid, $2::uuid, $3, 'ACTIVE', $4, $4)`,
      [ids.agent, ids.organization, `redis-recovery-${ids.agent}`, now],
    );
    await pool.query(
      `insert into "Policy" (
         "id", "organizationId", "name", "version", "active", "baseCurrency",
         "maxBudgetMinor", "rollingDailyLimitMinor", "approvedMerchantDomains",
         "approvedVendorIds", "restrictedCategories", "approvalMode",
         "maxTransactionsPerMinute", "crossMerchantWindowSecs", "maxDistinctMerchants",
         "createdAt", "updatedAt"
       ) values (
         $1::uuid, $2::uuid, $3, 1, true, 'USD',
         20000, 10000, array['merchant.example','one.example','two.example'],
         array[]::text[], array[]::text[], 'AUTO_APPROVE',
         2, 60, 10, $4, $4
       )`,
      [ids.policy, ids.organization, `Redis Recovery ${ids.policy}`, now],
    );
    await pool.query(
      `insert into "AgentMandate" (
         "id", "organizationId", "userId", "agentId", "policyId", "tokenJtiHash",
         "policyVersion", "currency", "maxBudgetMinor", "rollingDailyLimitMinor",
         "approvedMerchantDomains", "approvedVendorIds", "restrictedCategories", "approvalMode",
         "maxTransactionsPerMinute", "crossMerchantWindowSecs", "maxDistinctMerchants",
         "delegationPayloadHash", "signingKeyId", "status", "issuedAt", "expiresAt"
       ) values (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6,
         1, 'USD', 20000, 10000,
         array['merchant.example','one.example','two.example'], array[]::text[], array[]::text[], 'AUTO_APPROVE',
         2, 60, 10, 'redis-recovery-delegation', 'reconstruction-k1', 'ACTIVE', $7, $8
       )`,
      [
        ids.mandate,
        ids.organization,
        ids.user,
        ids.agent,
        ids.policy,
        `reconstruction-${ids.mandate}`,
        new Date(now.getTime() - 60 * 60_000),
        new Date(now.getTime() + 24 * 60 * 60_000),
      ],
    );
  }

  async function seedPaymentOutcome(input: {
    amountMinor: bigint;
    status: "UNKNOWN" | "SUCCEEDED" | "FAILED_DEFINITIVE";
    createdAt: Date;
    reservationId: string;
    resolvedAt?: Date;
    merchantDomain?: string;
  }): Promise<void> {
    const id = randomUUID();
    await pool.query(
      `insert into "PaymentOutcome" (
         "id", "organizationId", "userId", "agentId", "mandateId", "reservationId",
         "idempotencyKey", "requestDigest", "merchantId", "merchantDomain", "checkoutSessionId",
         "amountMinor", "currency", "status", "forwardedAt", "resolvedAt", "createdAt", "updatedAt"
       ) values (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6,
         $7, $8, 'merchant-recovery', $9, $10,
         $11::bigint, 'USD', $12, $13, $14, $13, $15
       )`,
      [
        id,
        ids.organization,
        ids.user,
        ids.agent,
        ids.mandate,
        input.reservationId,
        `idem-${id}`,
        `digest-${id}`,
        input.merchantDomain ?? "merchant.example",
        `cs-${id}`,
        input.amountMinor.toString(10),
        input.status,
        input.createdAt,
        input.resolvedAt ?? null,
        input.resolvedAt ?? input.createdAt,
      ],
    );
  }

  async function seedAuditAttempt(
    merchantDomain: string,
    timestamp: Date,
    sequence: number,
  ): Promise<void> {
    await pool.query(
      `insert into "AuditLog" (
         "organizationId", "requestId", "decisionId", "userId", "agentId", "mandateId",
         "timestamp", "protocol", "operation", "merchantDomain", "requestedPayload",
         "decisionSnapshot", "verdict", "reasonCodes", "evaluationLatencyMicros", "requestDigest",
         "eventDigest", "chainVersion", "chainSequence", "chainDigest", "integritySignature", "signingKeyId"
       ) values (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
         $7, 'ACP', 'COMPLETE_CHECKOUT', $8, '{}'::jsonb,
         '{}'::jsonb, 'BLOCK', array['RATE_LIMIT'], 1, $9,
         $10, 1, $11::bigint, $12, $13, 'test-audit-k1'
       )`,
      [
        ids.organization,
        randomUUID(),
        randomUUID(),
        ids.user,
        ids.agent,
        ids.mandate,
        timestamp,
        merchantDomain,
        `request-digest-${sequence}`,
        `event-digest-${sequence}`,
        String(sequence),
        `chain-digest-${sequence}`,
        `signature-${sequence}`,
      ],
    );
  }

  async function cleanup(): Promise<void> {
    await pool.query('delete from "AuditLog" where "organizationId" = $1::uuid', [ids.organization]);
    await pool.query('delete from "AuditChainHead" where "organizationId" = $1::uuid', [ids.organization]);
    await pool.query('delete from "PaymentOutcome" where "organizationId" = $1::uuid', [ids.organization]);
    await pool.query('delete from "ApprovalRequest" where "organizationId" = $1::uuid', [ids.organization]);
    await pool.query('delete from "SpendReservation" where "organizationId" = $1::uuid', [ids.organization]);
    await pool.query('delete from "MerchantEndpoint" where "organizationId" = $1::uuid', [ids.organization]);
    await pool.query('delete from "AgentMandate" where "organizationId" = $1::uuid', [ids.organization]);
    await pool.query('delete from "Policy" where "organizationId" = $1::uuid', [ids.organization]);
    await pool.query('delete from "AgentIdentity" where "organizationId" = $1::uuid', [ids.organization]);
    await pool.query('delete from "User" where "organizationId" = $1::uuid', [ids.organization]);
    await pool.query('delete from "Organization" where "id" = $1::uuid', [ids.organization]);
  }
});
