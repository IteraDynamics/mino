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
  ReconstructingAuthorizationReservations,
  RedisAuthorizationStateReconstructor,
} from "../../src/modules/spending/authorization-state-reconstruction.js";
import {
  DurableSpendReservationStatus,
  PostgresSpendReservationStore,
} from "../../src/modules/spending/postgres-spend-reservation.store.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const now = new Date("2026-08-15T01:45:00.000Z");

const ids = {
  organization: randomUUID(),
  user: randomUUID(),
  agent: randomUUID(),
  policy: randomUUID(),
  mandate: randomUUID(),
};

integration("durable pre-dispatch spend reservations", () => {
  let pool: Pool;
  let redis: ReturnType<typeof createClient>;
  let redisScripts: RedisScriptClient;
  let reconstructor: RedisAuthorizationStateReconstructor;
  let durable: PostgresSpendReservationStore;
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
    const sql = new PgSqlAdapter(pool);
    reconstructor = new RedisAuthorizationStateReconstructor(sql, redisScripts);
    durable = new PostgresSpendReservationStore(sql);
    reservations = new ReconstructingAuthorizationReservations(
      new AuthorizationReservationService(redisScripts),
      reconstructor,
      () => now,
      durable,
    );
  });

  afterAll(async () => {
    await cleanup();
    redis.destroy();
    await pool.end();
  });

  it("recovers a reservation that exists before PaymentOutcome creation and keeps it in the daily limit", async () => {
    const reservationId = randomUUID();
    const first = await reservations.tryReserve(
      reservationInput({
        reservationId,
        idempotencyKey: "gap-reservation",
        amountMinor: 3_000n,
      }),
    );
    expect(first.status).toBe(ReservationStatus.RESERVED);

    const durableRow = await loadReservation(reservationId);
    expect(durableRow).toMatchObject({
      status: DurableSpendReservationStatus.RESERVED,
      amountMinor: "3000",
    });

    // Simulate a complete Redis loss in the gap before PaymentOutcome.begin().
    await redis.flushDb();
    expect(await reconstructor.isMandateReady(ids.mandate)).toBe(false);

    const second = await reservations.tryReserve(
      reservationInput({
        reservationId: randomUUID(),
        idempotencyKey: "after-gap-loss",
        amountMinor: 8_000n,
      }),
    );
    expect(second.status).toBe(ReservationStatus.DAILY_LIMIT);
    expect(second.spend.reservedDailySpend.minorUnits).toBe(3_000n);
    expect(await redis.zRange(baseKey("reservations"), 0, -1)).toContain(
      `${reservationId}|3000`,
    );
  });

  it("does not allow a committed durable reservation to regress back to reserved", async () => {
    const reservationId = randomUUID();
    const input = reservationInput({
      reservationId,
      idempotencyKey: "committed-state",
      amountMinor: 2_000n,
    });
    expect((await reservations.tryReserve(input)).status).toBe(ReservationStatus.RESERVED);
    expect(await reservations.commit(ids.mandate, reservationId, now)).toBe(true);
    expect((await loadReservation(reservationId))?.status).toBe(
      DurableSpendReservationStatus.COMMITTED,
    );

    await expect(
      durable.recordReserved({
        id: reservationId,
        organizationId: ids.organization,
        userId: ids.user,
        agentId: ids.agent,
        mandateId: ids.mandate,
        idempotencyKey: "committed-state",
        merchantDomain: "merchant.example",
        currency: "USD",
        amountMinor: 2_000n,
        reservedAt: new Date(now.getTime() + 1_000),
        expiresAt: new Date(now.getTime() + 301_000),
      }),
    ).rejects.toThrow(/conflicts with an active reservation/i);

    await redis.flushDb();
    await reconstructor.ensureMandateReady(ids.mandate, new Date(now.getTime() + 2_000));
    expect(await redis.zRange(baseKey("committed"), 0, -1)).toContain(
      `${reservationId}|2000`,
    );
  });

  it("allows an approval-released idempotency key to create a fresh durable reservation", async () => {
    const firstId = randomUUID();
    expect(
      (
        await reservations.tryReserve(
          reservationInput({
            reservationId: firstId,
            idempotencyKey: "approval-retry",
            amountMinor: 1_000n,
          }),
        )
      ).status,
    ).toBe(ReservationStatus.RESERVED);
    expect(
      await reservations.releaseForApproval(ids.mandate, firstId, "approval-retry"),
    ).toBe(true);
    expect((await loadReservation(firstId))?.status).toBe(
      DurableSpendReservationStatus.RELEASED,
    );

    const secondId = randomUUID();
    const retried = await reservations.tryReserve(
      reservationInput({
        reservationId: secondId,
        idempotencyKey: "approval-retry",
        amountMinor: 1_000n,
      }),
    );
    expect(retried.status).toBe(ReservationStatus.RESERVED);
    expect(await loadReservation(firstId)).toBeUndefined();
    expect((await loadReservation(secondId))?.status).toBe(
      DurableSpendReservationStatus.RESERVED,
    );
  });

  function reservationInput(input: {
    reservationId: string;
    idempotencyKey: string;
    amountMinor: bigint;
  }) {
    return {
      mandate: mandate(),
      amount: { currency: "USD", minorUnits: input.amountMinor },
      merchantDomain: "merchant.example",
      requestId: randomUUID(),
      reservationId: input.reservationId,
      idempotencyKey: input.idempotencyKey,
      requestDigest: `digest-${input.idempotencyKey}`,
      now,
    };
  }

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
      approvedMerchantDomains: ["merchant.example"],
      approvedVendorIds: [],
      restrictedCategories: [],
      approvalMode: ApprovalMode.AUTO_APPROVE,
      velocity: {
        maxTransactionsPerMinute: 100,
        crossMerchantWindowSeconds: 60,
        maxDistinctMerchantsInWindow: 10,
      },
      issuedAt: new Date(now.getTime() - 60_000),
      expiresAt: new Date(now.getTime() + 86_400_000),
      signingKeyId: "durable-reservation-k1",
      tokenJtiHash: `durable-reservation-${ids.mandate}`,
    };
  }

  function baseKey(part: "committed" | "reservations"): string {
    return `mino:v1:auth:{${ids.mandate}}:${part}`;
  }

  async function loadReservation(id: string): Promise<
    | { status: DurableSpendReservationStatus; amountMinor: string }
    | undefined
  > {
    const result = await pool.query<{
      status: DurableSpendReservationStatus;
      amountMinor: string;
    }>(
      `select "status", "amountMinor"::text as "amountMinor"
         from "SpendReservation"
        where "id" = $1::uuid`,
      [id],
    );
    return result.rows[0];
  }

  async function seedMandate(): Promise<void> {
    await pool.query(
      `insert into "Organization" ("id", "name", "createdAt", "updatedAt")
       values ($1::uuid, 'Durable Reservation Org', $2, $2)`,
      [ids.organization, now],
    );
    await pool.query(
      `insert into "User" ("id", "organizationId", "email", "status", "createdAt", "updatedAt")
       values ($1::uuid, $2::uuid, $3, 'ACTIVE', $4, $4)`,
      [ids.user, ids.organization, `durable-${ids.user}@example.test`, now],
    );
    await pool.query(
      `insert into "AgentIdentity" (
         "id", "organizationId", "externalAgentId", "status", "createdAt", "updatedAt"
       ) values ($1::uuid, $2::uuid, $3, 'ACTIVE', $4, $4)`,
      [ids.agent, ids.organization, `durable-${ids.agent}`, now],
    );
    await pool.query(
      `insert into "Policy" (
         "id", "organizationId", "name", "version", "active", "baseCurrency",
         "maxBudgetMinor", "rollingDailyLimitMinor", "approvedMerchantDomains",
         "approvedVendorIds", "restrictedCategories", "approvalMode",
         "maxTransactionsPerMinute", "crossMerchantWindowSecs", "maxDistinctMerchants",
         "createdAt", "updatedAt"
       ) values (
         $1::uuid, $2::uuid, $3, 1, true, 'USD', 20000, 10000,
         array['merchant.example'], array[]::text[], array[]::text[], 'AUTO_APPROVE',
         100, 60, 10, $4, $4
       )`,
      [ids.policy, ids.organization, `Durable ${ids.policy}`, now],
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
         1, 'USD', 20000, 10000, array['merchant.example'], array[]::text[], array[]::text[],
         'AUTO_APPROVE', 100, 60, 10, 'durable-delegation', 'durable-reservation-k1',
         'ACTIVE', $7, $8
       )`,
      [
        ids.mandate,
        ids.organization,
        ids.user,
        ids.agent,
        ids.policy,
        `durable-reservation-${ids.mandate}`,
        new Date(now.getTime() - 60_000),
        new Date(now.getTime() + 86_400_000),
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
