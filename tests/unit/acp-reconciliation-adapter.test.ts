import { describe, expect, it } from "vitest";
import { PaymentOutcomeStatus, type PaymentOutcomeRecord } from "../../src/modules/payments/payment-outcome.store.js";
import { ACPReconciliationAdapter } from "../../src/modules/proxy/acp-reconciliation-adapter.js";
import type { ACPMerchantClient, MerchantEndpoint } from "../../src/modules/proxy/merchant-client.js";

const NOW = new Date("2026-08-19T13:30:00.000Z");

function outcome(): PaymentOutcomeRecord {
  return {
    id: "outcome-acp-35",
    organizationId: "org-35",
    userId: "user-35",
    agentId: "agent-35",
    mandateId: "mandate-35",
    reservationId: "reservation-35",
    idempotencyKey: "idem-35",
    requestDigest: "digest-35",
    merchantId: "merchant-35",
    merchantDomain: "supplier.example",
    checkoutSessionId: "cs_35",
    amountMinor: 5_000n,
    currency: "USD",
    status: PaymentOutcomeStatus.UNKNOWN,
    createdAt: NOW,
    updatedAt: NOW,
    reconcileAttempts: 1,
  };
}

const merchant: MerchantEndpoint = {
  id: "merchant-35",
  domain: "supplier.example",
  baseUrl: "https://supplier.example",
  active: true,
};

function checkout(status: string) {
  const base = {
    id: "cs_35",
    status,
    currency: "usd",
    line_items: [
      {
        id: "line-35",
        item: { id: "paper", name: "Paper", unit_amount: 5000 },
        quantity: 1,
        category: "OFFICE_SUPPLIES",
        totals: [{ type: "subtotal", amount: 5000 }],
      },
    ],
    totals: [
      { type: "subtotal", amount: 5000 },
      { type: "total", amount: 5000 },
    ],
  };
  return status === "completed"
    ? { ...base, order: { id: "order-35" } }
    : base;
}

function adapterFor(status: string) {
  const client: ACPMerchantClient = {
    async createCheckout() {
      throw new Error("not used");
    },
    async getCheckout() {
      return {
        status: 200,
        body: checkout(status),
        headers: {
          "request-id": "merchant-request-35",
          "set-cookie": "secret=1",
        },
      };
    },
    async completeCheckout() {
      throw new Error("not used");
    },
    async cancelCheckout() {
      throw new Error("not used");
    },
  };

  return new ACPReconciliationAdapter({
    merchants: {
      async getById(organizationId, merchantId) {
        return organizationId === "org-35" && merchantId === merchant.id
          ? merchant
          : undefined;
      },
    },
    merchantClient: client,
    credentials: {
      async getAuthorization() {
        return "Bearer provider-secret";
      },
    },
    generateRequestId: () => "reconciliation-request-35",
  });
}

describe("ACPReconciliationAdapter", () => {
  it("normalizes completed ACP state into provider-neutral success evidence", async () => {
    const observation = await adapterFor("completed").reconcile(outcome());

    expect(observation.disposition).toBe("SUCCEEDED");
    if (observation.disposition !== "SUCCEEDED") {
      throw new Error("expected success observation");
    }
    expect(observation.evidence.status).toBe(200);
    expect(observation.evidence.body).toMatchObject({
      id: "cs_35",
      status: "completed",
      order: { id: "order-35" },
    });
    expect(observation.evidence.headers).toEqual({
      "request-id": "merchant-request-35",
    });
  });

  it("normalizes canceled ACP state into definitive failure", async () => {
    const observation = await adapterFor("canceled").reconcile(outcome());
    expect(observation.disposition).toBe("FAILED_DEFINITIVE");
  });

  it("defers nonterminal ACP state without inventing a terminal outcome", async () => {
    const observation = await adapterFor("ready_for_payment").reconcile(outcome());

    expect(observation).toEqual({
      disposition: "DEFERRED",
      errorCode: "MERCHANT_CHECKOUT_NOT_TERMINAL",
      providerStatus: 200,
    });
  });

  it("fails closed when the registered merchant identity no longer matches the durable outcome", async () => {
    const adapter = new ACPReconciliationAdapter({
      merchants: {
        async getById() {
          return { ...merchant, domain: "other.example" };
        },
      },
      merchantClient: {
        async createCheckout() {
          throw new Error("not used");
        },
        async getCheckout() {
          throw new Error("must not query mismatched target");
        },
        async completeCheckout() {
          throw new Error("not used");
        },
        async cancelCheckout() {
          throw new Error("not used");
        },
      },
      credentials: {
        async getAuthorization() {
          return "Bearer provider-secret";
        },
      },
      generateRequestId: () => "reconciliation-request-35",
    });

    await expect(adapter.reconcile(outcome())).resolves.toEqual({
      disposition: "DEFERRED",
      errorCode: "MERCHANT_REGISTRY_MISMATCH",
    });
  });
});
