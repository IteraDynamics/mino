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
import { ExpiryAwareAuthorizationReservations } from "../../src/modules/spending/expiry-aware-authorization-reservations.js";
import { PostgresSpendReservationStore } from "../../src/modules/spending/postgres-spend-reservation.store.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const t0 = new Date("2026-08-15T02:00:00.000Z");

function redisAdapter(client: ReturnType<typeof createClient>): RedisScriptClient {
  return {
    eval(script, options) {
      return client.eval(script, {
        keys: [...options.keys],
        arguments: [...options.arguments],
      });
    },
  };
}

function baseMandate(id: string): AgentSpendMandate {
  return {
    id,
    organizationId: "org",
    userId: "user",
    agentId: "agent",
    policyId: "policy",
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
    issuedAt: new Date(t0.getTime() - 60_000),
    expiresAt: new Date(t0.getTime() + 86_400_000),
    signingKeyId: "expiry-replay-k1",
    tokenJtiHash: "x".repeat(64),
  };
}

integration("expired Redis reservation idempotency replay", () => {
  let redis: ReturnType<typeof createClient>;

  beforeAll(async () => {
    redis = createClient({ url: REDIS_URL });
    redis.on("error", () => undefined);
    await redis.connect();
  });

  beforeEach(async () => {
    await redis.flushDb();
  });

  afterAll(() => {
    redis.destroy();
  });

  it("replays an active reservation without creating a second hold", async () => {
    const mandate = baseMandate("expiry-active");
    const raw = new AuthorizationReservationService(redisAdapter(redis), {
      reservationTtlMs: 100,
    });
    const guarded = new ExpiryAwareAuthorizationReservations(raw, redisAdapter(redis));

    const first = await guarded.tryReserve(input(mandate, "same-key", "same-digest", "r1", t0, 1_000n));
    const firstScore = await redis.zScore(
      "mino:v1:auth:{expiry-active}:reservations",
      "r1|1000",
    );
    const retry = await guarded.tryReserve(
      input(mandate, "same-key", "same-digest", "candidate-r2", new Date(t0.getTime() + 50), 1_000n),
    );

    expect(first.status).toBe(ReservationStatus.RESERVED);
    expect(retry.status).toBe(ReservationStatus.RESERVED);
    expect(retry.reservationId).toBe("r1");
    expect(retry.replayed).toBe(true);
    expect(await redis.zCard("mino:v1:auth:{expiry-active}:reservations")).toBe(1);
    expect(await redis.zScore("mino:v1:auth:{expiry-active}:reservations", "r1|1000")).toBe(
      firstScore,
    );
  });

  it("clears an expired matching replay and creates a fresh reservation", async () => {
    const mandate = baseMandate("expiry-fresh");
    const raw = new AuthorizationReservationService(redisAdapter(redis), {
      reservationTtlMs: 50,
    });
    const guarded = new ExpiryAwareAuthorizationReservations(raw, redisAdapter(redis));

    await guarded.tryReserve(input(mandate, "same-key", "same-digest", "expired-r1", t0, 1_000n));
    const retry = await guarded.tryReserve(
      input(mandate, "same-key", "same-digest", "fresh-r2", new Date(t0.getTime() + 51), 1_000n),
    );

    expect(retry.status).toBe(ReservationStatus.RESERVED);
    expect(retry.reservationId).toBe("fresh-r2");
    expect(retry.replayed).toBe(false);
    expect(await redis.zRange("mino:v1:auth:{expiry-fresh}:reservations", 0, -1)).toEqual([
      "fresh-r2|1000",
    ]);
  });

  it("re-evaluates current spend after expiry instead of replaying an obsolete allow", async () => {
    const mandate = baseMandate("expiry-policy");
    const raw = new AuthorizationReservationService(redisAdapter(redis), {
      reservationTtlMs: 50,
    });
    const guarded = new ExpiryAwareAuthorizationReservations(raw, redisAdapter(redis));

    await guarded.tryReserve(input(mandate, "stale-key", "stale-digest", "stale-r", t0, 3_000n));
    const committed = await guarded.tryReserve(
      input(mandate, "committed-key", "committed-digest", "committed-r", t0, 8_000n),
    );
    expect(committed.status).toBe(ReservationStatus.DAILY_LIMIT);

    // Create the committed spend after releasing the stale reservation from the allowance equation.
    await redis.del("mino:v1:auth:{expiry-policy}:reservations");
    const committedReservation = await guarded.tryReserve(
      input(mandate, "committed-key-2", "committed-digest-2", "committed-r2", t0, 8_000n),
    );
    expect(committedReservation.status).toBe(ReservationStatus.RESERVED);
    expect(await guarded.commit(mandate.id, "committed-r2", t0)).toBe(true);

    const retry = await guarded.tryReserve(
      input(mandate, "stale-key", "stale-digest", "fresh-r", new Date(t0.getTime() + 51), 3_000n),
    );
    expect(retry.status).toBe(ReservationStatus.DAILY_LIMIT);
    expect(retry.replayed).toBe(false);
    expect(retry.spend.committedDailySpend.minorUnits).toBe(8_000n);
  });

  it("preserves idempotency conflict semantics after the reservation expires", async () => {
    const mandate = baseMandate("expiry-conflict");
    const raw = new AuthorizationReservationService(redisAdapter(redis), {
      reservationTtlMs: 50,
    });
    const guarded = new ExpiryAwareAuthorizationReservations(raw, redisAdapter(redis));

    await guarded.tryReserve(input(mandate, "same-key", "digest-a", "r1", t0, 1_000n));
    const changed = await guarded.tryReserve(
      input(mandate, "same-key", "digest-b", "r2", new Date(t0.getTime() + 51), 1_000n),
    );

    expect(changed.status).toBe(ReservationStatus.IDEMPOTENCY_CONFLICT);
    expect(changed.replayed).toBe(true);
  });
});

