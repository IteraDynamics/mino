import { describe, expect, it } from "vitest";
import { FetchStripePaymentIntentClient } from "../../src/modules/providers/stripe/stripe-payment-intent-client.js";

describe("FetchStripePaymentIntentClient", () => {
  it("confirms a preconfigured PaymentIntent with server-side auth, connected-account routing, and idempotency", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), ...(init ? { init } : {}) });
      return new Response(JSON.stringify({ id: "pi_test1", object: "payment_intent" }), {
        status: 200,
        headers: { "request-id": "req_stripe_1" },
      });
    };
    const client = new FetchStripePaymentIntentClient({ fetchImpl });

    const response = await client.confirmPaymentIntent({
      authorization: "Bearer sk_test_example",
      accountId: "acct_123",
      paymentIntentId: "pi_test1",
      idempotencyKey: "mino-idem-1",
    });

    expect(response.status).toBe(200);
    expect(response.headers).toEqual({ "request-id": "req_stripe_1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.stripe.com/v1/payment_intents/pi_test1/confirm");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.headers).toEqual({
      authorization: "Bearer sk_test_example",
      "stripe-account": "acct_123",
      "idempotency-key": "mino-idem-1",
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(calls[0]?.init?.body).toBe("");
  });

  it("supports a direct Stripe account without emitting a Stripe-Account header", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), ...(init ? { init } : {}) });
      return new Response(JSON.stringify({ id: "pi_test2", object: "payment_intent" }), {
        status: 200,
      });
    };
    const client = new FetchStripePaymentIntentClient({ fetchImpl });

    await client.retrievePaymentIntent({
      authorization: "Bearer rk_test_example",
      paymentIntentId: "pi_test2",
    });

    expect(calls[0]?.init?.method).toBe("GET");
    expect(calls[0]?.init?.headers).toEqual({
      authorization: "Bearer rk_test_example",
      "content-type": "application/x-www-form-urlencoded",
    });
  });

  it("rejects non-bearer provider authorization before network access", async () => {
    let calls = 0;
    const client = new FetchStripePaymentIntentClient({
      fetchImpl: async () => {
        calls += 1;
        return new Response(null, { status: 200 });
      },
    });

    await expect(
      client.retrievePaymentIntent({
        authorization: "Basic c2VjcmV0",
        paymentIntentId: "pi_test3",
      }),
    ).rejects.toThrowError("Stripe server-side bearer authorization is required");
    expect(calls).toBe(0);
  });
});
