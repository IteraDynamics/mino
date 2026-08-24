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
import {
  PersonalAuthorityValidationError,
  compilePersonalAuthorityProfile,
} from "../../src/modules/personal/personal-authority-compiler.js";
import { PolicyEvaluator } from "../../src/modules/policy/policy-evaluator.js";

const NOW = new Date("2026-08-24T13:45:00.000Z");

function evaluator(): PolicyEvaluator {
  const measurements = [100, 125];
  return new PolicyEvaluator({
    generateId: () => "decision-personal-1",
    monotonicMicros: () => measurements.shift() ?? 125,
  });
}

function mandate(overrides: Partial<AgentSpendMandate> = {}): AgentSpendMandate {
  return {
    id: "mandate-personal-1",
    organizationId: "org-personal-1",
    userId: "owner-1",
    agentId: "openclaw-1",
    policyId: "policy-personal-1",
    policyVersion: 1,
    currency: "USD",
    maxBudgetPerTransactionMinor: 10_000n,
    rollingDailyLimitMinor: 30_000n,
    approvedMerchantDomains: ["amazon.com"],
    approvedVendorIds: [],
    restrictedCategories: ["GIFT_CARD"],
    approvalMode: ApprovalMode.OWNER_APPROVAL,
    velocity: {
      maxTransactionsPerMinute: 10,
      crossMerchantWindowSeconds: 60,
      maxDistinctMerchantsInWindow: 5,
    },
    issuedAt: new Date("2026-08-24T13:00:00.000Z"),
    expiresAt: new Date("2027-08-24T13:00:00.000Z"),
    signingKeyId: "mino-personal-k1",
    ...overrides,
  };
}

function checkout(overrides: Partial<CheckoutIntent> = {}): CheckoutIntent {
  return {
    requestId: "request-personal-1",
    protocol: "ACP",
    operation: "CREATE_CHECKOUT_SESSION",
    organizationId: "org-personal-1",
    userId: "owner-1",
    agentId: "openclaw-1",
    merchant: { domain: "www.amazon.com" },
    cart: [
      {
        lineId: "line-1",
        name: "Household item",
        category: "HOUSEHOLD",
        quantity: 1,
        unitPrice: { currency: "USD", minorUnits: 12_500n },
        totalPrice: { currency: "USD", minorUnits: 12_500n },
      },
    ],
    subtotal: { currency: "USD", minorUnits: 12_500n },
    total: { currency: "USD", minorUnits: 12_500n },
    idempotencyKey: "idem-personal-1",
    rawPayload: {},
    ...overrides,
  };
}

function context(
  overrides: Partial<EvaluationContext> = {},
): EvaluationContext {
  return {
    now: NOW,
    mandate: mandate(),
    checkout: checkout(),
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
    ...overrides,
  };
}

describe("Mino Personal authority", () => {
  it("compiles consumer-readable limits into the existing policy shape", () => {
    const compiled = compilePersonalAuthorityProfile({
      currency: "usd",
      perTransactionLimit: "100.00",
      dailyLimit: "300.50",
      allowedMerchantDomains: ["Amazon.COM.", "amazon.com", "instacart.com"],
      restrictedCategories: ["gift card", "CRYPTO", "gift-card"],
    });

    expect(compiled).toEqual({
      baseCurrency: "USD",
      maxBudgetMinor: "10000",
      rollingDailyLimitMinor: "30050",
      approvedMerchantDomains: ["amazon.com", "instacart.com"],
      approvedVendorIds: [],
      restrictedCategories: ["GIFT_CARD", "CRYPTO"],
      approvalMode: ApprovalMode.OWNER_APPROVAL,
      maxTransactionsPerMinute: 10,
      crossMerchantWindowSecs: 60,
      maxDistinctMerchants: 5,
    });
  });

  it("can compile a fail-closed over-limit profile without changing the core engine", () => {
    const compiled = compilePersonalAuthorityProfile({
      currency: "JPY",
      perTransactionLimit: "5000",
      dailyLimit: "10000",
      allowedMerchantDomains: ["example.jp"],
      overLimitBehavior: "BLOCK",
    });

    expect(compiled.maxBudgetMinor).toBe("5000");
    expect(compiled.approvalMode).toBe(ApprovalMode.HARD_BLOCK);
  });

  it("rejects floating-point-like or ambiguous consumer money inputs", () => {
    expect(() =>
      compilePersonalAuthorityProfile({
        currency: "USD",
        perTransactionLimit: "10.001",
        dailyLimit: "100.00",
        allowedMerchantDomains: ["example.com"],
      }),
    ).toThrow(PersonalAuthorityValidationError);

    expect(() =>
      compilePersonalAuthorityProfile({
        currency: "USD",
        perTransactionLimit: "1e2",
        dailyLimit: "100.00",
        allowedMerchantDomains: ["example.com"],
      }),
    ).toThrow(PersonalAuthorityValidationError);
  });

  it("rejects URL-shaped merchant values and inconsistent limits", () => {
    expect(() =>
      compilePersonalAuthorityProfile({
        currency: "USD",
        perTransactionLimit: "100.00",
        dailyLimit: "300.00",
        allowedMerchantDomains: ["https://amazon.com/checkout"],
      }),
    ).toThrow(PersonalAuthorityValidationError);

    expect(() =>
      compilePersonalAuthorityProfile({
        currency: "USD",
        perTransactionLimit: "500.00",
        dailyLimit: "300.00",
        allowedMerchantDomains: ["amazon.com"],
      }),
    ).toThrow(PersonalAuthorityValidationError);
  });

  it("routes a Personal soft-limit exception to exactly the human-approval path", () => {
    const decision = evaluator().evaluate(context());

    expect(decision.verdict).toBe(DecisionVerdict.PENDING_HUMAN_APPROVAL);
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        DecisionReason.TRANSACTION_LIMIT_EXCEEDED,
        DecisionReason.HUMAN_APPROVAL_REQUIRED,
      ]),
    );
    expect(decision.approval?.approvalMode).toBe(ApprovalMode.OWNER_APPROVAL);
    expect(decision.eligibleForDelegationAssertion).toBe(false);
  });

  it("does not let owner approval override a hard security boundary", () => {
    const decision = evaluator().evaluate(
      context({ checkout: checkout({ merchant: { domain: "evil.test" } }) }),
    );

    expect(decision.verdict).toBe(DecisionVerdict.BLOCK);
    expect(decision.reasons).toContain(DecisionReason.MERCHANT_NOT_APPROVED);
    expect(decision.approval).toBeUndefined();
  });
});
