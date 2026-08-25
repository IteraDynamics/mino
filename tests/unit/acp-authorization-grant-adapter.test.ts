import { describe, expect, it, vi } from "vitest";
import type { CheckoutIntent } from "../../src/domain/checkout/checkout.types.js";
import { DecisionVerdict, type PolicyDecision } from "../../src/domain/evaluation/evaluation.types.js";
import { ACPAuthorizationGrantAdapter } from "../../src/modules/proxy/acp-authorization-grant-adapter.js";

const NOW = new Date("2026-08-18T19:00:00.000Z");

const intent: CheckoutIntent = {
  requestId: "request-1",
  protocol: "ACP",
  operation: "COMPLETE_CHECKOUT",
  organizationId: "org-1",
  userId: "user-1",
  agentId: "agent-1",
  merchant: { domain: "supplier.example" },
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
  idempotencyKey: "idem-1",
  rawPayload: { id: "cs_1" },
};

const decision: PolicyDecision = {
  decisionId: "decision-1",
  requestId: "request-1",
  verdict: DecisionVerdict.ALLOW,
  reasons: [],
  requestedAmount: { currency: "USD", minorUnits: 5_000n },
  policyAmount: { currency: "USD", minorUnits: 5_000n },
  approvedAmount: { currency: "USD", minorUnits: 5_000n },
  mandateId: "mandate-1",
  policyId: "policy-1",
  policyVersion: 1,
  intentDigest: "A".repeat(43),
  eligibleForDelegationAssertion: true,
  evaluationLatencyMicros: 10,
  evaluatedAt: NOW,
};

describe("ACPAuthorizationGrantAdapter", () => {
  it("issues the neutral grant before preserving the legacy ACP assertion output", () => {
    const issueGrant = vi.fn(() => ({ token: "grant-token", claims: {} as never }));
    const issueLegacy = vi.fn(() => "legacy-acp-assertion");
    const adapter = new ACPAuthorizationGrantAdapter(
      { issue: issueGrant },
      { issue: issueLegacy },
    );

    expect(adapter.issue(intent, decision, NOW)).toBe("legacy-acp-assertion");
    expect(issueGrant).toHaveBeenCalledWith(intent, decision, NOW);
    expect(issueLegacy).toHaveBeenCalledWith(intent, decision, NOW);
    expect(issueGrant.mock.invocationCallOrder[0]).toBeLessThan(
      issueLegacy.mock.invocationCallOrder[0]!,
    );
  });

  it("refuses to mint an execution grant from an unbound policy decision", () => {
    const issueGrant = vi.fn(() => ({ token: "grant-token", claims: {} as never }));
    const issueLegacy = vi.fn(() => "legacy-acp-assertion");
    const adapter = new ACPAuthorizationGrantAdapter(
      { issue: issueGrant },
      { issue: issueLegacy },
    );
    const { intentDigest: _omitted, ...unbound } = decision;

    expect(() => adapter.issue(intent, unbound, NOW)).toThrow(/EconomicIntent-bound decision/);
    expect(issueGrant).not.toHaveBeenCalled();
    expect(issueLegacy).not.toHaveBeenCalled();
  });
});
