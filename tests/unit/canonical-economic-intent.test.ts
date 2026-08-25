import { describe, expect, it } from "vitest";
import {
  authorityReferenceFromMandate,
  bindEconomicIntent,
} from "../../src/domain/economic/canonical-economic-intent.js";
import { ApprovalMode, type AgentSpendMandate } from "../../src/domain/mandates/mandate.types.js";
import { sha256Base64Url } from "../../src/infrastructure/crypto/canonical-json.js";
import type { EconomicIntent } from "../../src/domain/economic/economic-intent.types.js";

const mandate: AgentSpendMandate = {
  id: "mandate-1",
  organizationId: "org-1",
  userId: "user-1",
  agentId: "agent-1",
  policyId: "policy-1",
  policyVersion: 7,
  currency: "USD",
  maxBudgetPerTransactionMinor: 10_000n,
  rollingDailyLimitMinor: 30_000n,
  approvedMerchantDomains: ["shop.example"],
  approvedVendorIds: [],
  restrictedCategories: [],
  approvalMode: ApprovalMode.OWNER_APPROVAL,
  velocity: {
    maxTransactionsPerMinute: 10,
    crossMerchantWindowSeconds: 60,
    maxDistinctMerchantsInWindow: 5,
  },
  issuedAt: new Date("2026-08-25T12:00:00.000Z"),
  expiresAt: new Date("2026-09-25T12:00:00.000Z"),
  signingKeyId: "mino-k1",
};

function intent(overrides: Partial<EconomicIntent> = {}): EconomicIntent {
  return {
    requestId: "request-1",
    protocol: "ACP",
    operation: "COMPLETE_CHECKOUT",
    organizationId: "org-1",
    userId: "user-1",
    agentId: "agent-1",
    merchant: { domain: "shop.example" },
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
    authoritativeStateDigest: sha256Base64Url("provider-state-v1"),
    rawPayload: { arbitrary: "provider evidence" },
    ...overrides,
  } as EconomicIntent;
}

describe("canonical EconomicIntent", () => {
  it("is stable across transport retries and ignores arbitrary raw payload", () => {
    const authority = authorityReferenceFromMandate(mandate);
    const first = bindEconomicIntent(intent(), authority);
    const retry = bindEconomicIntent(
      intent({
        requestId: "request-2",
        rawPayload: { arbitrary: "changed evidence formatting", agent_says: "trust me" },
      }),
      authority,
    );

    expect(retry.intentDigest).toBe(first.intentDigest);
  });

  it("changes when authoritative provider state, economics, or delegated authority changes", () => {
    const authority = authorityReferenceFromMandate(mandate);
    const base = bindEconomicIntent(intent(), authority).intentDigest;

    expect(
      bindEconomicIntent(
        intent({ authoritativeStateDigest: sha256Base64Url("provider-state-v2") }),
        authority,
      ).intentDigest,
    ).not.toBe(base);

    expect(
      bindEconomicIntent(
        intent({ total: { currency: "USD", minorUnits: 5_001n } }),
        authority,
      ).intentDigest,
    ).not.toBe(base);

    expect(
      bindEconomicIntent(intent(), { ...authority, policyVersion: 8 }).intentDigest,
    ).not.toBe(base);
  });

  it("deep-freezes the canonical object and excludes transport/raw fields", () => {
    const bound = bindEconomicIntent(intent(), authorityReferenceFromMandate(mandate));
    expect(Object.isFrozen(bound.canonicalIntent)).toBe(true);
    expect(Object.isFrozen(bound.canonicalIntent.economics)).toBe(true);
    expect(Object.isFrozen(bound.canonicalIntent.economics.cart)).toBe(true);
    expect(bound.canonicalIntent).not.toHaveProperty("requestId");
    expect(bound.canonicalIntent).not.toHaveProperty("rawPayload");
  });

  it("fails closed without provider-authoritative state evidence", () => {
    expect(() =>
      bindEconomicIntent(
        intent({ authoritativeStateDigest: undefined }),
        authorityReferenceFromMandate(mandate),
      ),
    ).toThrow(/authoritative-state digest/i);
  });
});