integration("durable reservation replay lifetime", () => {
  const ids = {
    organization: randomUUID(),
    user: randomUUID(),
    agent: randomUUID(),
    policy: randomUUID(),
    mandate: randomUUID(),
  };
  let pool: Pool;
  let store: PostgresSpendReservationStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    store = new PostgresSpendReservationStore(new PgSqlAdapter(pool));
    await seedControlPlane(pool, ids);
  });

  afterAll(async () => {
    await cleanupControlPlane(pool, ids.organization);
    await pool.end();
  });

  it("does not extend the durable expiry for an exact active replay", async () => {
    const reservationId = randomUUID();
    const initialExpiry = new Date(t0.getTime() + 300_000);
    const initial = await store.recordReserved({
      id: reservationId,
      organizationId: ids.organization,
      userId: ids.user,
      agentId: ids.agent,
      mandateId: ids.mandate,
      idempotencyKey: "active-replay",
      merchantDomain: "merchant.example",
      currency: "USD",
      amountMinor: 1_000n,
      reservedAt: t0,
      expiresAt: initialExpiry,
    });

    const replay = await store.recordReserved({
      id: reservationId,
      organizationId: ids.organization,
      userId: ids.user,
      agentId: ids.agent,
      mandateId: ids.mandate,
      idempotencyKey: "active-replay",
      merchantDomain: "merchant.example",
      currency: "USD",
      amountMinor: 1_000n,
      reservedAt: new Date(t0.getTime() + 60_000),
      expiresAt: new Date(t0.getTime() + 360_000),
    });

    expect(initial.reservedAt.toISOString()).toBe(t0.toISOString());
    expect(replay.reservedAt.toISOString()).toBe(t0.toISOString());
    expect(replay.expiresAt.toISOString()).toBe(initialExpiry.toISOString());
  });
});

