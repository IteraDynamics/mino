import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ApprovalMode, type AgentSpendMandate, type MandateTokenClaims } from "../../src/domain/mandates/mandate.types.js";
import { DecisionVerdict } from "../../src/domain/evaluation/evaluation.types.js";
import { sha256Hex } from "../../src/infrastructure/crypto/canonical-json.js";
import { signEd25519 } from "../../src/infrastructure/crypto/ed25519.js";
import {
  AgentRequestVerifier,
  buildAgentSigningPayload,
  type AgentRequestProof,
} from "../../src/modules/agents/agent-request-verifier.js";
import { MandateTokenService } from "../../src/modules/mandates/mandate-token.service.js";
import {
  CheckoutLifecycleProxyService,
  type CheckoutLifecycleMerchantClient,
} from "../../src/modules/proxy/checkout-lifecycle-proxy.service.js";
import { ProxyProtocolError, ProxyUpstreamError } from "../../src/modules/proxy/checkout-proxy.service.js";
import type { MerchantEndpoint, MerchantRequestHeaders } from "../../src/modules/proxy/merchant-client.js";

const now = new Date("2026-08-15T02:30:00.000Z");
const nowSeconds = Math.floor(now.getTime() / 1000);
const mandateKeyPair = generateKeyPairSync("ed25519");
const agentKeyPair = generateKeyPairSync("ed25519");

interface CapturedCall {
  operation: "get" | "update" | "cancel";
  checkoutSessionId: string;
  payload?: unknown;
  headers: MerchantRequestHeaders;
}

function buildHarness(options: {
  merchant?: MerchantEndpoint;
  upstreamStatus?: number;
} = {}) {
  const jti = "lifecycle-mandate-jti";
  const tokenJtiHash = sha256Hex(jti);
  const mandate: AgentSpendMandate = {
    id: "mandate-lifecycle",
    organizationId: "org-lifecycle",
    userId: "user-lifecycle",
    agentId: "agent-lifecycle",
    policyId: "policy-lifecycle",
    policyVersion: 7,
    currency: "USD",
    maxBudgetPerTransactionMinor: 50_000n,
    rollingDailyLimitMinor: 100_000n,
    approvedMerchantDomains: ["merchant.example"],
    approvedVendorIds: [],
    restrictedCategories: [],
    approvalMode: ApprovalMode.AUTO_APPROVE,
    velocity: {
      maxTransactionsPerMinute: 10,
      crossMerchantWindowSeconds: 60,
      maxDistinctMerchantsInWindow: 5,
    },
    issuedAt: new Date((nowSeconds - 60) * 1000),
    expiresAt: new Date((nowSeconds + 600) * 1000),
    signingKeyId: "mino-lifecycle-k1",
    tokenJtiHash,
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
        return keyId === mandate.signingKeyId ? mandateKeyPair.publicKey : undefined;
      },
    },
    { issuer: "https://mino.example" },
  );
  const mandateToken = tokenService.issue(claims, {
    keyId: mandate.signingKeyId,
    privateKey: mandateKeyPair.privateKey,
  });

  const claimedNonces = new Set<string>();
  const verifier = new AgentRequestVerifier(
    {
      async resolveAgentPublicKey(agentId, keyId) {
        return agentId === mandate.agentId && keyId === "agent-lifecycle-k1"
          ? agentKeyPair.publicKey
          : undefined;
      },
    },
    {
      async claim(agentId, nonce) {
        const key = `${agentId}|${nonce}`;
        if (claimedNonces.has(key)) {
          return false;
        }
        claimedNonces.add(key);
        return true;
      },
    },
  );

  const merchant = options.merchant ?? {
    id: "merchant-1",
    domain: "merchant.example",
    vendorId: "vendor-1",
    baseUrl: "https://merchant.example",
    active: true,
  };
  const calls: CapturedCall[] = [];
  const upstreamStatus = options.upstreamStatus ?? 200;
  const merchantClient: CheckoutLifecycleMerchantClient = {
    async getCheckout(_merchant, checkoutSessionId, headers) {
      calls.push({ operation: "get", checkoutSessionId, headers });
      return { status: upstreamStatus, body: { id: checkoutSessionId, status: "not_ready" } };
    },
    async updateCheckout(_merchant, checkoutSessionId, payload, headers) {
      calls.push({ operation: "update", checkoutSessionId, payload, headers });
      return { status: upstreamStatus, body: { id: checkoutSessionId, status: "not_ready", ...asRecord(payload) } };
    },
    async cancelCheckout(_merchant, checkoutSessionId, headers, payload) {
      calls.push({ operation: "cancel", checkoutSessionId, payload, headers });
      return { status: upstreamStatus, body: { id: checkoutSessionId, status: "canceled" } };
    },
  };
  const audits: Array<{ operation: string; decision: { eligibleForDelegationAssertion: boolean }; upstreamStatus?: number }> = [];
  let idCounter = 0;
  let nonceCounter = 0;
  const proxy = new CheckoutLifecycleProxyService({
    mandateTokens: tokenService,
    mandates: {
      async getById(id) {
        return id === mandate.id ? mandate : undefined;
      },
    },
    agentRequests: verifier,
    merchants: {
      async getById(organizationId, merchantId) {
        return organizationId === mandate.organizationId && merchantId === merchant.id
          ? merchant
          : undefined;
      },
    },
    merchantClient,
    audit: {
      async record(event) {
        audits.push(event as typeof audits[number]);
      },
    },
    generateId: () => `decision-${++idCounter}`,
  });

  function proof(method: string, path: string, body: unknown, idempotencyKey: string): AgentRequestProof {
    const timestamp = nowSeconds.toString(10);
    const nonce = `lifecycle_nonce_${String(++nonceCounter).padStart(24, "0")}`;
    const signingPayload = buildAgentSigningPayload({
      method,
      path,
      timestamp,
      nonce,
      body,
      mandateTokenJtiHash: tokenJtiHash,
      idempotencyKey,
      apiVersion: "2026-04-17",
    });
    return {
      agentId: mandate.agentId,
      keyId: "agent-lifecycle-k1",
      timestamp,
      nonce,
      signature: signEd25519(signingPayload, agentKeyPair.privateKey).toString("base64url"),
    };
  }

  function security(agentProof: AgentRequestProof, apiVersion = "2026-04-17") {
    return {
      mandateToken,
      agentProof,
      authorization: "Bearer merchant-credential",
      apiVersion,
    };
  }

  return { proxy, calls, audits, proof, security, merchant, mandate };
}

