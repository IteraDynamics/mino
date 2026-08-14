import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createClient } from "redis";
import { ApprovalMode, type AgentSpendMandate } from "../../src/domain/mandates/mandate.types.js";
import {
  AuthorizationReservationService,
  ReservationStatus,
  type RedisScriptClient,
} from "../../src/modules/spending/authorization-reservation.service.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

const baseMandate: AgentSpendMandate = {
  id: "mandate-concurrency",
  organizationId: "org-1",
  userId: "user-1",
  agentId: "agent-1",
  policyId: "policy-1",
  policyVersion: 1,
  currency: "USD",
  maxBudgetPerTransactionMinor: 100_000n,
  rollingDailyLimitMinor: 10_000n,
  approvedMerchantDomains: ["merchant.example"],
  approvedVendorIds: [],
  restrictedCategories: [],
  approvalMode: ApprovalMode.AUTO_APPROVE,
  velocity: {
    maxTransactionsPerMinute: 10_000,
    crossMerchantWindowSeconds: 60,
    maxDistinctMerchantsInWindow: 10_000,
  },
  issuedAt: new Date("2026-08-13T18:00:00Z"),
  expiresAt: new Date("2026-08-14T18:00:00Z"),
  signingKeyId: "mandate-key-1",
  tokenJtiHash: "a".repeat(64),
};

function adapter(client: ReturnType<typeof createClient>): RedisScriptClient {
  return {
    eval(script, options) {
      return client.eval(script, {
        keys: [...options.keys],
        arguments: [...options.arguments],
      });
    },
  };
}

function mandate(overrides: Partial<AgentSpendMandate> = {}): AgentSpendMandate {
  return { ...baseMandate, ...overrides };
}

