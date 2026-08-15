import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { DecisionVerdict, type PolicyDecision } from "../../src/domain/evaluation/evaluation.types.js";
import { registerACPLifecycleRoutes } from "../../src/api/acp-lifecycle.routes.js";
import type {
  CheckoutLifecycleProxyService,
  MutatingCheckoutLifecycleInput,
  RetrieveCheckoutLifecycleInput,
} from "../../src/modules/proxy/checkout-lifecycle-proxy.service.js";
import { ProxyUpstreamError, type CheckoutProxyResult } from "../../src/modules/proxy/checkout-proxy.service.js";

const now = new Date("2026-08-15T03:00:00.000Z");

function decision(requestId: string): PolicyDecision {
  return {
    decisionId: `decision-${requestId}`,
    requestId,
    mandateId: "mandate-1",
    policyId: "policy-1",
    policyVersion: 1,
    verdict: DecisionVerdict.ALLOW,
    reasons: [],
    requestedAmount: { currency: "USD", minorUnits: 0n },
    policyAmount: { currency: "USD", minorUnits: 0n },
    eligibleForDelegationAssertion: false,
    evaluationLatencyMicros: 0,
    evaluatedAt: now,
  };
}

function result(requestId: string, checkoutSessionId: string): CheckoutProxyResult {
  return {
    decision: decision(requestId),
    checkoutSessionId,
    upstream: {
      status: 200,
      body: { id: checkoutSessionId, status: "not_ready" },
    },
  };
}

function baseHeaders() {
  return {
    authorization: "Bearer merchant-credential",
    "api-version": "2026-04-17",
    "x-mino-mandate-token": "m".repeat(40),
    "x-mino-agent-id": "agent-1",
    "x-mino-agent-key-id": "agent-key-1",
    "x-mino-agent-timestamp": "1786753200",
    "x-mino-agent-nonce": "nonce_1234567890123456",
    "x-mino-agent-signature": "s".repeat(48),
  };
}

function fakeLifecycleProxy() {
  const retrieveCheckout = vi.fn(async (input: RetrieveCheckoutLifecycleInput) =>
    result(input.requestId, input.checkoutSessionId),
  );
  const updateCheckout = vi.fn(async (input: MutatingCheckoutLifecycleInput) =>
    result(input.requestId, input.checkoutSessionId),
  );
  const cancelCheckout = vi.fn(async (input: MutatingCheckoutLifecycleInput) =>
    result(input.requestId, input.checkoutSessionId),
  );
  return {
    proxy: {
      retrieveCheckout,
      updateCheckout,
      cancelCheckout,
    } as unknown as CheckoutLifecycleProxyService,
    retrieveCheckout,
    updateCheckout,
    cancelCheckout,
  };
}

describe("ACP lifecycle routes", () => {
  it("accepts bodyless GET without Idempotency-Key and binds canonical null", async () => {
    const fake = fakeLifecycleProxy();
    const app = Fastify();
    await registerACPLifecycleRoutes(app, { lifecycleProxy: fake.proxy, now: () => now });

    const response = await app.inject({
      method: "GET",
      url: "/v1/acp/merchant-1/checkout_sessions/cs_1",
      headers: baseHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(fake.retrieveCheckout).toHaveBeenCalledTimes(1);
    expect(fake.retrieveCheckout.mock.calls[0]?.[0]).toMatchObject({
      merchantId: "merchant-1",
      checkoutSessionId: "cs_1",
      idempotencyKey: "",
      body: null,
      security: {
        authorization: "Bearer merchant-credential",
        apiVersion: "2026-04-17",
        agentProof: { agentId: "agent-1" },
      },
    });
    await app.close();
  });

  it("requires Idempotency-Key for update before calling the lifecycle service", async () => {
    const fake = fakeLifecycleProxy();
    const app = Fastify();
    await registerACPLifecycleRoutes(app, { lifecycleProxy: fake.proxy, now: () => now });

    const response = await app.inject({
      method: "POST",
      url: "/v1/acp/merchant-1/checkout_sessions/cs_1",
      headers: baseHeaders(),
      payload: { line_items: [] },
    });

    expect(response.statusCode).toBe(401);
    expect(fake.updateCheckout).not.toHaveBeenCalled();
    await app.close();
  });

  it("requires Idempotency-Key for cancel before calling the lifecycle service", async () => {
    const fake = fakeLifecycleProxy();
    const app = Fastify();
    await registerACPLifecycleRoutes(app, { lifecycleProxy: fake.proxy, now: () => now });

    const response = await app.inject({
      method: "POST",
      url: "/v1/acp/merchant-1/checkout_sessions/cs_1/cancel",
      headers: baseHeaders(),
      payload: {},
    });

    expect(response.statusCode).toBe(401);
    expect(fake.cancelCheckout).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects non-Bearer merchant authorization before forwarding", async () => {
    const fake = fakeLifecycleProxy();
    const app = Fastify();
    await registerACPLifecycleRoutes(app, { lifecycleProxy: fake.proxy, now: () => now });

    const response = await app.inject({
      method: "GET",
      url: "/v1/acp/merchant-1/checkout_sessions/cs_1",
      headers: { ...baseHeaders(), authorization: "Basic nope" },
    });

    expect(response.statusCode).toBe(401);
    expect(fake.retrieveCheckout).not.toHaveBeenCalled();
    await app.close();
  });

  it("maps merchant lifecycle rejection to the existing safe 502 envelope", async () => {
    const fake = fakeLifecycleProxy();
    fake.updateCheckout.mockRejectedValueOnce(new ProxyUpstreamError("merchant rejected", 409, { secret: "not echoed" }));
    const app = Fastify();
    await registerACPLifecycleRoutes(app, { lifecycleProxy: fake.proxy, now: () => now });

    const response = await app.inject({
      method: "POST",
      url: "/v1/acp/merchant-1/checkout_sessions/cs_1",
      headers: { ...baseHeaders(), "idempotency-key": "idem-1" },
      payload: { line_items: [] },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "UPSTREAM_ERROR", upstream_status: 409 });
    await app.close();
  });
});