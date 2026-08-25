import { describe, expect, it } from "vitest";
import type { CheckoutIntent } from "../../src/domain/checkout/checkout.types.js";
import type { EconomicIntent } from "../../src/domain/economic/economic-intent.types.js";
import { DecisionVerdict } from "../../src/domain/evaluation/evaluation.types.js";
import { ApprovalMode, type AgentSpendMandate } from "../../src/domain/mandates/mandate.types.js";
import { PolicyEvaluator } from "../../src/modules/policy/policy-evaluator.js";

const NOW = new Date("2026-08-18T17:00:00.000Z");

function mandate(): AgentSpendMandate {
  return {
    id: "mandate-1",
    organizationId: "org-1",
    userId: "user-1",
    agentId: "agent-1",
    policyId: "policy-1",
    policyVersion: 1,
    currency: "USD",
    maxBudgetPerTransactionMinor: 10_000n,
    rollingDailyLimitMinor: 50_000n,
    approvedMerchantDomains: ["supplier.example"],
    approvedVendorIds: [],
    restrictedCategories: ["GIFT_CARDS"],
    approvalMode: ApprovalMode.AUTO_APPROVE,
    velocity: {
      maxTransactionsPerMinute: 10,
      crossMerchantWindowSeconds: 60,
      maxDistinctMerchantsInWindow: 5,
    },
    issuedAt: new Date("2026-08-18T16:00:00.000Z"),
    expiresAt: new Date("2026-08-19T17:00:00.000Z"),
    signingKeyId: "key-1",
  };
}

function economicIntent(
  protocol: EconomicIntent["protocol"],
  rawPayload: unknown,
): CheckoutIntent {
  return {
    requestId: "request-1",
    protocol,
    operation: "COMPLETE_CHECKOUT",
    organizationId: "org-1",
    userId: "user-1",
    agentId: "agent-1",
    merchant: { domain: "supplier.example" },
    cart: [
      {
        lineId: "line-1",
        productId: "paper",
        name: "Printer paper",
        category: "OFFICE_SUPPLIES",
        quantity: 1,
        unitPrice: { currency: "USD", minorUnits: 5_000n },
        totalPrice: { currency: "USD", minorUnits: 5_000n },
      },
    ],
    subtotal: { currency: "USD", minorUnits: 5_000n },
    total: { currency: "USD", minorUnits: 5_000n },
    idempotencyKey: "idem-1",
    rawPayload,
  };
}

function evaluate(intent: EconomicIntent) {
  const measurements = [1_000, 1_025];
  const evaluator = new PolicyEvaluator({
    generateId: () => "decision-1",
    monotonicMicros: () => measurements.shift() ?? 1_025,
  });

  return evaluator.evaluate({
    now: NOW,
    mandate: mandate(),
    checkout: intent,
    spend: {
      committedDailySpend: { currency: "USD", minorUnits: 1_000n },
      reservedDailySpend: { currency: "USD", minorUnits: 0n },
    },
    velocity: {
      transactionsLastMinute: 0,
      distinctMerchantsInWindow: 0,
      attemptedAmountLastMinute: { currency: "USD", minorUnits: 0n },
      merchantDomainsInWindow: [],
    },
  });
}

describe("EconomicIntent provider independence", () => {
  it("keeps policy meaning identical when only provider provenance changes", () => {
    const acp = evaluate(
      economicIntent("ACP", {
        id: "cs_1",
        provider_shape: "acp",
      }),
    );
    const stripe = evaluate(
      economicIntent("STRIPE", {
        id: "pi_1",
        provider_shape: "stripe",
      }),
    );

    expect(acp.verdict).toBe(DecisionVerdict.ALLOW);
    expect(stripe).toEqual(acp);
  });

  it("still changes policy meaning when normalized economic facts change", () => {
    const allowed = evaluate(economicIntent("ACP", { id: "cs_1" }));
    const restricted: CheckoutIntent = {
      ...economicIntent("CUSTOM", { arbitrary: true }),
      cart: [
        {
          lineId: "line-1",
          productId: "gift-card",
          name: "Gift card",
          category: "GIFT_CARDS",
          quantity: 1,
          unitPrice: { currency: "USD", minorUnits: 5_000n },
          totalPrice: { currency: "USD", minorUnits: 5_000n },
        },
      ],
    };

    expect(allowed.verdict).toBe(DecisionVerdict.ALLOW);
    expect(evaluate(restricted).verdict).toBe(DecisionVerdict.BLOCK);
  });
});
