import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createClient } from "redis";
import { ApprovalMode, type AgentSpendMandate, type MandateTokenClaims } from "../../src/domain/mandates/mandate.types.js";
import { DecisionVerdict } from "../../src/domain/evaluation/evaluation.types.js";
import { sha256Hex } from "../../src/infrastructure/crypto/canonical-json.js";
import { MandateTokenService } from "../../src/modules/mandates/mandate-token.service.js";
import { PolicyEvaluator } from "../../src/modules/policy/policy-evaluator.js";
import { ACPAdapter } from "../../src/modules/proxy/acp-adapter.js";
import {
  CheckoutProxyService,
  type CompleteCheckoutProxyInput,
} from "../../src/modules/proxy/checkout-proxy.service.js";
import type { ACPMerchantClient, MerchantEndpoint } from "../../src/modules/proxy/merchant-client.js";
import { AuthorizationReservationService, type RedisScriptClient } from "../../src/modules/spending/authorization-reservation.service.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const now = new Date("2026-08-13T20:00:00.000Z");
const nowSeconds = Math.floor(now.getTime() / 1000);

function redisAdapter(client: ReturnType<typeof createClient>): RedisScriptClient {
  return {
    eval(script, options) {
      return client.eval(script, {
        keys: [...options.keys],
        arguments: [...options.arguments],
      });
    },
  };
}

function checkoutSession(total = 5_000, category = "OFFICE_SUPPLIES") {
  return {
    id: "cs_1",
    status: "ready_for_payment",
    currency: "usd",
    line_items: [
      {
        id: "line-1",
        item: {
          id: "item-1",
          name: "Merchant authoritative item",
          unit_amount: total,
        },
        quantity: 1,
        category,
        totals: [{ type: "subtotal", amount: total }],
      },
    ],
    totals: [
      { type: "subtotal", amount: total },
      { type: "total", amount: total },
    ],
  };
}

