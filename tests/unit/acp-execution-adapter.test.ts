import { describe, expect, it } from "vitest";
import type { AuthorizationDecision } from "../../src/domain/economic/authorization-decision.js";
import { bindEconomicIntent } from "../../src/domain/economic/canonical-economic-intent.js";
import type { EconomicIntent } from "../../src/domain/economic/economic-intent.types.js";
import { DecisionVerdict } from "../../src/domain/evaluation/evaluation.types.js";
import { sha256Base64Url } from "../../src/infrastructure/crypto/canonical-json.js";
import { ACPExecutionAdapter } from "../../src/modules/proxy/acp-execution-adapter.js";
import type { ACPMerchantClient, MerchantEndpoint } from "../../src/modules/proxy/merchant-client.js";

const NOW = new Date("2026-08-19T12:00:00.000Z");

function intent(protocol: EconomicIntent["protocol"] = "ACP"): EconomicIntent {
  return {
    requestId: "request-34",
    protocol,
    operation: "COMPLETE_CHECKOUT",
    organizationId: "org-1",
    userId: "user-1",
    agentId: "agent-1",
    counterparty: {
      kind: "MERCHANT",
      identifiers: [{ scheme: "DOMAIN", value: "supplier.example" }],
    },
    cart: [
      {
        lineId: "line-1",
        name: "Paper",
        category: "OFFICE_SUPPLIES",
        quantity: 1,
        unitPrice: { currency: "USD", minorUnits: 5_000n },
        totalPrice: { currency: "USD", minorUnits: 5_000n },
      },
    ],
    subtotal: { currency: "USD", minorUnits: 5_000n },
    total: { currency: "USD", minorUnits: 5_000n },
    idempotencyKey: "idem-34",
    authoritativeStateDigest: sha256Base64Url(`provider-state-${protocol}`),
    rawPayload: { id: "cs_34" },
  };
}

function decision(economicIntent: EconomicIntent): AuthorizationDecision {
  const base = {
    decisionId: "decision-34",
    requestId: "request-34",
    verdict: DecisionVerdict.ALLOW,
    reasons: [],
    requestedAmount: { currency: "USD", minorUnits: 5_000n },
    policyAmount: { currency: "USD", minorUnits: 5_000n },
    approvedAmount: { currency: "USD", minorUnits: 5_000n },
    mandateId: "mandate-34",
    policyId: "policy-34",
    policyVersion: 1,
    eligibleForDelegationAssertion: true,
    evaluationLatencyMicros: 1,
    evaluatedAt: NOW,
  } as const;
  const bound = bindEconomicIntent(economicIntent, {
    organizationId: economicIntent.organizationId,
    userId: economicIntent.userId,
    agentId: economicIntent.agentId,
    mandateId: base.mandateId,
    policyId: base.policyId,
    policyVersion: base.policyVersion,
  });
  return { ...base, intentDigest: bound.intentDigest };
}

const merchant: MerchantEndpoint = {
  id: "merchant-1",
  domain: "supplier.example",
  baseUrl: "https://supplier.example",
  active: true,
};

function harness() {
  let completeCalls = 0;
  let observedAssertion: string | undefined;
  let grantCalls = 0;
  let delegationCalls = 0;
  let clockNow = NOW;

  const client: ACPMerchantClient = {
    async createCheckout() {
      return { status: 200, body: {} };
    },
    async getCheckout() {
      return { status: 200, body: {} };
    },
    async completeCheckout(_merchant, _sessionId, _payload, headers) {
      completeCalls += 1;
      observedAssertion = headers.delegationAssertion;
      return { status: 200, body: { status: "completed" } };
    },
    async cancelCheckout() {
      return { status: 200, body: {} };
    },
  };

  const adapter = new ACPExecutionAdapter(
    client,
    {
      issue(inputIntent, inputDecision) {
        grantCalls += 1;
        return {
          token: "signed-neutral-grant",
          claims: {
            iss: "https://mino.example",
            aud: "mino:economic-execution",
            sub: inputIntent.agentId,
            jti: "grant-34",
            iat: Math.floor(NOW.getTime() / 1000),
            exp: Math.floor(NOW.getTime() / 1000) + 45,
            organization_id: inputIntent.organizationId,
            user_id: inputIntent.userId,
            agent_id: inputIntent.agentId,
            mandate_id: inputDecision.mandateId,
            policy_id: inputDecision.policyId,
            policy_version: inputDecision.policyVersion,
            decision_id: inputDecision.decisionId,
            request_id: inputIntent.requestId,
            operation: inputIntent.operation,
            counterparty: inputIntent.counterparty!,
            amount_minor: inputDecision.approvedAmount!.minorUnits.toString(10),
            currency: inputDecision.approvedAmount!.currency,
            idempotency_digest: "idem-digest",
            intent_digest: inputDecision.intentDigest,
          },
        };
      },
    },
    {
      issue() {
        delegationCalls += 1;
        return "legacy-acp-delegation";
      },
    },
    () => clockNow,
  );

  return {
    adapter,
    setClock(value: Date) {
      clockNow = value;
    },
    state: () => ({ completeCalls, observedAssertion, grantCalls, delegationCalls }),
  };
}