describe("CheckoutLifecycleProxyService", () => {
  it("retrieves a checkout with signed agent proof and no merchant idempotency header", async () => {
    const h = buildHarness();
    const path = "/v1/acp/merchant-1/checkout_sessions/cs_1";
    const body = {};
    const result = await h.proxy.retrieveCheckout({
      merchantId: "merchant-1",
      checkoutSessionId: "cs_1",
      requestId: "request-get",
      idempotencyKey: "",
      path,
      body,
      security: h.security(h.proof("GET", path, body, "")),
      now,
    });

    expect(result.decision.verdict).toBe(DecisionVerdict.ALLOW);
    expect(result.decision.approvedAmount).toBeUndefined();
    expect(result.decision.eligibleForDelegationAssertion).toBe(false);
    expect(h.calls).toEqual([
      expect.objectContaining({
        operation: "get",
        checkoutSessionId: "cs_1",
        headers: expect.objectContaining({ requestId: "request-get" }),
      }),
    ]);
    expect(h.calls[0]?.headers.idempotencyKey).toBeUndefined();
    expect(h.calls[0]?.headers.delegationAssertion).toBeUndefined();
    expect(h.audits[0]?.operation).toBe("RETRIEVE_CHECKOUT_SESSION");
  });

  it("forwards update payload and idempotency while remaining outside spend delegation", async () => {
    const h = buildHarness();
    const path = "/v1/acp/merchant-1/checkout_sessions/cs_1";
    const body = { line_items: [{ id: "line-1", quantity: 2 }] };
    const result = await h.proxy.updateCheckout({
      merchantId: "merchant-1",
      checkoutSessionId: "cs_1",
      requestId: "request-update",
      idempotencyKey: "idem-update",
      path,
      body,
      security: h.security(h.proof("POST", path, body, "idem-update")),
      now,
    });

    expect(result.decision.eligibleForDelegationAssertion).toBe(false);
    expect(h.calls[0]).toMatchObject({
      operation: "update",
      checkoutSessionId: "cs_1",
      payload: body,
      headers: { idempotencyKey: "idem-update" },
    });
    expect(h.audits[0]?.operation).toBe("UPDATE_CHECKOUT_SESSION");
  });

  it("forwards cancel payload and idempotency without payment authority", async () => {
    const h = buildHarness();
    const path = "/v1/acp/merchant-1/checkout_sessions/cs_1/cancel";
    const body = { intent_trace: { reason: "agent_no_longer_needs_order" } };
    const result = await h.proxy.cancelCheckout({
      merchantId: "merchant-1",
      checkoutSessionId: "cs_1",
      requestId: "request-cancel",
      idempotencyKey: "idem-cancel",
      path,
      body,
      security: h.security(h.proof("POST", path, body, "idem-cancel")),
      now,
    });

    expect(result.decision.eligibleForDelegationAssertion).toBe(false);
    expect(h.calls[0]).toMatchObject({
      operation: "cancel",
      payload: body,
      headers: { idempotencyKey: "idem-cancel" },
    });
    expect(h.audits[0]?.operation).toBe("CANCEL_CHECKOUT_SESSION");
  });

  it("rejects unsupported ACP version before calling the merchant", async () => {
    const h = buildHarness();
    const path = "/v1/acp/merchant-1/checkout_sessions/cs_1";
    const body = {};
    await expect(
      h.proxy.retrieveCheckout({
        merchantId: "merchant-1",
        checkoutSessionId: "cs_1",
        requestId: "request-version",
        idempotencyKey: "",
        path,
        body,
        security: h.security(h.proof("GET", path, body, ""), "2099-01-01"),
        now,
      }),
    ).rejects.toBeInstanceOf(ProxyProtocolError);
    expect(h.calls).toHaveLength(0);
  });

  it("rejects a request whose signed payload does not match the forwarded update", async () => {
    const h = buildHarness();
    const path = "/v1/acp/merchant-1/checkout_sessions/cs_1";
    const signedBody = { line_items: [{ id: "line-1", quantity: 1 }] };
    const forwardedBody = { line_items: [{ id: "line-1", quantity: 9 }] };
    await expect(
      h.proxy.updateCheckout({
        merchantId: "merchant-1",
        checkoutSessionId: "cs_1",
        requestId: "request-tamper",
        idempotencyKey: "idem-tamper",
        path,
        body: forwardedBody,
        security: h.security(h.proof("POST", path, signedBody, "idem-tamper")),
        now,
      }),
    ).rejects.toThrow(/signature/i);
    expect(h.calls).toHaveLength(0);
  });

  it("fails closed for an insecure registered merchant target", async () => {
    const h = buildHarness({
      merchant: {
        id: "merchant-1",
        domain: "merchant.example",
        baseUrl: "http://merchant.example",
        active: true,
      },
    });
    const path = "/v1/acp/merchant-1/checkout_sessions/cs_1";
    const body = {};
    await expect(
      h.proxy.retrieveCheckout({
        merchantId: "merchant-1",
        checkoutSessionId: "cs_1",
        requestId: "request-insecure",
        idempotencyKey: "",
        path,
        body,
        security: h.security(h.proof("GET", path, body, "")),
        now,
      }),
    ).rejects.toThrow(/registered HTTPS/i);
    expect(h.calls).toHaveLength(0);
  });

  it("audits an upstream failure before surfacing it", async () => {
    const h = buildHarness({ upstreamStatus: 409 });
    const path = "/v1/acp/merchant-1/checkout_sessions/cs_1";
    const body = { line_items: [] };
    await expect(
      h.proxy.updateCheckout({
        merchantId: "merchant-1",
        checkoutSessionId: "cs_1",
        requestId: "request-upstream-failure",
        idempotencyKey: "idem-upstream-failure",
        path,
        body,
        security: h.security(h.proof("POST", path, body, "idem-upstream-failure")),
        now,
      }),
    ).rejects.toBeInstanceOf(ProxyUpstreamError);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]?.upstreamStatus).toBe(409);
  });
});

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}