import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createClient } from "redis";
import { ApprovalMode, type AgentSpendMandate, type MandateTokenClaims } from "../../src/domain/mandates/mandate.types.js";
import { DecisionVerdict } from "../../src/domain/evaluation/evaluation.types.js";
import { sha256Hex } from "../../src/infrastructure/crypto/canonical-json.js";
import { MandateTokenService } from "../../src/modules/mandates/mandate-token.service.js";
import {
  BeginPaymentOutcomeKind,
  PaymentOutcomeStatus,
  type BeginPaymentOutcomeInput,
  type PaymentOutcomeRecord,
  type PaymentOutcomeStore,
  type StoredMerchantResponse,
} from "../../src/modules/payments/payment-outcome.store.js";
import { PolicyEvaluator } from "../../src/modules/policy/policy-evaluator.js";
import { ACPAdapter } from "../../src/modules/proxy/acp-adapter.js";
import {
  CheckoutProxyService,
  IdempotencyConflictError,
  PaymentOutcomePendingError,
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

class MemoryPaymentOutcomeStore implements PaymentOutcomeStore {
  private readonly records = new Map<string, PaymentOutcomeRecord>();

  public async getByIdempotency(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<PaymentOutcomeRecord | undefined> {
    return this.records.get(this.key(organizationId, idempotencyKey));
  }

  public async begin(input: BeginPaymentOutcomeInput) {
    const key = this.key(input.organizationId, input.idempotencyKey);
    const existing = this.records.get(key);
    if (existing) {
      return {
        kind:
          existing.requestDigest === input.requestDigest
            ? BeginPaymentOutcomeKind.EXISTING
            : BeginPaymentOutcomeKind.CONFLICT,
        outcome: existing,
      };
    }

    const outcome: PaymentOutcomeRecord = {
      id: input.id,
      organizationId: input.organizationId,
      userId: input.userId,
      agentId: input.agentId,
      mandateId: input.mandateId,
      reservationId: input.reservationId,
      idempotencyKey: input.idempotencyKey,
      requestDigest: input.requestDigest,
      merchantId: input.merchantId,
      merchantDomain: input.merchantDomain,
      checkoutSessionId: input.checkoutSessionId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      status: PaymentOutcomeStatus.FORWARDING,
      createdAt: input.now,
      updatedAt: input.now,
      forwardedAt: input.now,
    };
    this.records.set(key, outcome);
    return { kind: BeginPaymentOutcomeKind.CREATED, outcome };
  }

  public async markUnknown(
    outcomeId: string,
    args: { readonly upstreamStatus?: number; readonly errorCode?: string; readonly now: Date },
  ) {
    return this.update(outcomeId, (outcome) => ({
      ...outcome,
      status: PaymentOutcomeStatus.UNKNOWN,
      ...(args.upstreamStatus !== undefined ? { upstreamStatus: args.upstreamStatus } : {}),
      ...(args.errorCode ? { lastErrorCode: args.errorCode } : {}),
      updatedAt: args.now,
    }));
  }

  public async markSucceeded(outcomeId: string, response: StoredMerchantResponse, at: Date) {
    return this.update(outcomeId, (outcome) => ({
      ...outcome,
      status: PaymentOutcomeStatus.SUCCEEDED,
      upstreamStatus: response.status,
      response,
      updatedAt: at,
      resolvedAt: outcome.resolvedAt ?? at,
    }));
  }

  public async markDefinitiveFailure(outcomeId: string, response: StoredMerchantResponse, at: Date) {
    return this.update(outcomeId, (outcome) => ({
      ...outcome,
      status: PaymentOutcomeStatus.FAILED_DEFINITIVE,
      upstreamStatus: response.status,
      response,
      updatedAt: at,
      resolvedAt: outcome.resolvedAt ?? at,
    }));
  }

  public async markReconciled(outcomeId: string, at: Date) {
    return this.update(outcomeId, (outcome) => ({
      ...outcome,
      updatedAt: at,
      lastReconciledAt: at,
    }));
  }

  private update(
    outcomeId: string,
    mutate: (outcome: PaymentOutcomeRecord) => PaymentOutcomeRecord,
  ): PaymentOutcomeRecord {
    for (const [key, value] of this.records.entries()) {
      if (value.id === outcomeId) {
        const updated = mutate(value);
        this.records.set(key, updated);
        return updated;
      }
    }
    throw new Error(`Unknown memory payment outcome ${outcomeId}`);
  }

  private key(organizationId: string, idempotencyKey: string): string {
    return `${organizationId}|${idempotencyKey}`;
  }
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
    completeThenThrow?: boolean;
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
    let authoritativeSession: ReturnType<typeof checkoutSession> & { order?: unknown } =
      args.session ?? checkoutSession();
    let completeCalls = 0;
    let approvalEvents = 0;
    const audits: unknown[] = [];
    let delegationObserved = false;
    const paymentOutcomes = new MemoryPaymentOutcomeStore();

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
        if (args.completeThenThrow) {
          authoritativeSession = {
            ...authoritativeSession,
            status: "completed",
            order: { id: "order-after-lost-response" },
          };
          throw new Error("simulated response loss after merchant completed payment");
        }
        if (args.throwOnComplete) {
          throw new Error("simulated transport failure after dispatch");
        }
        const status = args.completeStatus ?? 200;
        if (status >= 200 && status < 300) {
          authoritativeSession = {
            ...authoritativeSession,
            status: "completed",
            order: { id: "order-success" },
          };
        }
        return {
          status,
          body: authoritativeSession,
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
      paymentOutcomes,
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
      paymentOutcomes,
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
    const agentBody = {
      payment_data: { token: "opaque" },
      agent_expected_total_minor: 7_500,
      agent_expected_category: "OFFICE_SUPPLIES",
    };

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
    expect(result.paymentOutcomeId).toBeDefined();
    expect(h.state().completeCalls).toBe(1);
    expect(h.state().delegationObserved).toBe(true);
    expect(await redis.zCard(`mino:v1:auth:{${h.mandate.id}}:reservations`)).toBe(0);
    expect(await redis.zCard(`mino:v1:auth:{${h.mandate.id}}:committed`)).toBe(1);
  });

  it("replays a completed idempotent payment without forwarding a second charge", async () => {
    const h = buildHarness({ session: checkoutSession(5_000) });
    const key = "idem-success-replay";
    const body = { payment_data: { token: "opaque" } };

    const first = await h.proxy.completeCheckout(h.input(body, key));
    const second = await h.proxy.completeCheckout(h.input(body, key));

    expect(first.upstream?.status).toBe(200);
    expect(second.upstream?.status).toBe(200);
    expect(second.replayed).toBe(true);
    expect(h.state().completeCalls).toBe(1);
    expect(await redis.zCard(`mino:v1:auth:{${h.mandate.id}}:committed`)).toBe(1);
  });

  it("rejects reuse of an idempotency key when only the sensitive payment payload changes", async () => {
    const h = buildHarness({ session: checkoutSession(5_000) });
    const key = "idem-sensitive-conflict";

    await h.proxy.completeCheckout(h.input({ payment_data: { token: "token-a" } }, key));

    await expect(
      h.proxy.completeCheckout(h.input({ payment_data: { token: "token-b" } }, key)),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(h.state().completeCalls).toBe(1);
  });

  it("releases real Redis allowance for a definitive merchant 4xx failure", async () => {
    const h = buildHarness({ session: checkoutSession(5_000), completeStatus: 400 });
    const result = await h.proxy.completeCheckout(
      h.input({ payment_data: { token: "opaque" } }),
    );

    expect(result.decision.verdict).toBe(DecisionVerdict.ALLOW);
    expect(result.upstream?.status).toBe(400);
    expect(h.state().completeCalls).toBe(1);
    expect(await redis.zCard(`mino:v1:auth:{${h.mandate.id}}:reservations`)).toBe(0);
    expect(await redis.zCard(`mino:v1:auth:{${h.mandate.id}}:committed`)).toBe(0);
  });

  it("keeps allowance held when a merchant 5xx leaves payment outcome ambiguous", async () => {
    const h = buildHarness({ session: checkoutSession(5_000), completeStatus: 503 });

    await expect(
      h.proxy.completeCheckout(h.input({ payment_data: { token: "opaque" } })),
    ).rejects.toBeInstanceOf(PaymentOutcomePendingError);

    expect(h.state().completeCalls).toBe(1);
    expect(await redis.zCard(`mino:v1:auth:{${h.mandate.id}}:reservations`)).toBe(1);
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

  it("reconciles a lost merchant response without forwarding a second payment", async () => {
    const h = buildHarness({ session: checkoutSession(5_000), completeThenThrow: true });
    const key = "idem-lost-response";
    const body = { payment_data: { token: "opaque" } };

    await expect(h.proxy.completeCheckout(h.input(body, key))).rejects.toBeInstanceOf(
      PaymentOutcomePendingError,
    );

    expect(h.state().completeCalls).toBe(1);
    expect(await redis.zCard(`mino:v1:auth:{${h.mandate.id}}:reservations`)).toBe(1);
    expect(await redis.zCard(`mino:v1:auth:{${h.mandate.id}}:committed`)).toBe(0);

    const reconciled = await h.proxy.completeCheckout(h.input(body, key));

    expect(reconciled.upstream?.status).toBe(200);
    expect(reconciled.replayed).toBe(true);
    expect(h.state().completeCalls).toBe(1);
    expect(await redis.zCard(`mino:v1:auth:{${h.mandate.id}}:reservations`)).toBe(0);
    expect(await redis.zCard(`mino:v1:auth:{${h.mandate.id}}:committed`)).toBe(1);

    const outcome = await h.paymentOutcomes.getByIdempotency(h.mandate.organizationId, key);
    expect(outcome?.status).toBe(PaymentOutcomeStatus.SUCCEEDED);
    expect(outcome?.lastReconciledAt).toEqual(now);
  });
});
