import { describe, expect, it } from "vitest";
import type { PaymentOutcomeRecord } from "../../src/modules/payments/payment-outcome.store.js";
import { PaymentOutcomeStatus } from "../../src/modules/payments/payment-outcome.store.js";
import { StripeReconciliationAdapter } from "../../src/modules/providers/stripe/stripe-reconciliation-adapter.js";
import type {
  StripePaymentIntentClient,
  StripeProviderResponse,
} from "../../src/modules/providers/stripe/stripe-payment-intent-client.js";

const NOW = new Date("2026-08-19T20:30:00.000Z");

function outcome(overrides: Partial<PaymentOutcomeRecord> = {}): PaymentOutcomeRecord {
  return {
    id: "outcome-37",
    organizationId: "org-1",
    userId: "user-1",
    agentId: "agent-1",
    mandateId: "mandate-1",
    reservationId: "reservation-1",
    idempotencyKey: "idem-37",
    requestDigest: "digest-37",
    merchantId: "stripe-target-1",
    merchantDomain: "supplier.example",
    checkoutSessionId: "pi_test37",
    amountMinor: 5_000n,
    currency: "USD",
    status: PaymentOutcomeStatus.UNKNOWN,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function providerResponse(status: string, args: { amount?: number; id?: string } = {}): StripeProviderResponse {
  return {
    status: 200,
    body: {
      id: args.id ?? "pi_test37",
      object: "payment_intent",
      amount: args.amount ?? 5000,
      currency: "usd",
      status,
      client_secret: "pi_test37_secret_should_never_be_persisted",
    },
    headers: {
      "request-id": "req_stripe_reconcile_1",
      "set-cookie": "secret=1",
    },
  };
}

function adapterWith(response: StripeProviderResponse) {
  const client: StripePaymentIntentClient = {
    async confirmPaymentIntent() {
      throw new Error("confirmation is not used by reconciliation");
    },
    async retrievePaymentIntent() {
      return response;
    },
  };

  return new StripeReconciliationAdapter({
    targets: {
      async getById(organizationId, providerTargetId) {
        return organizationId === "org-1" && providerTargetId === "stripe-target-1"
          ? {
              id: "stripe-target-1",
              accountId: "acct_123",
              domain: "supplier.example",
              active: true,
            }
          : undefined;
      },
    },
    client,
    credentials: {
      async getAuthorization(organizationId, providerTargetId) {
        return organizationId === "org-1" && providerTargetId === "stripe-target-1"
          ? "Bearer sk_test_example"
          : undefined;
      },
    },
  });
}

describe("StripeReconciliationAdapter", () => {
  it("normalizes succeeded PaymentIntent state into safe provider-neutral success evidence", async () => {
    const observation = await adapterWith(providerResponse("succeeded")).reconcile(outcome());

    expect(observation.disposition).toBe("SUCCEEDED");
    if (observation.disposition !== "SUCCEEDED") {
      throw new Error("expected succeeded observation");
    }
    expect(observation.evidence.body).toEqual({
      id: "pi_test37",
      object: "payment_intent",
      amount: "5000",
      currency: "USD",
      status: "succeeded",
    });
    expect(observation.evidence.headers).toEqual({
      "request-id": "req_stripe_reconcile_1",
    });
    expect(JSON.stringify(observation.evidence)).not.toContain("client_secret");
    expect(JSON.stringify(observation.evidence)).not.toContain("set-cookie");
  });

  it("normalizes canceled PaymentIntent state into definitive failure", async () => {
    const observation = await adapterWith(providerResponse("canceled")).reconcile(outcome());
    expect(observation.disposition).toBe("FAILED_DEFINITIVE");
  });

  it("keeps processing PaymentIntent state unresolved", async () => {
    const observation = await adapterWith(providerResponse("processing")).reconcile(outcome());
    expect(observation).toEqual({
      disposition: "DEFERRED",
      errorCode: "STRIPE_PAYMENT_INTENT_NOT_TERMINAL",
      providerStatus: 200,
    });
  });

  it("fails closed when provider economics do not match the durable Mino outcome", async () => {
    const observation = await adapterWith(
      providerResponse("succeeded", { amount: 7500 }),
    ).reconcile(outcome());

    expect(observation).toEqual({
      disposition: "DEFERRED",
      errorCode: "STRIPE_PAYMENT_INTENT_ECONOMICS_MISMATCH",
      providerStatus: 200,
    });
  });
});
