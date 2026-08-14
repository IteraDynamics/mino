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

const mandate: AgentSpendMandate = {
  id: "mandate-reconciliation-hold",
  organizationId: "org-1",
  userId: "user-1",
  agentId: "agent-1",
  policyId: "policy-1",
  policyVersion: 1,
  currency: "USD",
  maxBudgetPerTransactionMinor: 10_000n,
  rollingDailyLimitMinor: 20_000n,
  approvedMerchantDomains: ["merchant.example"],
  approvedVendorIds: [],
  restrictedCategories: [],
  approvalMode: ApprovalMode.AUTO_APPROVE,
  velocity: {
    maxTransactionsPerMinute: 100,
    crossMerchantWindowSeconds: 60,
    maxDistinctMerchantsInWindow: 5,
  },
  issuedAt: new Date("2026-08-14T13:00:00.000Z"),
  expiresAt: new Date("2026-08-15T13:00:00.000Z"),
  signingKeyId: "mino-k1",
  tokenJtiHash: "b".repeat(64),
};

integration("payment reconciliation reservation hold", () => {
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

  it("extends a forwarded reservation beyond its normal authorization TTL", async () => {
    const reservedAt = new Date("2026-08-14T14:00:00.000Z");
    const service = new AuthorizationReservationService(adapter(redis), {
      reservationTtlMs: 100,
      reconciliationHoldMs: 10_000,
    });

    const result = await service.tryReserve({
      mandate,
      amount: { currency: "USD", minorUnits: 5_000n },
      merchantDomain: "merchant.example",
      requestId: "hold-request",
      reservationId: "hold-reservation",
      idempotencyKey: "hold-idempotency",
      requestDigest: "hold-digest",
      now: reservedAt,
    });

    expect(result.status).toBe(ReservationStatus.RESERVED);
    expect(
      await service.holdForReconciliation(mandate.id, "hold-reservation", reservedAt),
    ).toBe(true);

    const score = await redis.zScore(
      `mino:v1:auth:{${mandate.id}}:reservations`,
      "hold-reservation|5000",
    );
    expect(score).toBe(reservedAt.getTime() + 10_000);

    expect(
      await service.commit(
        mandate.id,
        "hold-reservation",
        new Date(reservedAt.getTime() + 1_000),
      ),
    ).toBe(true);
    expect(await redis.zCard(`mino:v1:auth:{${mandate.id}}:reservations`)).toBe(0);
    expect(await redis.zCard(`mino:v1:auth:{${mandate.id}}:committed`)).toBe(1);
  });
});