describe("ACPExecutionAdapter", () => {
  it("issues the neutral grant before forwarding through ACP adapter #1", async () => {
    const h = harness();
    const economicIntent = intent();
    const authorizationDecision = decision(economicIntent);

    const providerArtifact = h.adapter.issue(economicIntent, authorizationDecision, NOW);
    expect(providerArtifact).toBe("legacy-acp-delegation");
    expect(h.state().grantCalls).toBe(1);
    expect(h.state().delegationCalls).toBe(1);

    const response = await h.adapter.completeCheckout(
      merchant,
      "cs_34",
      { payment_data: { token: "opaque" } },
      {
        requestId: "request-34",
        idempotencyKey: "idem-34",
        apiVersion: "2026-04-17",
        authorization: "Bearer merchant-token",
        delegationAssertion: providerArtifact,
      },
    );

    expect(response.status).toBe(200);
    expect(h.state().completeCalls).toBe(1);
    expect(h.state().observedAssertion).toBe("legacy-acp-delegation");
  });

  it("refuses execution without a prepared authorization grant", async () => {
    const h = harness();

    await expect(
      h.adapter.completeCheckout(
        merchant,
        "cs_34",
        {},
        {
          requestId: "request-34",
          apiVersion: "2026-04-17",
          authorization: "Bearer merchant-token",
          delegationAssertion: "unprepared-assertion",
        },
      ),
    ).rejects.toThrow("missing, expired, or already consumed");

    expect(h.state().completeCalls).toBe(0);
  });

  it("refuses a prepared grant that expires before provider forwarding", async () => {
    const h = harness();
    const economicIntent = intent();
    const providerArtifact = h.adapter.issue(economicIntent, decision(economicIntent), NOW);
    h.setClock(new Date(NOW.getTime() + 46_000));

    await expect(
      h.adapter.completeCheckout(
        merchant,
        "cs_34",
        {},
        {
          requestId: "request-34",
          apiVersion: "2026-04-17",
          authorization: "Bearer merchant-token",
          delegationAssertion: providerArtifact,
        },
      ),
    ).rejects.toThrow("authorization grant is expired");

    expect(h.state().completeCalls).toBe(0);
  });

  it("fails closed when the neutral intent targets another provider", async () => {
    const h = harness();
    const economicIntent = intent("STRIPE");
    const authorizationDecision = decision(economicIntent);
    const grant = {
      token: "grant",
      claims: {
        iss: "https://mino.example",
        aud: "mino:economic-execution" as const,
        sub: economicIntent.agentId,
        jti: "grant-34",
        iat: Math.floor(NOW.getTime() / 1000),
        exp: Math.floor(NOW.getTime() / 1000) + 45,
        organization_id: economicIntent.organizationId,
        user_id: economicIntent.userId,
        agent_id: economicIntent.agentId,
        mandate_id: authorizationDecision.mandateId,
        policy_id: authorizationDecision.policyId,
        policy_version: authorizationDecision.policyVersion,
        decision_id: authorizationDecision.decisionId,
        request_id: economicIntent.requestId,
        operation: economicIntent.operation,
        counterparty: economicIntent.counterparty!,
        amount_minor: "5000",
        currency: "USD",
        idempotency_digest: "idem-digest",
        intent_digest: authorizationDecision.intentDigest,
      },
    };

    await expect(
      h.adapter.execute({
        intent: economicIntent,
        decision: authorizationDecision,
        grant,
        now: NOW,
        context: {
          merchant,
          checkoutSessionId: "cs_34",
          payload: {},
          headers: {
            requestId: "request-34",
            apiVersion: "2026-04-17",
            authorization: "Bearer merchant-token",
          },
          delegationAssertion: "legacy-acp-delegation",
        },
      }),
    ).rejects.toThrow("refuses non-ACP economic intent");

    expect(h.state().completeCalls).toBe(0);
  });

  it("refuses execution when provider-authoritative state no longer matches the decision", () => {
    const h = harness();
    const original = intent();
    const authorizationDecision = decision(original);
    const changed = {
      ...original,
      authoritativeStateDigest: sha256Base64Url("changed-provider-state"),
    };

    expect(() => h.adapter.issue(changed, authorizationDecision, NOW)).toThrow(
      "Authorization decision does not bind to the requested EconomicIntent",
    );
  });
});
