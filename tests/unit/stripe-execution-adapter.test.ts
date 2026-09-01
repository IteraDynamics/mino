import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AuthorizationDecision } from "../../src/domain/economic/authorization-decision.js";
import { bindEconomicIntent } from "../../src/domain/economic/canonical-economic-intent.js";
import type { EconomicIntent } from "../../src/domain/economic/economic-intent.types.js";
import { DecisionVerdict } from "../../src/domain/evaluation/evaluation.types.js";
import { AuthorizationGrantService } from "../../src/modules/authorization/authorization-grant.service.js";
import { normalizeStripeAuthoritativeIntent } from "../../src/modules/providers/stripe/stripe-authoritative-intent.js";
import { StripeExecutionAdapter } from "../../src/modules/providers/stripe/stripe-execution-adapter.js";
import type { NormalizedStripePaymentIntent } from "../../src/modules/providers/stripe/stripe-payment-intent.js";
import type {
  StripePaymentIntentClient,
  StripeProviderResponse,
} from "../../src/modules/providers/stripe/stripe-payment-intent-client.js";

const NOW = new Date("2026-08-26T15:30:00.000Z");
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const MANDATE_ID = "44444444-4444-4444-8444-444444444444";
const POLICY_ID = "55555555-5555-4555-8555-555555555555";
const REQUEST_ID = "66666666-6666-4666-8666-666666666666";
const DECISION_ID = "77777777-7777-4777-8777-777777777777";

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
    amount: 500n,
    currency: "USD",
    status: "requires_confirmation",
    captureMethod: "automatic",
    confirmationMethod: "manual",
    livemode: false,
    paymentMethodId: "pm_original",
    ...overrides,
  };
}

function providerResponse(pi: NormalizedStripePaymentIntent): StripeProviderResponse {
  return {
    status: 200,
    body: {
      id: pi.id,
      object: "payment_intent",
      amount: Number(pi.amount),
      currency: pi.currency.toLowerCase(),
      status: pi.status,
      capture_method: pi.captureMethod,
      confirmation_method: pi.confirmationMethod,
      livemode: pi.livemode,
      payment_method: pi.paymentMethodId ?? null,
      on_behalf_of: pi.onBehalfOf ?? null,
      transfer_data: pi.transferDestination ? { destination: pi.transferDestination } : null,
      application_fee_amount:
        pi.applicationFeeAmount !== undefined ? Number(pi.applicationFeeAmount) : null,
    },
  };
}

function authorized(initial = paymentIntent()): {
  intent: EconomicIntent;
  decision: AuthorizationDecision;
  grants: AuthorizationGrantService;
} {
  const intent = normalizeStripeAuthoritativeIntent({
    paymentIntent: initial,
    target,
    requestId: REQUEST_ID,
    userId: USER_ID,
    agentId: AGENT_ID,
    idempotencyKey: "stripe-live-idem-51",
  });
  const bound = bindEconomicIntent(intent, {
    organizationId: ORG_ID,
    userId: USER_ID,
    agentId: AGENT_ID,
    mandateId: MANDATE_ID,
    policyId: POLICY_ID,
    policyVersion: 1,
  });
  const decision: AuthorizationDecision = {
    decisionId: DECISION_ID,
    requestId: REQUEST_ID,
    verdict: DecisionVerdict.ALLOW,
    reasons: [],
    requestedAmount: { currency: "USD", minorUnits: 500n },
    policyAmount: { currency: "USD", minorUnits: 500n },
    approvedAmount: { currency: "USD", minorUnits: 500n },
    mandateId: MANDATE_ID,
    policyId: POLICY_ID,
    policyVersion: 1,
    intentDigest: bound.intentDigest,
    eligibleForDelegationAssertion: true,
    evaluationLatencyMicros: 10,
    evaluatedAt: NOW,
  };
  const { privateKey } = generateKeyPairSync("ed25519");
  return {
    intent,
    decision,
    grants: new AuthorizationGrantService(
      { keyId: "grant-k1", privateKey },
      () => "grant-51",
      { issuer: "https://mino.example" },
    ),
  };
}

function harness(
  current: NormalizedStripePaymentIntent,
  confirmed: NormalizedStripePaymentIntent = paymentIntent({ status: "succeeded" }),
) {
  let retrieves = 0;
  let confirms = 0;
  let confirmedIdempotencyKey: string | undefined;

  const client: StripePaymentIntentClient = {
    async retrievePaymentIntent() {
      retrieves += 1;
      return providerResponse(current);
    },
    async confirmPaymentIntent(input) {
      confirms += 1;
      confirmedIdempotencyKey = input.idempotencyKey;
      return providerResponse(confirmed);
    },
  };

  return {
    adapter: new StripeExecutionAdapter(client),
    state: () => ({ retrieves, confirms, confirmedIdempotencyKey }),
  };
}

