import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { EconomicIntent } from "../../src/domain/economic/economic-intent.types.js";
import { DecisionVerdict, type PolicyDecision } from "../../src/domain/evaluation/evaluation.types.js";
import { ApprovalMode, type AgentSpendMandate } from "../../src/domain/mandates/mandate.types.js";
import { AuthorizationGrantService } from "../../src/modules/authorization/authorization-grant.service.js";
import { PolicyEvaluator } from "../../src/modules/policy/policy-evaluator.js";

const NOW = new Date("2026-08-19T18:30:00.000Z");

function mandate(): AgentSpendMandate {
  return {
    id: "mandate-1",
    organizationId: "org-1",
    userId: "user-1",
    agentId: "agent-1",
    policyId: "policy-1",
    policyVersion: 3,
    currency: "USD",
    maxBudgetPerTransactionMinor: 10_000n,
    rollingDailyLimitMinor: 50_000n,
    approvedMerchantDomains: ["supplier.example"],
    approvedVendorIds: [],
    restrictedCategories: ["GIFT_CARDS"],
    approvalMode: ApprovalMode.AUTO_APPROVE,
    velocity: {
      maxTransactionsPerMinute: 10,
      crossMerchantWindowSeconds: 60,
      maxDistinctMerchantsInWindow: 5,
    },
    issuedAt: new Date("2026-08-19T17:30:00.000Z"),
    expiresAt: new Date("2026-08-20T18:30:00.000Z"),
    signingKeyId: "mandate-k1",
  };
}

function intent(
  protocol: EconomicIntent["protocol"],
  rawPayload: unknown,
  overrides: Partial<Pick<EconomicIntent, "total" | "subtotal">> = {},
): EconomicIntent {
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
    subtotal: overrides.subtotal ?? { currency: "USD", minorUnits: 5_000n },
    total: overrides.total ?? { currency: "USD", minorUnits: 5_000n },
    idempotencyKey: "idem-1",
    rawPayload,
  };
}

function evaluate(economicIntent: EconomicIntent): PolicyDecision {
  const measurements = [10_000, 10_025];
  return new PolicyEvaluator({
    generateId: () => "decision-1",
    monotonicMicros: () => measurements.shift() ?? 10_025,
  }).evaluate({
    now: NOW,
    mandate: mandate(),
    checkout: economicIntent,
    spend: {
      committedDailySpend: { currency: "USD", minorUnits: 0n },
      reservedDailySpend: { currency: "USD", minorUnits: 0n },
    },
    velocity: {
      transactionsLastMinute: 0,
      distinctMerchantsInWindow: 0,
      attemptedAmountLastMinute: { currency: "USD", minorUnits: 0n },
      merchantDomainsInWindow: [],
    },
  });
}

function allowedDecision(): PolicyDecision {
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
    policyVersion: 3,
    eligibleForDelegationAssertion: true,
    evaluationLatencyMicros: 25,
    evaluatedAt: NOW,
  };
}

function source(pathFromTest: string): string {
  return readFileSync(fileURLToPath(new URL(pathFromTest, import.meta.url)), "utf8");
}

describe("provider-independence invariants", () => {
  it("keeps policy meaning invariant when only provider provenance changes", () => {
    const acp = evaluate(intent("ACP", { checkout_session_id: "cs_1", secret: "acp-only" }));
    const stripe = evaluate(intent("STRIPE", { payment_intent: "pi_1", secret: "stripe-only" }));

    expect(acp.verdict).toBe(DecisionVerdict.ALLOW);
    expect(stripe).toEqual(acp);
  });

  it("does not confuse provider independence with economic equivalence", () => {
    const allowed = evaluate(intent("ACP", { checkout_session_id: "cs_1" }));
    const materiallyDifferent = evaluate(
      intent(
        "STRIPE",
        { payment_intent: "pi_1" },
        {
          subtotal: { currency: "USD", minorUnits: 15_000n },
          total: { currency: "USD", minorUnits: 15_000n },
        },
      ),
    );

    expect(allowed.verdict).toBe(DecisionVerdict.ALLOW);
    expect(materiallyDifferent.verdict).toBe(DecisionVerdict.BLOCK);
  });

  it("produces the identical signed authorization grant when only provider provenance changes", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const issuer = new AuthorizationGrantService(
      { keyId: "grant-k1", privateKey },
      () => "grant-1",
      { issuer: "https://mino.example" },
    );

    const acp = issuer.issue(
      intent("ACP", { checkout_session_id: "cs_1", provider_secret: "never-bind-me" }),
      allowedDecision(),
      NOW,
    );
    const stripe = issuer.issue(
      intent("STRIPE", { payment_intent: "pi_1", provider_secret: "also-never-bind-me" }),
      allowedDecision(),
      NOW,
    );

    expect(stripe.claims).toEqual(acp.claims);
    expect(stripe.token).toBe(acp.token);
  });

  it("keeps provider implementations out of the neutral policy, grant, and adapter contracts", () => {
    const neutralSources = [
      "../../src/modules/policy/economic-policy-evaluator.ts",
      "../../src/modules/authorization/authorization-grant.service.ts",
      "../../src/modules/execution/execution-adapter.ts",
      "../../src/modules/execution/economic-reconciliation-adapter.ts",
    ].map(source);

    const forbiddenProviderImports = [
      /from\s+["'][^"']*acp-[^"']*["']/i,
      /from\s+["'][^"']*proxy\/merchant-client[^"']*["']/i,
      /from\s+["'][^"']*acp-adapter[^"']*["']/i,
      /from\s+["'][^"']*acp-execution-adapter[^"']*["']/i,
      /from\s+["'][^"']*acp-reconciliation-adapter[^"']*["']/i,
    ];

    for (const contents of neutralSources) {
      for (const forbidden of forbiddenProviderImports) {
        expect(contents).not.toMatch(forbidden);
      }
    }
  });

  it("confines the reconciler's ACP compatibility bridge to construction, not state interpretation", () => {
    const reconciler = source("../../src/modules/payments/background-payment-reconciler.ts");
    const reconcileOne = reconciler.slice(reconciler.indexOf("private async reconcileOne"));

    expect(reconciler).toContain("ACPReconciliationAdapter");
    expect(reconcileOne).toContain("this.deps.reconciliation.reconcile(outcome)");
    expect(reconcileOne).not.toMatch(/ACPReconciliationAdapter|ACPMerchantClient|parseCheckoutSession|merchantClient/);
  });
});