function input(
  mandate: AgentSpendMandate,
  idempotencyKey: string,
  requestDigest: string,
  reservationId: string,
  now: Date,
  amountMinor: bigint,
) {
  return {
    mandate,
    amount: { currency: "USD", minorUnits: amountMinor },
    merchantDomain: "merchant.example",
    requestId: randomUUID(),
    reservationId,
    idempotencyKey,
    requestDigest,
    now,
  };
}

async function seedControlPlane(
  pool: Pool,
  ids: { organization: string; user: string; agent: string; policy: string; mandate: string },
): Promise<void> {
  await pool.query(
    `insert into "Organization" ("id", "name", "createdAt", "updatedAt")
     values ($1::uuid, 'Expiry Replay Org', $2, $2)`,
    [ids.organization, t0],
  );
  await pool.query(
    `insert into "User" ("id", "organizationId", "email", "status", "createdAt", "updatedAt")
     values ($1::uuid, $2::uuid, $3, 'ACTIVE', $4, $4)`,
    [ids.user, ids.organization, `expiry-${ids.user}@example.test`, t0],
  );
  await pool.query(
    `insert into "AgentIdentity" ("id", "organizationId", "externalAgentId", "status", "createdAt", "updatedAt")
     values ($1::uuid, $2::uuid, $3, 'ACTIVE', $4, $4)`,
    [ids.agent, ids.organization, `expiry-${ids.agent}`, t0],
  );
  await pool.query(
    `insert into "Policy" (
       "id", "organizationId", "name", "version", "active", "baseCurrency",
       "maxBudgetMinor", "rollingDailyLimitMinor", "approvedMerchantDomains",
       "approvedVendorIds", "restrictedCategories", "approvalMode",
       "maxTransactionsPerMinute", "crossMerchantWindowSecs", "maxDistinctMerchants",
       "createdAt", "updatedAt"
     ) values (
       $1::uuid, $2::uuid, 'Expiry Replay Policy', 1, true, 'USD',
       20000, 10000, array['merchant.example'], array[]::text[], array[]::text[], 'AUTO_APPROVE',
       100, 60, 10, $3, $3
     )`,
    [ids.policy, ids.organization, t0],
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
       1, 'USD', 20000, 10000, array['merchant.example'], array[]::text[], array[]::text[], 'AUTO_APPROVE',
       100, 60, 10, 'expiry-replay-delegation', 'expiry-replay-k1', 'ACTIVE', $7, $8
     )`,
    [
      ids.mandate,
      ids.organization,
      ids.user,
      ids.agent,
      ids.policy,
      `expiry-replay-${ids.mandate}`,
      new Date(t0.getTime() - 60_000),
      new Date(t0.getTime() + 86_400_000),
    ],
  );
}

async function cleanupControlPlane(pool: Pool, organizationId: string): Promise<void> {
  await pool.query('delete from "PaymentOutcome" where "organizationId" = $1::uuid', [organizationId]);
  await pool.query('delete from "ApprovalRequest" where "organizationId" = $1::uuid', [organizationId]);
  await pool.query('delete from "SpendReservation" where "organizationId" = $1::uuid', [organizationId]);
  await pool.query('delete from "AuditLog" where "organizationId" = $1::uuid', [organizationId]);
  await pool.query('delete from "AuditChainHead" where "organizationId" = $1::uuid', [organizationId]);
  await pool.query('delete from "MerchantEndpoint" where "organizationId" = $1::uuid', [organizationId]);
  await pool.query('delete from "AgentMandate" where "organizationId" = $1::uuid', [organizationId]);
  await pool.query('delete from "Policy" where "organizationId" = $1::uuid', [organizationId]);
  await pool.query('delete from "AgentIdentity" where "organizationId" = $1::uuid', [organizationId]);
  await pool.query('delete from "User" where "organizationId" = $1::uuid', [organizationId]);
  await pool.query('delete from "Organization" where "id" = $1::uuid', [organizationId]);
}