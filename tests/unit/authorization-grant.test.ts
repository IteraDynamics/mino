import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { EconomicIntent } from "../../src/domain/economic/economic-intent.types.js";
import { DecisionVerdict, type PolicyDecision } from "../../src/domain/evaluation/evaluation.types.js";
import { verifyEd25519 } from "../../src/infrastructure/crypto/ed25519.js";
import { AuthorizationGrantService } from "../../src/modules/authorization/authorization-grant.service.js";

const NOW = new Date("2026-08-18T19:00:00.000Z");

function intent(protocol: EconomicIntent["protocol"], rawPayload: unknown): EconomicIntent {
  return {
    requestId: "request-1",
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
        productId: "paper",
        name: "Printer paper",
        category: "OFFICE_SUPPLIES",
        quantity: 1,
        unitPrice: { currency: "USD", minorUnits: 5_000n },
        totalPrice: { currency: "USD", minorUnits: 5_000n },
      },
    ],
    subtotal: { currency: "USD", minorUnits: 5_000n },
    total: { currency: "USD", minorUnits: 5_000n },
    idempotencyKey: "idem-1",
    rawPayload,
  };
}

function decision(): PolicyDecision {
  return {
    decisionId: "decision-1",
    requestId: "request-1",
    verdict: DecisionVerdict.ALLOW,
    reasons: [],
    requestedAmount: { currency: "USD", minorUnits: 5_000n },
    policyAmount: { currency: "USD", minorUnits: 5_000n },
    approvedAmount: { currency: "USD", minorUnits: 5_000n },
    mandateId: "mandate-1",
    policyId: "policy-1",
    policyVersion: 7,
    eligibleForDelegationAssertion: true,
    evaluationLatencyMicros: 10,
    evaluatedAt: NOW,
  };
}

describe("AuthorizationGrantService", () => {
  it("issues a verifiable provider-neutral signed grant", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const issuer = new AuthorizationGrantService(
      { keyId: "grant-k1", privateKey },
      () => "grant-1",
      { issuer: "https://mino.example" },
    );

    const grant = issuer.issue(intent("ACP", { id: "cs_1" }), decision(), NOW);
    const [header, payload, signature] = grant.token.split(".");

    expect(header).toBeTruthy();
    expect(payload).toBeTruthy();
    expect(signature).toBeTruthy();
    expect(
      verifyEd25519(
        `${header}.${payload}`,
        Buffer.from(signature!, "base64url"),
        publicKey,
      ),
    ).toBe(true);
    expect(grant.claims.aud).toBe("mino:economic-execution");
    expect(grant.claims.counterparty.kind).toBe("MERCHANT");
    expect(grant.claims.amount_minor).toBe("5000");
    expect(grant.claims.operation).toBe("COMPLETE_CHECKOUT");
  });

  it("binds provider-neutral economic meaning rather than provider provenance", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    let sequence = 0;
    const issuer = new AuthorizationGrantService(
      { keyId: "grant-k1", privateKey },
      () => `grant-${++sequence}`,
      { issuer: "https://mino.example" },
    );

    const acp = issuer.issue(intent("ACP", { id: "cs_1" }), decision(), NOW);
    const stripe = issuer.issue(intent("STRIPE", { id: "pi_1" }), decision(), NOW);

    expect(acp.claims.intent_digest).toBe(stripe.claims.intent_digest);
    expect(acp.claims.counterparty).toEqual(stripe.claims.counterparty);
  });

  it("refuses to issue a grant for a non-allow decision", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const issuer = new AuthorizationGrantService(
      { keyId: "grant-k1", privateKey },
      () => "grant-1",
      { issuer: "https://mino.example" },
    );

    expect(() =>
      issuer.issue(
        intent("ACP", { id: "cs_1" }),
        {
          ...decision(),
          verdict: DecisionVerdict.BLOCK,
          eligibleForDelegationAssertion: false,
          approvedAmount: undefined,
        } as PolicyDecision,
        NOW,
      ),
    ).toThrowError("Authorization grants can only be issued for allowed decisions");
  });
});
