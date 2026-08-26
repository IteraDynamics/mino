import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AuthorizationDecision } from "../../src/domain/economic/authorization-decision.js";
import { bindEconomicIntent } from "../../src/domain/economic/canonical-economic-intent.js";
import { DecisionVerdict } from "../../src/domain/evaluation/evaluation.types.js";
import { AuthorizationGrantService } from "../../src/modules/authorization/authorization-grant.service.js";
import { normalizeStripeAuthoritativeIntent } from "../../src/modules/providers/stripe/stripe-authoritative-intent.js";
import { StripeExecutionAdapter } from "../../src/modules/providers/stripe/stripe-execution-adapter.js";
import type { StripePaymentIntentClient } from "../../src/modules/providers/stripe/stripe-payment-intent-client.js";

const NOW = new Date("2026-08-19T21:00:00.000Z");
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const MANDATE_ID = "44444444-4444-4444-8444-444444444444";
const POLICY_ID = "55555555-5555-4555-8555-555555555555";
const target = {
  id: "stripe-target-proof",
  organizationId: ORG_ID,
  domain: "supplier.example",
  accountId: "acct_123",
  expectedLivemode: false,
  active: true,
} as const;

const providerState = {
  id: "pi_proof",
  amount: 5_000n,
  currency: "USD",
  status: "requires_confirmation" as const,
  captureMethod: "automatic" as const,
  confirmationMethod: "manual" as const,
  livemode: false,
  paymentMethodId: "pm_proof",
};

function economicIntent() {
  return normalizeStripeAuthoritativeIntent({
    paymentIntent: providerState,
    target,
    requestId: "66666666-6666-4666-8666-666666666666",
    userId: USER_ID,
    agentId: AGENT_ID,
    idempotencyKey: "idem-stripe-proof",
  });
}

function allowedDecision(intentDigest: string): AuthorizationDecision {
  return {
    decisionId: "77777777-7777-4777-8777-777777777777",
    requestId: "66666666-6666-4666-8666-666666666666",
    verdict: DecisionVerdict.ALLOW,
    reasons: [],
    requestedAmount: { currency: "USD", minorUnits: 5_000n },
    policyAmount: { currency: "USD", minorUnits: 5_000n },
    approvedAmount: { currency: "USD", minorUnits: 5_000n },
    mandateId: MANDATE_ID,
    policyId: POLICY_ID,
    policyVersion: 1,
    intentDigest,
    eligibleForDelegationAssertion: true,
    evaluationLatencyMicros: 10,
    evaluatedAt: NOW,
  };
}

function stripeBody(status: "requires_confirmation" | "succeeded") {
  return {
    id: "pi_proof",
    object: "payment_intent",
    amount: 5000,
    currency: "usd",
    status,
    capture_method: "automatic",
    confirmation_method: "manual",
    livemode: false,
    payment_method: "pm_proof",
  };
}

describe("Stripe second-provider proof", () => {
  it("consumes Mino's intent-bound AuthorizationGrant directly without a Stripe-specific authorization artifact", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const grants = new AuthorizationGrantService(
      { keyId: "grant-k1", privateKey },
      () => "grant-stripe-proof",
      { issuer: "https://mino.example" },
    );
    const intent = economicIntent();
    const bound = bindEconomicIntent(intent, {
      organizationId: ORG_ID,
      userId: USER_ID,
      agentId: AGENT_ID,
      mandateId: MANDATE_ID,
      policyId: POLICY_ID,
      policyVersion: 1,
    });
    const decision = allowedDecision(bound.intentDigest);
    const grant = grants.issue(intent, decision, NOW);

    let confirmations = 0;
    const client: StripePaymentIntentClient = {
      async retrievePaymentIntent() {
        return { status: 200, body: stripeBody("requires_confirmation") };
      },
      async confirmPaymentIntent() {
        confirmations += 1;
        return { status: 200, body: stripeBody("succeeded") };
      },
    };

    const result = await new StripeExecutionAdapter(client).execute({
      intent,
      decision,
      grant,
      now: NOW,
      context: {
        authorization: "Bearer sk_test_example",
        target,
        paymentIntentId: "pi_proof",
      },
    });

    expect(confirmations).toBe(1);
    expect(result.body).toMatchObject({ status: "succeeded" });
    expect(grant.claims.aud).toBe("mino:economic-execution");
    expect(grant.claims.operation).toBe("AUTHORIZE_PAYMENT");
    expect(grant.claims.intent_digest).toBe(bound.intentDigest);
    expect(grant.claims.counterparty.identifiers).toContainEqual({
      scheme: "PROVIDER_REFERENCE",
      namespace: "stripe-account",
      value: "acct_123",
    });
  });
});