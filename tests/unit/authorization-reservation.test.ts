import { describe, expect, it } from "vitest";
import { ApprovalMode, type AgentSpendMandate } from "../../src/domain/mandates/mandate.types.js";
import {
  AuthorizationReservationService,
  ReservationStatus,
  RESERVE_SCRIPT,
  type RedisScriptClient,
} from "../../src/modules/spending/authorization-reservation.service.js";

const mandate: AgentSpendMandate = {
  id: "mandate-1",
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
    maxTransactionsPerMinute: 10,
    crossMerchantWindowSeconds: 60,
    maxDistinctMerchantsInWindow: 3,
  },
  issuedAt: new Date("2026-08-13T18:00:00Z"),
  expiresAt: new Date("2026-08-13T20:00:00Z"),
  signingKeyId: "key-1",
  tokenJtiHash: "a".repeat(64),
};

describe("AuthorizationReservationService", () => {
  it("maps the atomic Redis result into evaluator state", async () => {
    let captured: { script: string; keys: readonly string[]; args: readonly string[] } | undefined;
    const redis: RedisScriptClient = {
      async eval(script, options) {
        captured = { script, keys: options.keys, args: options.arguments };
        return JSON.stringify({
          status: "RESERVED",
          reservation_id: "res-1",
          committed_minor: 5000,
          reserved_minor: 1000,
          transactions_last_minute: 2,
          distinct_merchants: 1,
          merchant_domains: ["merchant.example"],
          replayed: false,
        });
      },
    };

    const result = await new AuthorizationReservationService(redis).tryReserve({
      mandate,
      amount: { currency: "USD", minorUnits: 4000n },
      merchantDomain: "merchant.example",
      requestId: "req-1",
      reservationId: "res-1",
      idempotencyKey: "idem-1",
      requestDigest: "digest-1",
      now: new Date("2026-08-13T19:30:00Z"),
    });

    expect(result.status).toBe(ReservationStatus.RESERVED);
    expect(result.spend.committedDailySpend.minorUnits).toBe(5000n);
    expect(result.spend.reservedDailySpend.minorUnits).toBe(1000n);
    expect(captured?.script).toBe(RESERVE_SCRIPT);
    expect(captured?.keys[0]).toContain("{mandate-1}");
    expect(captured?.args[6]).toBe("4000");
  });

  it("rejects amounts outside the exact Lua-safe integer boundary", async () => {
    const redis: RedisScriptClient = { async eval() { throw new Error("should not execute"); } };
    const service = new AuthorizationReservationService(redis);

    await expect(
      service.tryReserve({
        mandate,
        amount: { currency: "USD", minorUnits: BigInt(Number.MAX_SAFE_INTEGER) + 1n },
        merchantDomain: "merchant.example",
        requestId: "req-1",
        reservationId: "res-1",
        idempotencyKey: "idem-1",
        requestDigest: "digest",
        now: new Date(),
      }),
    ).rejects.toThrow(/safe/i);
  });
});
