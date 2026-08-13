import { describe, expect, it } from "vitest";
import type { CheckoutIntent } from "../../src/domain/checkout/checkout.types.js";
import { DecisionReason } from "../../src/domain/evaluation/decision-reasons.js";
import {
  DecisionVerdict,
  type EvaluationContext,
} from "../../src/domain/evaluation/evaluation.types.js";
import {
  ApprovalMode,
  type AgentSpendMandate,
} from "../../src/domain/mandates/mandate.types.js";
import { PolicyEvaluator } from "../../src/modules/policy/policy-evaluator.js";

const NOW = new Date("2026-08-13T19:00:00.000Z");

function makeEvaluator(): PolicyEvaluator {
  const measurements = [1_000, 1_025];
  return new PolicyEvaluator({
    generateId: () => "decision-1",
    monotonicMicros: () => measurements.shift() ?? 1_025,
  });
}

function makeMandate(
  overrides: Partial<AgentSpendMandate> = {},
): AgentSpendMandate {
  return {
    id: "mandate-1",
    organizationId: "org-1",
    userId: "user-1",
    agentId: "agent-1",
    policyId: "policy-1",
    policyVersion: 7,
    currency: "USD",
    maxBudgetPerTransactionMinor: 10_000n,
    rollingDailyLimitMinor: 50_000n,
    approvedMerchantDomains: ["example.com"],
    approvedVendorIds: [],
    restrictedCategories: ["DIGITAL_GIFT_CARD", "CRYPTO", "GAMBLING"],
    approvalMode: ApprovalMode.AUTO_APPROVE,
    velocity: {
      maxTransactionsPerMinute: 10,
      crossMerchantWindowSeconds: 60,
      maxDistinctMerchantsInWindow: 5,
    },
    issuedAt: new Date("2026-08-13T18:00:00.000Z"),
    expiresAt: new Date("2026-08-13T20:00:00.000Z"),
    signingKeyId: "key-1",
    ...overrides,
  };
}

function makeCheckout(
  overrides: Partial<CheckoutIntent> = {},
): CheckoutIntent {
  return {
    requestId: "request-1",
    protocol: "ACP",
    operation: "CREATE_CHECKOUT_SESSION",
    organizationId: "org-1",
    userId: "user-1",
    agentId: "agent-1",
    merchant: { domain: "shop.example.com" },
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
    rawPayload: {},
    ...overrides,
  };
}

function makeContext(
  overrides: Partial<EvaluationContext> = {},
): EvaluationContext {
  return {
    now: NOW,
    mandate: makeMandate(),
    checkout: makeCheckout(),
    spend: {
      committedDailySpend: { currency: "USD", minorUnits: 10_000n },
      reservedDailySpend: { currency: "USD", minorUnits: 2_000n },
    },
    velocity: {
      transactionsLastMinute: 2,
      distinctMerchantsInWindow: 1,
      attemptedAmountLastMinute: { currency: "USD", minorUnits: 8_000n },
      merchantDomainsInWindow: ["shop.example.com"],
    },
    ...overrides,
  };
}