describe("StripeExecutionAdapter", () => {
  it("re-fetches the exact authorized PaymentIntent and confirms it once", async () => {
    const authorization = authorized();
    const h = harness(paymentIntent());
    const grant = authorization.grants.issue(authorization.intent, authorization.decision, NOW);

    const result = await h.adapter.execute({
      intent: authorization.intent,
      decision: authorization.decision,
      grant,
      now: NOW,
      context: {
        authorization: "Bearer rk_test_server_only",
        target,
        paymentIntentId: "pi_test51",
      },
    });

    expect(result.body).toMatchObject({ id: "pi_test51", status: "succeeded" });
    expect(h.state()).toEqual({
      retrieves: 1,
      confirms: 1,
      confirmedIdempotencyKey: "stripe-live-idem-51",
    });
  });

  it("refuses a non-Stripe intent before provider access", async () => {
    const authorization = authorized();
    const h = harness(paymentIntent());
    const grant = authorization.grants.issue(authorization.intent, authorization.decision, NOW);

    await expect(
      h.adapter.execute({
        intent: { ...authorization.intent, protocol: "ACP" },
        decision: authorization.decision,
        grant,
        now: NOW,
        context: {
          authorization: "Bearer rk_test_server_only",
          target,
          paymentIntentId: "pi_test51",
        },
      }),
    ).rejects.toThrowError("Stripe execution adapter refuses non-Stripe economic intent");
    expect(h.state().retrieves).toBe(0);
    expect(h.state().confirms).toBe(0);
  });

  it("refuses a configured target not bound by the AuthorizationGrant", async () => {
    const authorization = authorized();
    const h = harness(paymentIntent());
    const grant = authorization.grants.issue(authorization.intent, authorization.decision, NOW);

    await expect(
      h.adapter.execute({
        intent: authorization.intent,
        decision: authorization.decision,
        grant,
        now: NOW,
        context: {
          authorization: "Bearer rk_test_server_only",
          target: { ...target, accountId: "acct_other" },
          paymentIntentId: "pi_test51",
        },
      }),
    ).rejects.toThrowError("Authorization grant does not bind the configured Stripe execution target");
    expect(h.state().retrieves).toBe(0);
  });

  it("rejects a changed payment method after authorization before confirmation", async () => {
    const authorization = authorized();
    const h = harness(paymentIntent({ paymentMethodId: "pm_replaced" }));
    const grant = authorization.grants.issue(authorization.intent, authorization.decision, NOW);

    await expect(
      h.adapter.execute({
        intent: authorization.intent,
        decision: authorization.decision,
        grant,
        now: NOW,
        context: {
          authorization: "Bearer rk_test_server_only",
          target,
          paymentIntentId: "pi_test51",
        },
      }),
    ).rejects.toThrowError("Authoritative Stripe PaymentIntent state changed after authorization");
    expect(h.state().retrieves).toBe(1);
    expect(h.state().confirms).toBe(0);
  });

  it("rejects changed amount after authorization before confirmation", async () => {
    const authorization = authorized();
    const h = harness(paymentIntent({ amount: 750n }));
    const grant = authorization.grants.issue(authorization.intent, authorization.decision, NOW);

    await expect(
      h.adapter.execute({
        intent: authorization.intent,
        decision: authorization.decision,
        grant,
        now: NOW,
        context: {
          authorization: "Bearer rk_test_server_only",
          target,
          paymentIntentId: "pi_test51",
        },
      }),
    ).rejects.toThrowError("Stripe PaymentIntent economics do not match the AuthorizationGrant");
    expect(h.state().retrieves).toBe(1);
    expect(h.state().confirms).toBe(0);
  });

  it("rejects terminal provider evidence when payment method drifts after final preflight", async () => {
    const authorization = authorized();
    const h = harness(
      paymentIntent(),
      paymentIntent({ status: "succeeded", paymentMethodId: "pm_replaced_after_preflight" }),
    );
    const grant = authorization.grants.issue(authorization.intent, authorization.decision, NOW);

    await expect(
      h.adapter.execute({
        intent: authorization.intent,
        decision: authorization.decision,
        grant,
        now: NOW,
        context: {
          authorization: "Bearer rk_test_server_only",
          target,
          paymentIntentId: "pi_test51",
        },
      }),
    ).rejects.toThrowError("Stripe provider consequence changed after authorization");
    expect(h.state().retrieves).toBe(1);
    expect(h.state().confirms).toBe(1);
  });
});
