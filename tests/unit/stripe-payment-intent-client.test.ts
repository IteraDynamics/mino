import { describe, expect, it } from "vitest";
import { FetchStripePaymentIntentClient } from "../../src/modules/providers/stripe/stripe-payment-intent-client.js";

describe("FetchStripePaymentIntentClient", () => {
  it("confirms a PaymentIntent with server-side auth, connected-account routing, and idempotency", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), ...(init ? { init } : {}) });
      return new Response(
        JSON.stringify({
          id: "pi_test1",
          object: "payment_intent",
          amount: 5000,
          currency: "usd",
          status: "succeeded",
        }),
        { status: 200, headers: { "request-id": "req_stripe_1" } },
      );
    };
    const client = new FetchStripePaymentIntentClient({ fetchImpl });

    const response = await client.confirmPaymentIntent({
      authorization: "Bearer sk_test_example",
      accountId: "acct_123",
      paymentIntentId: "pi_test1",
      idempotencyKey: "mino-idem-1",
      paymentMethod: "pm_card_visa",
      returnUrl: "https://mino.example/return",
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
    expect(String(calls[0]?.init?.body)).toContain("payment_method=pm_card_visa");
    expect(String(calls[0]?.init?.body)).toContain(
      "return_url=https%3A%2F%2Fmino.example%2Freturn",
    );
  });

  it("retrieves a PaymentIntent without sending an execution idempotency header", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), ...(init ? { init } : {}) });
      return new Response(
        JSON.stringify({
          id: "pi_test2",
          object: "payment_intent",
          amount: 5000,
          currency: "usd",
          status: "processing",
        }),
        { status: 200 },
      );
    };
    const client = new FetchStripePaymentIntentClient({ fetchImpl });

    await client.retrievePaymentIntent({
      authorization: "Basic c2tfdGVzdF9leGFtcGxlOg==",
      accountId: "acct_456",
      paymentIntentId: "pi_test2",
    });

    expect(calls[0]?.init?.method).toBe("GET");
    expect(calls[0]?.init?.headers).toEqual({
      authorization: "Basic c2tfdGVzdF9leGFtcGxlOg==",
      "stripe-account": "acct_456",
    });
  });
});