integration("CheckoutProxyService with real Redis reservation state", () => {
  const minoKeys = generateKeyPairSync("ed25519");
  let redis: ReturnType<typeof createClient>;
  let idCounter = 0;

  beforeAll(async () => {
    redis = createClient({ url: REDIS_URL });
    redis.on("error", () => undefined);
    await redis.connect();
  });

  beforeEach(async () => {
    await redis.flushDb();
    idCounter = 0;
  });

  afterAll(() => {
    redis.destroy();
  });

  function generateId(): string {
    idCounter += 1;
    return `00000000-0000-4000-8000-${idCounter.toString().padStart(12, "0")}`;
  }

  function buildHarness(args: {
    session?: ReturnType<typeof checkoutSession>;
    mandate?: AgentSpendMandate;
    completeStatus?: number;
    throwOnComplete?: boolean;
  } = {}) {
    const jti = `proxy-integration-jti-${generateId()}`;
    const base: AgentSpendMandate = args.mandate ?? {
      id: "mandate-proxy",
      organizationId: "org-1",
      userId: "user-1",
      agentId: "agent-1",
      policyId: "policy-1",
      policyVersion: 1,
      currency: "USD",
      maxBudgetPerTransactionMinor: 10_000n,
      rollingDailyLimitMinor: 20_000n,
      approvedMerchantDomains: ["merchant.example"],
      approvedVendorIds: [],
      restrictedCategories: ["DIGITAL_GIFT_CARD"],
      approvalMode: ApprovalMode.AUTO_APPROVE,
      velocity: {
        maxTransactionsPerMinute: 20,
        crossMerchantWindowSeconds: 60,
        maxDistinctMerchantsInWindow: 5,
      },
      issuedAt: new Date((nowSeconds - 60) * 1000),
      expiresAt: new Date((nowSeconds + 600) * 1000),
      signingKeyId: "mino-k1",
    };
    const mandate: AgentSpendMandate = {
      ...base,
      tokenJtiHash: sha256Hex(jti),
    };
    const claims: MandateTokenClaims = {
      iss: "https://mino.example",
      sub: mandate.agentId,
      aud: "mino",
      jti,
      organizationId: mandate.organizationId,
      userId: mandate.userId,
      agentId: mandate.agentId,
      mandateId: mandate.id,
      policyVersion: mandate.policyVersion,
      iat: nowSeconds - 10,
      nbf: nowSeconds - 10,
      exp: nowSeconds + 300,
    };
    const tokenService = new MandateTokenService(
      {
        async resolvePublicKey(keyId) {
          return keyId === "mino-k1" ? minoKeys.publicKey : undefined;
        },
      },
      { issuer: "https://mino.example" },
    );
    const mandateToken = tokenService.issue(claims, {
      keyId: "mino-k1",
      privateKey: minoKeys.privateKey,
    });

    const merchant: MerchantEndpoint = {
      id: "merchant-1",
      domain: "merchant.example",
      baseUrl: "https://merchant.example",
      active: true,
    };
    let authoritativeSession = args.session ?? checkoutSession();
    let completeCalls = 0;
    let approvalEvents = 0;
    const audits: unknown[] = [];
    let delegationObserved = false;

    const merchantClient: ACPMerchantClient = {
      async createCheckout() {
        throw new Error("not used in completion integration tests");
      },
      async getCheckout() {
        return { status: 200, body: authoritativeSession };
      },
      async completeCheckout(_merchant, _id, _payload, headers) {
        completeCalls += 1;
        delegationObserved = typeof headers.delegationAssertion === "string";
        if (args.throwOnComplete) {
          throw new Error("simulated transport failure after dispatch");
        }
        return {
          status: args.completeStatus ?? 200,
          body: {
            ...authoritativeSession,
            status: (args.completeStatus ?? 200) < 300 ? "completed" : "ready_for_payment",
          },
        };
      },
      async cancelCheckout() {
        return { status: 200, body: {} };
      },
    };

    let monotonic = 10_000;
    const proxy = new CheckoutProxyService({
      mandateTokens: tokenService,
      mandates: {
        async getById(id) {
          return id === mandate.id ? mandate : undefined;
        },
      },
      agentRequests: {
        async verify(input) {
          if (input.expectedAgentId !== mandate.agentId) {
            throw new Error("unexpected agent identity");
          }
        },
      },
      merchants: {
        async getById(org, id) {
          return org === mandate.organizationId && id === merchant.id ? merchant : undefined;
        },
      },
      merchantClient,
      adapter: new ACPAdapter(),
      evaluator: new PolicyEvaluator({
        generateId,
        monotonicMicros: () => ++monotonic,
      }),
      reservations: new AuthorizationReservationService(redisAdapter(redis)),
      delegationAssertions: {
        issue() {
          return "integration-delegation-assertion";
        },
      },
      approvals: {
        async emit() {
          approvalEvents += 1;
        },
      },
      audit: {
        async record(event) {
          audits.push(event);
        },
      },
      generateId,
    });

    function input(body: unknown, idempotencyKey = `idem-${generateId()}`): CompleteCheckoutProxyInput {
      return {
        merchantId: merchant.id,
        checkoutSessionId: "cs_1",
        requestId: generateId(),
        idempotencyKey,
        path: `/v1/acp/${merchant.id}/checkout_sessions/cs_1/complete`,
        body,
        security: {
          mandateToken,
          authorization: "Bearer test-merchant-credential",
          apiVersion: "2026-04-17",
          agentProof: {
            agentId: mandate.agentId,
            keyId: "agent-key-not-used-by-this-harness",
            timestamp: nowSeconds.toString(10),
            nonce: `nonce_${generateId().replaceAll("-", "")}`,
            signature: "verified-in-agent-auth-integration-suite",
          },
        },
        now,
      };
    }

    return {
      proxy,
      input,
      mandate,
      setAuthoritativeSession(value: ReturnType<typeof checkoutSession>) {
        authoritativeSession = value;
      },
      state() {
        return { completeCalls, approvalEvents, audits, delegationObserved };
      },
    };
  }

  it("ignores an agent's stale cart expectation and blocks the merchant's current restricted cart", async () => {
    const h = buildHarness();

    // The agent may believe the cart is still a $75 office purchase.
    const agentBody = {
      payment_data: { token: "opaque" },
      agent_expected_total_minor: 7_500,
      agent_expected_category: "OFFICE_SUPPLIES",
    };

    // The merchant's authoritative state has changed before payment.
    h.setAuthoritativeSession(checkoutSession(37_500, "DIGITAL_GIFT_CARD"));

    const result = await h.proxy.completeCheckout(h.input(agentBody));

    expect(result.decision.verdict).toBe(DecisionVerdict.BLOCK);
    expect(result.decision.reasons).toContain("CATEGORY_RESTRICTED");
    expect(h.state().completeCalls).toBe(0);
    expect(await redis.zCard(`mino:v1:auth:{${h.mandate.id}}:reservations`)).toBe(0);
  });

  it("commits real Redis allowance only after a successful merchant completion", async () => {
    const h = buildHarness({ session: checkoutSession(5_000) });
    const result = await h.proxy.completeCheckout(
      h.input({ payment_data: { token: "opaque" } }),
    );

    expect(result.decision.verdict).toBe(DecisionVerdict.ALLOW);
    expect(result.upstream?.status).toBe(200);
    expect(h.state().completeCalls).toBe(1);
    expect(h.state().delegationObserved).toBe(true);
    expect(await redis.zCard(`mino:v1:auth:{${h.mandate.id}}:reservations`)).toBe(0);
    expect(await redis.zCard(`mino:v1:auth:{${h.mandate.id}}:committed`)).toBe(1);
  });

  it("releases real Redis allowance when the merchant returns a definite non-2xx response", async () => {
    const h = buildHarness({ session: checkoutSession(5_000), completeStatus: 503 });
    const result = await h.proxy.completeCheckout(
      h.input({ payment_data: { token: "opaque" } }),
    );

    expect(result.decision.verdict).toBe(DecisionVerdict.ALLOW);
    expect(result.upstream?.status).toBe(503);
    expect(h.state().completeCalls).toBe(1);
    expect(await redis.zCard(`mino:v1:auth:{${h.mandate.id}}:reservations`)).toBe(0);
    expect(await redis.zCard(`mino:v1:auth:{${h.mandate.id}}:committed`)).toBe(0);
  });

  it("holds an over-limit cart for human approval without reserving or forwarding payment", async () => {
    const base = buildHarness();
    const h = buildHarness({
      mandate: {
        ...base.mandate,
        id: "mandate-approval",
        maxBudgetPerTransactionMinor: 4_000n,
        approvalMode: ApprovalMode.DUAL_SIGNATURE_SLACK,
      },
      session: checkoutSession(5_000),
    });

    const result = await h.proxy.completeCheckout(
      h.input({ payment_data: { token: "opaque" } }),
    );

    expect(result.decision.verdict).toBe(DecisionVerdict.PENDING_HUMAN_APPROVAL);
    expect(h.state().completeCalls).toBe(0);
    expect(h.state().approvalEvents).toBe(1);
    expect(await redis.zCard(`mino:v1:auth:{${h.mandate.id}}:reservations`)).toBe(0);
  });

  it.todo(
    "reconciles an ambiguous merchant outcome where payment may have succeeded but the response was lost",
  );
});
