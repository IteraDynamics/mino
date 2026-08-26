import { describe, expect, it } from "vitest";
import { authorityReferenceFromMandate, bindEconomicIntent } from "../../src/domain/economic/canonical-economic-intent.js";
import type { AgentSpendMandate } from "../../src/domain/mandates/mandate.types.js";
import { ApprovalMode } from "../../src/domain/mandates/mandate.types.js";
import { normalizeStripeAuthoritativeIntent } from "../../src/modules/providers/stripe/stripe-authoritative-intent.js";
import type { NormalizedStripePaymentIntent } from "../../src/modules/providers/stripe/stripe-payment-intent.js";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";

const target = {
  id: "stripe-target-1",
  organizationId: ORG_ID,
  domain: "supplier.example",
  accountId: "acct_123",
  expectedLivemode: false,
  active: true,
} as const;

function paymentIntent(overrides: Partial<NormalizedStripePaymentIntent> = {}): NormalizedStripePaymentIntent {
  return {
    id: "pi_test51",
    amount: 125n,
    currency: "USD",
    status: "requires_confirmation",
    captureMethod: "automatic",
    confirmationMethod: "manual",
    livemode: false,
    paymentMethodId: "pm_test51",
    ...overrides,
  };
}

function paymentIntentWithoutPaymentMethod(): NormalizedStripePaymentIntent {
  const { paymentMethodId: _paymentMethodId, ...withoutPaymentMethod } = paymentIntent();
  return withoutPaymentMethod;
}

function mandate(): AgentSpendMandate {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    organizationId: ORG_ID,
    userId: USER_ID,
    agentId: AGENT_ID,
    policyId: "55555555-5555-4555-8555-555555555555",
    policyVersion: 1,
    currency: "USD",
    maxBudgetPerTransactionMinor: 500n,
    rollingDailyLimitMinor: 1_000n,
    approvedMerchantDomains: ["supplier.example"],
    approvedVendorIds: [],
    restrictedCategories: [],
    approvalMode: ApprovalMode.OWNER_APPROVAL,
    velocity: {
      maxTransactionsPerMinute: 10,
      crossMerchantWindowSeconds: 60,
      maxDistinctMerchantsInWindow: 5,
    },
    issuedAt: new Date("2026-08-26T15:00:00.000Z"),
    expiresAt: new Date("2026-09-26T15:00:00.000Z"),
    signingKeyId: "mandate-k1",
  };
}

function normalized(pi = paymentIntent()) {
  return normalizeStripeAuthoritativeIntent({
    paymentIntent: pi,
    target,
    requestId: "66666666-6666-4666-8666-666666666666",
    userId: USER_ID,
    agentId: AGENT_ID,
    idempotencyKey: "stripe-live-51",
  });
}

describe("Stripe authoritative EconomicIntent", () => {
  it("derives amount, counterparty, and source digest from provider state", () => {
    const intent = normalized();
    const bound = bindEconomicIntent(intent, authorityReferenceFromMandate(mandate()));

    expect(intent.protocol).toBe("STRIPE");
    expect(intent.operation).toBe("AUTHORIZE_PAYMENT");
    expect(intent.economicValue?.amount).toEqual({ currency: "USD", minorUnits: 125n });
    expect(intent.counterparty).toEqual({
      kind: "MERCHANT",
      identifiers: [
        { scheme: "DOMAIN", value: "supplier.example" },
        { scheme: "PROVIDER_REFERENCE", namespace: "stripe-account", value: "acct_123" },
      ],
    });
    expect(intent.authoritativeStateDigest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(bound.intentDigest).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("changes the canonical intent when an attached payment method changes", () => {
    const first = bindEconomicIntent(normalized(), authorityReferenceFromMandate(mandate()));
    const second = bindEconomicIntent(
      normalized(paymentIntent({ paymentMethodId: "pm_replaced" })),
      authorityReferenceFromMandate(mandate()),
    );

    expect(second.intentDigest).not.toBe(first.intentDigest);
  });

  it("changes the canonical intent when provider economics change", () => {
    const first = bindEconomicIntent(normalized(), authorityReferenceFromMandate(mandate()));
    const second = bindEconomicIntent(
      normalized(paymentIntent({ amount: 225n })),
      authorityReferenceFromMandate(mandate()),
    );

    expect(second.intentDigest).not.toBe(first.intentDigest);
  });

  it("rejects a live/test mode mismatch", () => {
    expect(() => normalized(paymentIntent({ livemode: true }))).toThrowError(
      "Stripe PaymentIntent live/test mode does not match the configured execution target",
    );
  });

  it("rejects manual capture so a hold cannot masquerade as completed payment", () => {
    expect(() => normalized(paymentIntent({ captureMethod: "manual" }))).toThrowError(
      "does not permit manual capture PaymentIntents",
    );
  });

  it("rejects a PaymentIntent without a pre-attached payment method", () => {
    expect(() => normalized(paymentIntentWithoutPaymentMethod())).toThrowError(
      "must already have a server-visible payment method attached",
    );
  });
});