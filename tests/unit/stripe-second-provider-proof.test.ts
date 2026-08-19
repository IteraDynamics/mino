import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { EconomicIntent } from "../../src/domain/economic/economic-intent.types.js";
import { DecisionVerdict, type PolicyDecision } from "../../src/domain/evaluation/evaluation.types.js";
import { AuthorizationGrantService } from "../../src/modules/authorization/authorization-grant.service.js";
import { StripeExecutionAdapter } from "../../src/modules/providers/stripe/stripe-execution-adapter.js";
import type { StripePaymentIntentClient } from "../../src/modules/providers/stripe/stripe-payment-intent-client.js";

const NOW = new Date("2026-08-19T21:00:00.000Z");

function economicIntent(): EconomicIntent {
  return {
    requestId: "request-stripe-proof",
    protocol: "STRIPE",
    operation: "AUTHORIZE_PAYMENT",
    organizationId: "org-1",
    userId: "user-1",
    agentId: "agent-1",
    counterparty: {
      kind: "MERCHANT",
      identifiers: [
        { scheme: "DOMAIN", value: "supplier.example" },
        {
          scheme: "PROVIDER_REFERENCE",
          namespace: "stripe-account",
          value: "acct_123",
        },
      ],
    },
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
    idempotencyKey: "idem-stripe-proof",
    rawPayload: { payment_intent: "pi_proof" },
  };
}

function allowedDecision(): PolicyDecision {
  return {
    decisionId: "decision-stripe-proof",
    requestId: "request-stripe-proof",
    verdict: DecisionVerdict.ALLOW,
    reasons: [],
    requestedAmount: { currency: "USD", minorUnits: 5_000n },
    policyAmount: { currency: "USD", minorUnits: 5_000n },
    approvedAmount: { currency: "USD", minorUnits: 5_000n },
    mandateId: "mandate-1",
    policyId: "policy-1",
    policyVersion: 1,
    eligibleForDelegationAssertion: true,
    evaluationLatencyMicros: 10,
    evaluatedAt: NOW,
  };
}

describe("Stripe second-provider proof", () => {
  it("consumes Mino's provider-neutral AuthorizationGrant directly without a Stripe-specific authorization artifact", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const grants = new AuthorizationGrantService(
      { keyId: "grant-k1", privateKey },
      () => "grant-stripe-proof",
      { issuer: "https://mino.example" },
    );
    const intent = economicIntent();
    const decision = allowedDecision();
    const grant = grants.issue(intent, decision, NOW);

    let confirmations = 0;
    const client: StripePaymentIntentClient = {
      async retrievePaymentIntent() {
        return {
          status: 200,
          body: {
            id: "pi_proof",
            object: "payment_intent",
            amount: 5000,
            currency: "usd",
            status: "requires_confirmation",
          },
        };
      },
      async confirmPaymentIntent() {
        confirmations += 1;
        return {
          status: 200,
          body: {
            id: "pi_proof",
            object: "payment_intent",
            amount: 5000,
            currency: "usd",
            status: "succeeded",
          },
        };
      },
    };

    const result = await new StripeExecutionAdapter(client).execute({
      intent,
      decision,
      grant,
      now: NOW,
      context: {
        authorization: "Bearer sk_test_example",
        accountId: "acct_123",
        paymentIntentId: "pi_proof",
      },
    });

    expect(confirmations).toBe(1);
    expect(result.body).toMatchObject({ status: "succeeded" });
    expect(grant.claims.aud).toBe("mino:economic-execution");
    expect(grant.claims.operation).toBe("AUTHORIZE_PAYMENT");
    expect(grant.claims.counterparty.identifiers).toContainEqual({
      scheme: "PROVIDER_REFERENCE",
      namespace: "stripe-account",
      value: "acct_123",
    });
  });
});
