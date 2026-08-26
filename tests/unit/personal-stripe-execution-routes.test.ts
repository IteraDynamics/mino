import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerPersonalStripeExecutionRoutes } from "../../src/api/personal-stripe-execution.routes.js";
import { DecisionVerdict } from "../../src/domain/evaluation/evaluation.types.js";
import type { PersonalStripeConfirmInput } from "../../src/modules/personal/personal-stripe-execution.service.js";

const NOW = new Date("2026-08-26T18:00:00.000Z");
const PAYMENT_INTENT_ID = "pi_test51";

const headers = {
  "content-type": "application/json",
  "idempotency-key": "idem-route-51",
  "api-version": "2026-08-26",
  "x-mino-mandate-token": "mandate.token.signature",
  "x-mino-agent-id": "agent-1",
  "x-mino-agent-key-id": "agent-k1",
  "x-mino-agent-timestamp": "1787767200",
  "x-mino-agent-nonce": "nonce_nonce_nonce_51",
  "x-mino-agent-signature": "signature-51",
};

function allowDecision() {
  return {
    decisionId: "11111111-1111-4111-8111-111111111111",
    requestId: "22222222-2222-4222-8222-222222222222",
    verdict: DecisionVerdict.ALLOW,
    reasons: [],
    requestedAmount: { currency: "USD", minorUnits: 125n },
    policyAmount: { currency: "USD", minorUnits: 125n },
    approvedAmount: { currency: "USD", minorUnits: 125n },
    mandateId: "33333333-3333-4333-8333-333333333333",
    policyId: "44444444-4444-4444-8444-444444444444",
    policyVersion: 1,
    intentDigest: "A".repeat(43),
    eligibleForDelegationAssertion: true,
    evaluationLatencyMicros: 1,
    evaluatedAt: NOW,
  } as const;
}

describe("Personal Stripe execution route", () => {
  it("passes only the known PaymentIntent reference and an empty signed body to execution", async () => {
    const app = Fastify();
    let captured: PersonalStripeConfirmInput | undefined;
    await registerPersonalStripeExecutionRoutes(app, {
      execution: {
        async confirmPaymentIntent(input) {
          captured = input;
          return {
            decision: allowDecision(),
            paymentIntentId: PAYMENT_INTENT_ID,
            paymentOutcomeId: "55555555-5555-4555-8555-555555555555",
            upstream: {
              status: 200,
              body: { id: PAYMENT_INTENT_ID, status: "succeeded" },
            },
          };
        },
      },
      now: () => NOW,
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/personal/stripe/payment_intents/${PAYMENT_INTENT_ID}/confirm`,
      headers,
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(captured).toBeDefined();
    expect(captured?.paymentIntentId).toBe(PAYMENT_INTENT_ID);
    expect(captured?.idempotencyKey).toBe("idem-route-51");
    expect(captured?.body).toEqual({});
    expect(captured?.security.apiVersion).toBe("2026-08-26");
    expect(captured?.security.agentProof.agentId).toBe("agent-1");
    expect(JSON.stringify(captured)).not.toContain("sk_test");
    expect(response.json()).toMatchObject({
      payment_intent_id: PAYMENT_INTENT_ID,
      payment_outcome_id: "55555555-5555-4555-8555-555555555555",
      upstream: { id: PAYMENT_INTENT_ID, status: "succeeded" },
    });
    await app.close();
  });

  it("rejects agent-supplied payment fields before execution", async () => {
    const app = Fastify();
    let calls = 0;
    await registerPersonalStripeExecutionRoutes(app, {
      execution: {
        async confirmPaymentIntent() {
          calls += 1;
          return { paymentIntentId: PAYMENT_INTENT_ID };
        },
      },
      now: () => NOW,
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/personal/stripe/payment_intents/${PAYMENT_INTENT_ID}/confirm`,
      headers,
      payload: { payment_method: "pm_should_not_enter", amount: 1, stripe_secret: "sk_test_no" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "INVALID_REQUEST" });
    expect(calls).toBe(0);
    await app.close();
  });

  it("rejects malformed PaymentIntent references before execution", async () => {
    const app = Fastify();
    let calls = 0;
    await registerPersonalStripeExecutionRoutes(app, {
      execution: {
        async confirmPaymentIntent() {
          calls += 1;
          return { paymentIntentId: PAYMENT_INTENT_ID };
        },
      },
      now: () => NOW,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/personal/stripe/payment_intents/not-a-payment-intent/confirm",
      headers,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(calls).toBe(0);
    await app.close();
  });
});