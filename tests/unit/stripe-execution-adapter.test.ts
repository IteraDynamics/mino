import { describe, expect, it } from "vitest";
import type { AuthorizationDecision } from "../../src/domain/economic/authorization-decision.js";
import type { SignedAuthorizationGrant } from "../../src/domain/economic/authorization-grant.types.js";
import type { EconomicIntent } from "../../src/domain/economic/economic-intent.types.js";
import { DecisionVerdict } from "../../src/domain/evaluation/evaluation.types.js";
import { StripeExecutionAdapter } from "../../src/modules/providers/stripe/stripe-execution-adapter.js";
import type {
  StripePaymentIntentClient,
  StripeProviderResponse,
} from "../../src/modules/providers/stripe/stripe-payment-intent-client.js";

const NOW = new Date("2026-08-19T20:00:00.000Z");
const INTENT_DIGEST = "S".repeat(43);

function intent(protocol: EconomicIntent["protocol"] = "STRIPE"): EconomicIntent {
  return {
    requestId: "request-37",
    protocol,
    operation: "AUTHORIZE_PAYMENT",
    organizationId: "org-1",
    userId: "user-1",
    agentId: "agent-1",
    counterparty: {
      kind: "MERCHANT",
      identifiers: [
        { scheme: "DOMAIN", value: "supplier.example" },
        { scheme: "PROVIDER_REFERENCE", namespace: "stripe-account", value: "acct_123" },
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
    idempotencyKey: "idem-stripe-37",
    rawPayload: { payment_intent: "pi_test37" },
  };
}

function decision(intentDigest = INTENT_DIGEST): AuthorizationDecision {
  return {
    decisionId: "decision-37",
    requestId: "request-37",
    verdict: DecisionVerdict.ALLOW,
    reasons: [],
    requestedAmount: { currency: "USD", minorUnits: 5_000n },
    policyAmount: { currency: "USD", minorUnits: 5_000n },
    approvedAmount: { currency: "USD", minorUnits: 5_000n },
    mandateId: "mandate-37",
    policyId: "policy-37",
    policyVersion: 1,
    intentDigest,
    eligibleForDelegationAssertion: true,
    evaluationLatencyMicros: 10,
    evaluatedAt: NOW,
  };
}

function grant(args: { accountId?: string; amountMinor?: string; intentDigest?: string } = {}): SignedAuthorizationGrant {
  return {
    token: "header.payload.signature",
    claims: {
      iss: "https://mino.example",
      aud: "mino:economic-execution",
      sub: "agent-1",
      jti: "grant-37",
      iat: Math.floor(NOW.getTime() / 1000),
      exp: Math.floor(NOW.getTime() / 1000) + 45,
      organization_id: "org-1",
      user_id: "user-1",
      agent_id: "agent-1",
      mandate_id: "mandate-37",
      policy_id: "policy-37",
      policy_version: 1,
      decision_id: "decision-37",
      request_id: "request-37",
      operation: "AUTHORIZE_PAYMENT",
      counterparty: {
        kind: "MERCHANT",
        identifiers: [
          { scheme: "DOMAIN", value: "supplier.example" },
          {
            scheme: "PROVIDER_REFERENCE",
            namespace: "stripe-account",
            value: args.accountId ?? "acct_123",
          },
        ],
      },
      amount_minor: args.amountMinor ?? "5000",
      currency: "USD",
      idempotency_digest: "idem-digest",
      intent_digest: args.intentDigest ?? INTENT_DIGEST,
    },
  };
}

function response(status: string, amount = 5000): StripeProviderResponse {
  return {
    status: 200,
    body: {
      id: "pi_test37",
      object: "payment_intent",
      amount,
      currency: "usd",
      status,
    },
  };
}

function harness(current: StripeProviderResponse = response("requires_confirmation")) {
  let retrieves = 0;
  let confirms = 0;
  let confirmedIdempotencyKey: string | undefined;

  const client: StripePaymentIntentClient = {
    async retrievePaymentIntent() {
      retrieves += 1;
      return current;
    },
    async confirmPaymentIntent(input) {
      confirms += 1;
      confirmedIdempotencyKey = input.idempotencyKey;
      return response("succeeded");
    },
  };

  return {
    adapter: new StripeExecutionAdapter(client),
    state: () => ({ retrieves, confirms, confirmedIdempotencyKey }),
  };
}

describe("StripeExecutionAdapter", () => {
  it("preflights authorized economics and confirms the bound PaymentIntent exactly once", async () => {
    const h = harness();

    const result = await h.adapter.execute({
      intent: intent(),
      decision: decision(),
      grant: grant(),
      now: NOW,
      context: {
        authorization: "Bearer sk_test_example",
        accountId: "acct_123",
        paymentIntentId: "pi_test37",
      },
    });

    expect(result.body).toMatchObject({ id: "pi_test37", status: "succeeded" });
    expect(h.state()).toEqual({
      retrieves: 1,
      confirms: 1,
      confirmedIdempotencyKey: "idem-stripe-37",
    });
  });

  it("refuses a non-Stripe intent before provider access", async () => {
    const h = harness();

    await expect(
      h.adapter.execute({
        intent: intent("ACP"),
        decision: decision(),
        grant: grant(),
        now: NOW,
        context: {
          authorization: "Bearer sk_test_example",
          accountId: "acct_123",
          paymentIntentId: "pi_test37",
        },
      }),
    ).rejects.toThrowError("Stripe execution adapter refuses non-Stripe economic intent");
    expect(h.state().retrieves).toBe(0);
    expect(h.state().confirms).toBe(0);
  });

  it("refuses a connected account not bound by the AuthorizationGrant", async () => {
    const h = harness();

    await expect(
      h.adapter.execute({
        intent: intent(),
        decision: decision(),
        grant: grant({ accountId: "acct_other" }),
        now: NOW,
        context: {
          authorization: "Bearer sk_test_example",
          accountId: "acct_123",
          paymentIntentId: "pi_test37",
        },
      }),
    ).rejects.toThrowError("Authorization grant does not bind the Stripe connected account");
    expect(h.state().retrieves).toBe(0);
  });

  it("refuses a grant bound to a different EconomicIntent digest", async () => {
    const h = harness();

    await expect(
      h.adapter.execute({
        intent: intent(),
        decision: decision(),
        grant: grant({ intentDigest: "T".repeat(43) }),
        now: NOW,
        context: {
          authorization: "Bearer sk_test_example",
          accountId: "acct_123",
          paymentIntentId: "pi_test37",
        },
      }),
    ).rejects.toThrowError("Authorization grant does not bind to the requested Stripe execution");
    expect(h.state().retrieves).toBe(0);
  });

  it("refuses provider economics that differ from Mino's signed authorization", async () => {
    const h = harness(response("requires_confirmation", 7500));

    await expect(
      h.adapter.execute({
        intent: intent(),
        decision: decision(),
        grant: grant(),
        now: NOW,
        context: {
          authorization: "Bearer sk_test_example",
          accountId: "acct_123",
          paymentIntentId: "pi_test37",
        },
      }),
    ).rejects.toThrowError("Stripe PaymentIntent economics do not match the AuthorizationGrant");
    expect(h.state().retrieves).toBe(1);
    expect(h.state().confirms).toBe(0);
  });
});