describe("PolicyEvaluator", () => {
  it("allows a compliant purchase and records policy latency", () => {
    const decision = makeEvaluator().evaluate(makeContext());

    expect(decision.verdict).toBe(DecisionVerdict.ALLOW);
    expect(decision.reasons).toEqual([DecisionReason.POLICY_ALLOW]);
    expect(decision.eligibleForDelegationAssertion).toBe(true);
    expect(decision.policyAmount).toEqual({
      currency: "USD",
      minorUnits: 5_000n,
    });
    expect(decision.evaluationLatencyMicros).toBe(25);
  });

  it("blocks an expired mandate at the exact expiration instant", () => {
    const mandate = makeMandate({ expiresAt: NOW });
    const decision = makeEvaluator().evaluate(makeContext({ mandate }));

    expect(decision.verdict).toBe(DecisionVerdict.BLOCK);
    expect(decision.reasons).toContain(DecisionReason.MANDATE_EXPIRED);
    expect(decision.eligibleForDelegationAssertion).toBe(false);
  });

  it("blocks a revoked mandate", () => {
    const mandate = makeMandate({
      revokedAt: new Date("2026-08-13T18:59:00.000Z"),
    });
    const decision = makeEvaluator().evaluate(makeContext({ mandate }));

    expect(decision.verdict).toBe(DecisionVerdict.BLOCK);
    expect(decision.reasons).toContain(DecisionReason.MANDATE_REVOKED);
  });

  it("blocks identity binding mismatches", () => {
    const checkout = makeCheckout({
      organizationId: "org-attacker",
      userId: "user-attacker",
      agentId: "agent-attacker",
    });
    const decision = makeEvaluator().evaluate(makeContext({ checkout }));

    expect(decision.verdict).toBe(DecisionVerdict.BLOCK);
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        DecisionReason.ORGANIZATION_MISMATCH,
        DecisionReason.AGENT_MISMATCH,
        DecisionReason.USER_MISMATCH,
      ]),
    );
  });

  it("accepts exact domains and true subdomains but not suffix-spoofed domains", () => {
    const allowed = makeEvaluator().evaluate(
      makeContext({ checkout: makeCheckout({ merchant: { domain: "example.com" } }) }),
    );
    expect(allowed.verdict).toBe(DecisionVerdict.ALLOW);

    const spoofed = makeEvaluator().evaluate(
      makeContext({
        checkout: makeCheckout({ merchant: { domain: "example.com.evil.test" } }),
      }),
    );
    expect(spoofed.verdict).toBe(DecisionVerdict.BLOCK);
    expect(spoofed.reasons).toContain(DecisionReason.MERCHANT_NOT_APPROVED);
  });

  it("allows an approved vendor id even when domain does not match", () => {
    const mandate = makeMandate({ approvedVendorIds: ["vendor-42"] });
    const checkout = makeCheckout({
      merchant: { domain: "vendor.invalid", vendorId: "vendor-42" },
    });
    const decision = makeEvaluator().evaluate(makeContext({ mandate, checkout }));

    expect(decision.verdict).toBe(DecisionVerdict.ALLOW);
  });

  it("fails closed when a cart category is missing", () => {
    const checkout = makeCheckout({
      cart: [
        {
          lineId: "line-1",
          name: "Unknown item",
          quantity: 1,
          unitPrice: { currency: "USD", minorUnits: 500n },
          totalPrice: { currency: "USD", minorUnits: 500n },
        },
      ],
    });
    const decision = makeEvaluator().evaluate(makeContext({ checkout }));

    expect(decision.verdict).toBe(DecisionVerdict.BLOCK);
    expect(decision.reasons).toContain(DecisionReason.CATEGORY_UNKNOWN);
  });

  it("blocks restricted categories regardless of approval mode", () => {
    const mandate = makeMandate({
      approvalMode: ApprovalMode.DUAL_SIGNATURE_SLACK,
    });
    const checkout = makeCheckout({
      cart: [
        {
          lineId: "line-1",
          name: "Gift card",
          category: "digital gift card",
          quantity: 1,
          unitPrice: { currency: "USD", minorUnits: 2_500n },
          totalPrice: { currency: "USD", minorUnits: 2_500n },
        },
      ],
    });
    const decision = makeEvaluator().evaluate(makeContext({ mandate, checkout }));

    expect(decision.verdict).toBe(DecisionVerdict.BLOCK);
    expect(decision.reasons).toContain(DecisionReason.CATEGORY_RESTRICTED);
    expect(decision.approval).toBeUndefined();
  });

  it("routes a transaction-limit breach to dual human approval", () => {
    const mandate = makeMandate({
      maxBudgetPerTransactionMinor: 10_000n,
      approvalMode: ApprovalMode.DUAL_SIGNATURE_SLACK,
    });
    const checkout = makeCheckout({
      total: { currency: "USD", minorUnits: 30_000n },
    });
    const decision = makeEvaluator().evaluate(makeContext({ mandate, checkout }));

    expect(decision.verdict).toBe(DecisionVerdict.PENDING_HUMAN_APPROVAL);
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        DecisionReason.TRANSACTION_LIMIT_EXCEEDED,
        DecisionReason.HUMAN_APPROVAL_REQUIRED,
      ]),
    );
    expect(decision.approval?.required).toBe(true);
    expect(decision.approval?.expiresAt.toISOString()).toBe(
      "2026-08-13T19:10:00.000Z",
    );
  });

  it("hard-blocks an approvable spend breach when HARD_BLOCK is configured", () => {
    const mandate = makeMandate({
      maxBudgetPerTransactionMinor: 1_000n,
      approvalMode: ApprovalMode.HARD_BLOCK,
    });
    const decision = makeEvaluator().evaluate(makeContext({ mandate }));

    expect(decision.verdict).toBe(DecisionVerdict.BLOCK);
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        DecisionReason.TRANSACTION_LIMIT_EXCEEDED,
        DecisionReason.POLICY_HARD_BLOCK,
      ]),
    );
  });

  it("includes reserved spend in the rolling daily limit", () => {
    const mandate = makeMandate({
      rollingDailyLimitMinor: 20_000n,
      approvalMode: ApprovalMode.DUAL_SIGNATURE_SLACK,
    });
    const decision = makeEvaluator().evaluate(
      makeContext({
        mandate,
        spend: {
          committedDailySpend: { currency: "USD", minorUnits: 13_000n },
          reservedDailySpend: { currency: "USD", minorUnits: 3_000n },
        },
      }),
    );

    expect(decision.verdict).toBe(DecisionVerdict.PENDING_HUMAN_APPROVAL);
    expect(decision.reasons).toContain(DecisionReason.DAILY_LIMIT_EXCEEDED);
  });

  it("allows a purchase that lands exactly on the daily limit", () => {
    const mandate = makeMandate({ rollingDailyLimitMinor: 20_000n });
    const decision = makeEvaluator().evaluate(
      makeContext({
        mandate,
        spend: {
          committedDailySpend: { currency: "USD", minorUnits: 13_000n },
          reservedDailySpend: { currency: "USD", minorUnits: 2_000n },
        },
      }),
    );

    expect(decision.verdict).toBe(DecisionVerdict.ALLOW);
  });

  it("blocks the next transaction once the per-minute velocity limit is reached", () => {
    const decision = makeEvaluator().evaluate(
      makeContext({
        velocity: {
          transactionsLastMinute: 10,
          distinctMerchantsInWindow: 1,
          attemptedAmountLastMinute: { currency: "USD", minorUnits: 5_000n },
          merchantDomainsInWindow: ["shop.example.com"],
        },
      }),
    );

    expect(decision.verdict).toBe(DecisionVerdict.BLOCK);
    expect(decision.reasons).toContain(DecisionReason.RATE_LIMIT_EXCEEDED);
  });

  it("detects a cross-merchant burst when the current merchant adds one over the limit", () => {
    const mandate = makeMandate({
      approvedMerchantDomains: [
        "example.com",
        "vendor-a.test",
        "vendor-b.test",
        "vendor-c.test",
      ],
      velocity: {
        maxTransactionsPerMinute: 10,
        crossMerchantWindowSeconds: 60,
        maxDistinctMerchantsInWindow: 3,
      },
    });
    const checkout = makeCheckout({ merchant: { domain: "vendor-c.test" } });
    const decision = makeEvaluator().evaluate(
      makeContext({
        mandate,
        checkout,
        velocity: {
          transactionsLastMinute: 3,
          distinctMerchantsInWindow: 3,
          attemptedAmountLastMinute: { currency: "USD", minorUnits: 5_000n },
          merchantDomainsInWindow: [
            "example.com",
            "vendor-a.test",
            "vendor-b.test",
          ],
        },
      }),
    );

    expect(decision.verdict).toBe(DecisionVerdict.BLOCK);
    expect(decision.reasons).toContain(DecisionReason.CROSS_MERCHANT_BURST);
  });

  it("requires an FX quote when checkout and mandate currencies differ", () => {
    const checkout = makeCheckout({
      total: { currency: "EUR", minorUnits: 5_000n },
    });
    const decision = makeEvaluator().evaluate(makeContext({ checkout }));

    expect(decision.verdict).toBe(DecisionVerdict.BLOCK);
    expect(decision.reasons).toContain(DecisionReason.FX_QUOTE_REQUIRED);
  });

  it("converts FX using integer arithmetic and conservative ceiling rounding", () => {
    const mandate = makeMandate({ maxBudgetPerTransactionMinor: 11_001n });
    const checkout = makeCheckout({
      total: { currency: "EUR", minorUnits: 10_000n },
    });
    const decision = makeEvaluator().evaluate(
      makeContext({
        mandate,
        checkout,
        fxQuote: {
          from: "EUR",
          to: "USD",
          rate: "1.10001",
          quotedAt: new Date("2026-08-13T18:59:00.000Z"),
          expiresAt: new Date("2026-08-13T19:01:00.000Z"),
          provider: "test",
        },
      }),
    );

    expect(decision.verdict).toBe(DecisionVerdict.ALLOW);
    expect(decision.policyAmount).toEqual({
      currency: "USD",
      minorUnits: 11_001n,
    });
  });

  it("supports zero-decimal source currencies such as JPY", () => {
    const checkout = makeCheckout({
      total: { currency: "JPY", minorUnits: 1_000n },
    });
    const decision = makeEvaluator().evaluate(
      makeContext({
        checkout,
        fxQuote: {
          from: "JPY",
          to: "USD",
          rate: "0.0068",
          quotedAt: new Date("2026-08-13T18:59:00.000Z"),
          expiresAt: new Date("2026-08-13T19:01:00.000Z"),
          provider: "test",
        },
      }),
    );

    expect(decision.verdict).toBe(DecisionVerdict.ALLOW);
    expect(decision.policyAmount).toEqual({
      currency: "USD",
      minorUnits: 680n,
    });
  });

  it("blocks expired FX quotes", () => {
    const checkout = makeCheckout({
      total: { currency: "EUR", minorUnits: 5_000n },
    });
    const decision = makeEvaluator().evaluate(
      makeContext({
        checkout,
        fxQuote: {
          from: "EUR",
          to: "USD",
          rate: "1.1",
          quotedAt: new Date("2026-08-13T18:00:00.000Z"),
          expiresAt: new Date("2026-08-13T18:59:59.000Z"),
          provider: "test",
        },
      }),
    );

    expect(decision.verdict).toBe(DecisionVerdict.BLOCK);
    expect(decision.reasons).toContain(DecisionReason.FX_QUOTE_EXPIRED);
  });

  it("blocks mismatched FX pairs", () => {
    const checkout = makeCheckout({
      total: { currency: "EUR", minorUnits: 5_000n },
    });
    const decision = makeEvaluator().evaluate(
      makeContext({
        checkout,
        fxQuote: {
          from: "GBP",
          to: "USD",
          rate: "1.3",
          quotedAt: new Date("2026-08-13T18:59:00.000Z"),
          expiresAt: new Date("2026-08-13T19:01:00.000Z"),
          provider: "test",
        },
      }),
    );

    expect(decision.verdict).toBe(DecisionVerdict.BLOCK);
    expect(decision.reasons).toContain(DecisionReason.FX_QUOTE_MISMATCH);
  });

  it("security failures override human-approval eligibility", () => {
    const mandate = makeMandate({
      maxBudgetPerTransactionMinor: 1_000n,
      approvalMode: ApprovalMode.DUAL_SIGNATURE_SLACK,
    });
    const checkout = makeCheckout({ merchant: { domain: "evil.test" } });
    const decision = makeEvaluator().evaluate(makeContext({ mandate, checkout }));

    expect(decision.verdict).toBe(DecisionVerdict.BLOCK);
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        DecisionReason.MERCHANT_NOT_APPROVED,
        DecisionReason.TRANSACTION_LIMIT_EXCEEDED,
      ]),
    );
    expect(decision.reasons).not.toContain(DecisionReason.HUMAN_APPROVAL_REQUIRED);
  });
});
