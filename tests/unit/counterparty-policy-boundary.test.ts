import { describe, expect, it } from "vitest";
import type { EconomicIntent } from "../../src/domain/economic/economic-intent.types.js";
import { DecisionReason } from "../../src/domain/evaluation/decision-reasons.js";
import { DecisionVerdict } from "../../src/domain/evaluation/evaluation.types.js";
import { ApprovalMode, type AgentSpendMandate } from "../../src/domain/mandates/mandate.types.js";
import { PolicyEvaluator } from "../../src/modules/policy/policy-evaluator.js";

const NOW = new Date("2026-08-18T18:00:00.000Z");

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
    approvedVendorIds: ["vendor-42"],
    restrictedCategories: ["GIFT_CARDS"],
    approvalMode: ApprovalMode.AUTO_APPROVE,
    velocity: {
      maxTransactionsPerMinute: 10,
      crossMerchantWindowSeconds: 60,
      maxDistinctMerchantsInWindow: 5,
    },
    issuedAt: new Date("2026-08-18T17:00:00.000Z"),
    expiresAt: new Date("2026-08-19T18:00:00.000Z"),
    signingKeyId: "key-1",
  };
}

function baseIntent(): Omit<EconomicIntent, "counterparty" | "merchant"> {
  return {
    requestId: "request-1",
    protocol: "CUSTOM",
    operation: "AUTHORIZE_PAYMENT",
    organizationId: "org-1",
    userId: "user-1",
    agentId: "agent-1",
    cart: [
      {
        lineId: "line-1",
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
    rawPayload: { provider: "test" },
  };
}

function evaluate(intent: EconomicIntent) {
  const measurements = [1_000, 1_025];
  return new PolicyEvaluator({
    generateId: () => "decision-1",
    monotonicMicros: () => measurements.shift() ?? 1_025,
  }).evaluate({
    now: NOW,
    mandate: mandate(),
    checkout: intent,
    spend: {
      committedDailySpend: { currency: "USD", minorUnits: 0n },
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

describe("generalized counterparty policy boundary", () => {
  it("preserves authorization meaning between legacy merchant and canonical counterparty identity", () => {
    const legacy = evaluate({
      ...baseIntent(),
      merchant: { domain: "supplier.example", vendorId: "vendor-42" },
    });
    const canonical = evaluate({
      ...baseIntent(),
      counterparty: {
        kind: "MERCHANT",
        identifiers: [
          { scheme: "DOMAIN", value: "supplier.example" },
          { scheme: "VENDOR_ID", value: "vendor-42" },
        ],
      },
    });

    expect(legacy.verdict).toBe(DecisionVerdict.ALLOW);
    expect(canonical).toEqual(legacy);
  });

  it("fails closed when canonical and legacy counterparty representations disagree", () => {
    const decision = evaluate({
      ...baseIntent(),
      counterparty: {
        kind: "MERCHANT",
        identifiers: [{ scheme: "DOMAIN", value: "other.example" }],
      },
      merchant: { domain: "supplier.example" },
    });

    expect(decision.verdict).toBe(DecisionVerdict.BLOCK);
    expect(decision.reasons).toContain(DecisionReason.MERCHANT_NOT_APPROVED);
  });

  it("fails closed for destination kinds not yet authorized by merchant-scoped mandates", () => {
    const decision = evaluate({
      ...baseIntent(),
      counterparty: {
        kind: "ACCOUNT",
        identifiers: [
          {
            scheme: "ACCOUNT_REFERENCE",
            namespace: "bank-test",
            value: "account-123",
          },
        ],
      },
    });

    expect(decision.verdict).toBe(DecisionVerdict.BLOCK);
    expect(decision.reasons).toContain(DecisionReason.MERCHANT_NOT_APPROVED);
  });
});
