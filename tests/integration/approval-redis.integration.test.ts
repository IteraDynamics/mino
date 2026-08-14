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
const now = new Date("2026-08-14T16:00:00.000Z");

const mandate: AgentSpendMandate = {
  id: "mandate-approval-redis",
  organizationId: "org-approval-redis",
  userId: "user-approval-redis",
  agentId: "agent-approval-redis",
  policyId: "policy-approval-redis",
  policyVersion: 1,
  currency: "USD",
  maxBudgetPerTransactionMinor: 100_000n,
  rollingDailyLimitMinor: 1_000n,
  approvedMerchantDomains: ["merchant.example"],
  approvedVendorIds: [],
  restrictedCategories: [],
  approvalMode: ApprovalMode.DUAL_SIGNATURE_SLACK,
  velocity: {
    maxTransactionsPerMinute: 100,
    crossMerchantWindowSeconds: 60,
    maxDistinctMerchantsInWindow: 10,
  },
  issuedAt: new Date(now.getTime() - 60_000),
  expiresAt: new Date(now.getTime() + 3_600_000),
  signingKeyId: "mino-k1",
  tokenJtiHash: "b".repeat(64),
};

integration("approval-specific Redis authorization semantics", () => {
  let redis: ReturnType<typeof createClient>;
  let service: AuthorizationReservationService;

  beforeAll(async () => {
    redis = createClient({ url: REDIS_URL });
    redis.on("error", () => undefined);
    await redis.connect();
    service = new AuthorizationReservationService(adapter(redis));
  });

  beforeEach(async () => {
    await redis.flushDb();
  });

  afterAll(() => {
    redis.destroy();
  });

  it("reevaluates the same daily-limit request only when an approved override is supplied", async () => {
    const first = await service.tryReserve({
      mandate,
      amount: { currency: "USD", minorUnits: 1_500n },
      merchantDomain: "merchant.example",
      requestId: "request-daily-1",
      reservationId: "reservation-daily-1",
      idempotencyKey: "idem-daily-approval",
      requestDigest: "digest-daily-approval",
      now,
    });
    expect(first.status).toBe(ReservationStatus.DAILY_LIMIT);
    expect(first.reservationId).toBeUndefined();

    const approved = await service.tryReserve({
      mandate,
      amount: { currency: "USD", minorUnits: 1_500n },
      merchantDomain: "merchant.example",
      requestId: "request-daily-2",
      reservationId: "reservation-daily-2",
      idempotencyKey: "idem-daily-approval",
      requestDigest: "digest-daily-approval",
      now,
      allowDailyLimitOverride: true,
    });

    expect(approved.status).toBe(ReservationStatus.RESERVED);
    expect(approved.reservationId).toBe("reservation-daily-2");
    expect(approved.dailyLimitOverridden).toBe(true);
    expect(await redis.zCard(`mino:v1:auth:{${mandate.id}}:reservations`)).toBe(1);
  });

  it("releaseForApproval frees allowance and clears reservation-attempt idempotency for exact retry", async () => {
    const first = await service.tryReserve({
      mandate: { ...mandate, rollingDailyLimitMinor: 10_000n },
      amount: { currency: "USD", minorUnits: 500n },
      merchantDomain: "merchant.example",
      requestId: "request-release-1",
      reservationId: "reservation-release-1",
      idempotencyKey: "idem-release-approval",
      requestDigest: "digest-release-approval",
      now,
    });
    expect(first.status).toBe(ReservationStatus.RESERVED);

    expect(
      await service.releaseForApproval(
        mandate.id,
        "reservation-release-1",
        "idem-release-approval",
      ),
    ).toBe(true);
    expect(await redis.zCard(`mino:v1:auth:{${mandate.id}}:reservations`)).toBe(0);

    const retry = await service.tryReserve({
      mandate: { ...mandate, rollingDailyLimitMinor: 10_000n },
      amount: { currency: "USD", minorUnits: 500n },
      merchantDomain: "merchant.example",
      requestId: "request-release-2",
      reservationId: "reservation-release-2",
      idempotencyKey: "idem-release-approval",
      requestDigest: "digest-release-approval",
      now,
    });

    expect(retry.status).toBe(ReservationStatus.RESERVED);
    expect(retry.replayed).toBe(false);
    expect(retry.reservationId).toBe("reservation-release-2");
  });

  it("never lets the daily-limit override bypass machine velocity controls", async () => {
    const rateLimitedMandate: AgentSpendMandate = {
      ...mandate,
      velocity: {
        ...mandate.velocity,
        maxTransactionsPerMinute: 0,
      },
    };
    const result = await service.tryReserve({
      mandate: rateLimitedMandate,
      amount: { currency: "USD", minorUnits: 1_500n },
      merchantDomain: "merchant.example",
      requestId: "request-rate",
      reservationId: "reservation-rate",
      idempotencyKey: "idem-rate",
      requestDigest: "digest-rate",
      now,
      allowDailyLimitOverride: true,
    });

    expect(result.status).toBe(ReservationStatus.RATE_LIMIT);
    expect(result.reservationId).toBeUndefined();
  });
});

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
