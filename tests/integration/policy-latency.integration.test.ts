import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { ApprovalMode, type AgentSpendMandate } from "../../src/domain/mandates/mandate.types.js";
import type { EvaluationContext } from "../../src/domain/evaluation/evaluation.types.js";
import { PolicyEvaluator } from "../../src/modules/policy/policy-evaluator.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;

integration("PolicyEvaluator latency budget", () => {
  it("keeps p99 pure policy evaluation below the 50ms MVP budget", () => {
    const now = new Date("2026-08-13T20:00:00.000Z");
    const mandate: AgentSpendMandate = {
      id: "mandate-latency",
      organizationId: "org-1",
      userId: "user-1",
      agentId: "agent-1",
      policyId: "policy-1",
      policyVersion: 1,
      currency: "USD",
      maxBudgetPerTransactionMinor: 50_000n,
      rollingDailyLimitMinor: 100_000n,
      approvedMerchantDomains: ["merchant.example"],
      approvedVendorIds: [],
      restrictedCategories: ["DIGITAL_GIFT_CARD", "CRYPTO", "GAMBLING"],
      approvalMode: ApprovalMode.AUTO_APPROVE,
      velocity: {
        maxTransactionsPerMinute: 100,
        crossMerchantWindowSeconds: 60,
        maxDistinctMerchantsInWindow: 10,
      },
      issuedAt: new Date(now.getTime() - 60_000),
      expiresAt: new Date(now.getTime() + 600_000),
      signingKeyId: "key-1",
      tokenJtiHash: "a".repeat(64),
    };
    const context: EvaluationContext = {
      now,
      mandate,
      checkout: {
        requestId: "request-latency",
        protocol: "ACP",
        operation: "COMPLETE_CHECKOUT",
        organizationId: mandate.organizationId,
        userId: mandate.userId,
        agentId: mandate.agentId,
        merchant: { domain: "merchant.example" },
        cart: [
          {
            lineId: "line-1",
            name: "Office supplies",
            category: "OFFICE_SUPPLIES",
            quantity: 1,
            unitPrice: { currency: "USD", minorUnits: 2_500n },
            totalPrice: { currency: "USD", minorUnits: 2_500n },
          },
        ],
        subtotal: { currency: "USD", minorUnits: 2_500n },
        total: { currency: "USD", minorUnits: 2_500n },
        idempotencyKey: "idem-latency",
        rawPayload: {},
      },
      spend: {
        committedDailySpend: { currency: "USD", minorUnits: 10_000n },
        reservedDailySpend: { currency: "USD", minorUnits: 5_000n },
      },
      velocity: {
        transactionsLastMinute: 4,
        distinctMerchantsInWindow: 1,
        attemptedAmountLastMinute: { currency: "USD", minorUnits: 7_500n },
        merchantDomainsInWindow: ["merchant.example"],
      },
    };

    let ids = 0;
    const evaluator = new PolicyEvaluator({
      generateId: () => `decision-${++ids}`,
      monotonicMicros: () => performance.now() * 1000,
    });

    // Warm the runtime before recording samples.
    for (let i = 0; i < 500; i += 1) {
      evaluator.evaluate(context);
    }

    const samples: number[] = [];
    for (let i = 0; i < 5_000; i += 1) {
      const started = performance.now();
      evaluator.evaluate(context);
      samples.push(performance.now() - started);
    }

    samples.sort((a, b) => a - b);
    const p99 = samples[Math.floor(samples.length * 0.99)] ?? Number.POSITIVE_INFINITY;
    expect(p99).toBeLessThan(50);
  });
});