integration("AuthorizationReservationService against real Redis", () => {
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

  it("never oversubscribes the rolling allowance under 50 simultaneous purchase attempts", async () => {
    const service = new AuthorizationReservationService(adapter(redis));
    const now = new Date("2026-08-13T20:00:00.000Z");

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        service.tryReserve({
          mandate: baseMandate,
          amount: { currency: "USD", minorUnits: 500n },
          merchantDomain: "merchant.example",
          requestId: `request-${index}`,
          reservationId: `reservation-${index}`,
          idempotencyKey: `idempotency-${index}`,
          requestDigest: `digest-${index}`,
          now,
        }),
      ),
    );

    const reserved = results.filter((result) => result.status === ReservationStatus.RESERVED);
    const rejected = results.filter((result) => result.status === ReservationStatus.DAILY_LIMIT);

    expect(reserved).toHaveLength(20);
    expect(rejected).toHaveLength(30);

    const members = await redis.zRange("mino:v1:auth:{mandate-concurrency}:reservations", 0, -1);
    const activeMinor = members.reduce((sum, member) => {
      const amount = member.split("|")[1];
      return sum + BigInt(amount ?? "0");
    }, 0n);

    expect(members).toHaveLength(20);
    expect(activeMinor).toBe(10_000n);
  });

  it("collapses simultaneous retries with one idempotency key into one reservation", async () => {
    const service = new AuthorizationReservationService(adapter(redis));
    const now = new Date("2026-08-13T20:00:00.000Z");

    const results = await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        service.tryReserve({
          mandate: baseMandate,
          amount: { currency: "USD", minorUnits: 1_000n },
          merchantDomain: "merchant.example",
          requestId: `retry-${index}`,
          reservationId: `candidate-${index}`,
          idempotencyKey: "same-key",
          requestDigest: "same-request-digest",
          now,
        }),
      ),
    );

    expect(results.every((result) => result.status === ReservationStatus.RESERVED)).toBe(true);
    expect(new Set(results.map((result) => result.reservationId)).size).toBe(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(24);

    const members = await redis.zRange("mino:v1:auth:{mandate-concurrency}:reservations", 0, -1);
    expect(members).toHaveLength(1);
    expect(members[0]?.endsWith("|1000")).toBe(true);
  });

  it("rejects reuse of an idempotency key for a different request digest", async () => {
    const service = new AuthorizationReservationService(adapter(redis));
    const now = new Date("2026-08-13T20:00:00.000Z");

    const first = await service.tryReserve({
      mandate: baseMandate,
      amount: { currency: "USD", minorUnits: 1_000n },
      merchantDomain: "merchant.example",
      requestId: "request-a",
      reservationId: "reservation-a",
      idempotencyKey: "conflict-key",
      requestDigest: "digest-a",
      now,
    });

    const second = await service.tryReserve({
      mandate: baseMandate,
      amount: { currency: "USD", minorUnits: 1_000n },
      merchantDomain: "merchant.example",
      requestId: "request-b",
      reservationId: "reservation-b",
      idempotencyKey: "conflict-key",
      requestDigest: "digest-b",
      now,
    });

    expect(first.status).toBe(ReservationStatus.RESERVED);
    expect(second.status).toBe(ReservationStatus.IDEMPOTENCY_CONFLICT);
    expect(second.replayed).toBe(true);
    expect(await redis.zCard("mino:v1:auth:{mandate-concurrency}:reservations")).toBe(1);
  });

  it("makes commit and release lifecycle operations idempotent", async () => {
    const service = new AuthorizationReservationService(adapter(redis));
    const now = new Date("2026-08-13T20:00:00.000Z");

    await service.tryReserve({
      mandate: baseMandate,
      amount: { currency: "USD", minorUnits: 2_000n },
      merchantDomain: "merchant.example",
      requestId: "commit-request",
      reservationId: "commit-reservation",
      idempotencyKey: "commit-idem",
      requestDigest: "commit-digest",
      now,
    });

    expect(await service.commit(baseMandate.id, "commit-reservation", now)).toBe(true);
    expect(await service.commit(baseMandate.id, "commit-reservation", now)).toBe(true);
    expect(await service.release(baseMandate.id, "commit-reservation")).toBe(false);
    expect(await redis.zCard("mino:v1:auth:{mandate-concurrency}:committed")).toBe(1);

    await service.tryReserve({
      mandate: baseMandate,
      amount: { currency: "USD", minorUnits: 1_000n },
      merchantDomain: "merchant.example",
      requestId: "release-request",
      reservationId: "release-reservation",
      idempotencyKey: "release-idem",
      requestDigest: "release-digest",
      now,
    });

    expect(await service.release(baseMandate.id, "release-reservation")).toBe(true);
    expect(await service.release(baseMandate.id, "release-reservation")).toBe(true);
  });

  it("cannot commit a reservation after its authorization TTL has expired", async () => {
    const service = new AuthorizationReservationService(adapter(redis), {
      reservationTtlMs: 50,
    });
    const reservedAt = new Date("2026-08-13T20:00:00.000Z");

    const result = await service.tryReserve({
      mandate: baseMandate,
      amount: { currency: "USD", minorUnits: 5_000n },
      merchantDomain: "merchant.example",
      requestId: "expiry-request",
      reservationId: "expiry-reservation",
      idempotencyKey: "expiry-idem",
      requestDigest: "expiry-digest",
      now: reservedAt,
    });

    expect(result.status).toBe(ReservationStatus.RESERVED);
    expect(
      await service.commit(
        baseMandate.id,
        "expiry-reservation",
        new Date(reservedAt.getTime() + 51),
      ),
    ).toBe(false);
    expect(await redis.zCard("mino:v1:auth:{mandate-concurrency}:committed")).toBe(0);

    const detail = await redis.get(
      "mino:v1:auth:{mandate-concurrency}:reservation:expiry-reservation",
    );
    expect(JSON.parse(detail ?? "{}").status).toBe("EXPIRED");
  });

  it("enforces velocity and cross-merchant burst controls atomically", async () => {
    const velocityMandate = mandate({
      id: "mandate-velocity",
      rollingDailyLimitMinor: 100_000n,
      velocity: {
        maxTransactionsPerMinute: 2,
        crossMerchantWindowSeconds: 60,
        maxDistinctMerchantsInWindow: 2,
      },
    });
    const service = new AuthorizationReservationService(adapter(redis));
    const now = new Date("2026-08-13T20:00:00.000Z");

    const first = await service.tryReserve({
      mandate: velocityMandate,
      amount: { currency: "USD", minorUnits: 100n },
      merchantDomain: "a.example",
      requestId: "v1",
      reservationId: "vr1",
      idempotencyKey: "vi1",
      requestDigest: "vd1",
      now,
    });
    const second = await service.tryReserve({
      mandate: velocityMandate,
      amount: { currency: "USD", minorUnits: 100n },
      merchantDomain: "b.example",
      requestId: "v2",
      reservationId: "vr2",
      idempotencyKey: "vi2",
      requestDigest: "vd2",
      now,
    });
    const rateLimited = await service.tryReserve({
      mandate: velocityMandate,
      amount: { currency: "USD", minorUnits: 100n },
      merchantDomain: "b.example",
      requestId: "v3",
      reservationId: "vr3",
      idempotencyKey: "vi3",
      requestDigest: "vd3",
      now,
    });

    expect(first.status).toBe(ReservationStatus.RESERVED);
    expect(second.status).toBe(ReservationStatus.RESERVED);
    expect(rateLimited.status).toBe(ReservationStatus.RATE_LIMIT);

    await redis.flushDb();
    const burstMandate = mandate({
      id: "mandate-burst",
      rollingDailyLimitMinor: 100_000n,
      velocity: {
        maxTransactionsPerMinute: 100,
        crossMerchantWindowSeconds: 60,
        maxDistinctMerchantsInWindow: 2,
      },
    });

    for (const [index, domain] of ["a.example", "b.example"].entries()) {
      const result = await service.tryReserve({
        mandate: burstMandate,
        amount: { currency: "USD", minorUnits: 100n },
        merchantDomain: domain,
        requestId: `b${index}`,
        reservationId: `br${index}`,
        idempotencyKey: `bi${index}`,
        requestDigest: `bd${index}`,
        now,
      });
      expect(result.status).toBe(ReservationStatus.RESERVED);
    }

    const burst = await service.tryReserve({
      mandate: burstMandate,
      amount: { currency: "USD", minorUnits: 100n },
      merchantDomain: "c.example",
      requestId: "b3",
      reservationId: "br3",
      idempotencyKey: "bi3",
      requestDigest: "bd3",
      now,
    });
    expect(burst.status).toBe(ReservationStatus.CROSS_MERCHANT_BURST);
  });
});
