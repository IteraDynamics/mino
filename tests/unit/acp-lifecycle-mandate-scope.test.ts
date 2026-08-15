import { describe, expect, it } from "vitest";
import { ApprovalMode, type AgentSpendMandate } from "../../src/domain/mandates/mandate.types.js";
import { isMerchantApprovedForMandate } from "../../src/modules/proxy/checkout-lifecycle-proxy.service.js";

function mandate(overrides: Partial<AgentSpendMandate> = {}): AgentSpendMandate {
  return {
    id: "mandate-scope",
    organizationId: "org-scope",
    userId: "user-scope",
    agentId: "agent-scope",
    policyId: "policy-scope",
    policyVersion: 1,
    currency: "USD",
    maxBudgetPerTransactionMinor: 10_000n,
    rollingDailyLimitMinor: 50_000n,
    approvedMerchantDomains: ["example.com"],
    approvedVendorIds: [],
    restrictedCategories: [],
    approvalMode: ApprovalMode.AUTO_APPROVE,
    velocity: {
      maxTransactionsPerMinute: 5,
      crossMerchantWindowSeconds: 60,
      maxDistinctMerchantsInWindow: 3,
    },
    issuedAt: new Date("2026-08-15T00:00:00.000Z"),
    expiresAt: new Date("2026-08-16T00:00:00.000Z"),
    signingKeyId: "mandate-key-1",
    tokenJtiHash: "a".repeat(64),
    ...overrides,
  };
}

describe("ACP lifecycle mandate merchant scope", () => {
  it("allows an exact approved merchant domain", () => {
    expect(
      isMerchantApprovedForMandate(mandate(), {
        domain: "example.com",
      }),
    ).toBe(true);
  });

  it("allows a boundary-safe subdomain of an approved merchant domain", () => {
    expect(
      isMerchantApprovedForMandate(mandate(), {
        domain: "shop.example.com",
      }),
    ).toBe(true);
  });

  it("rejects suffix lookalikes outside the approved domain boundary", () => {
    expect(
      isMerchantApprovedForMandate(mandate(), {
        domain: "example.com.evil.test",
      }),
    ).toBe(false);
  });

  it("allows an explicitly approved vendor id even when the domain is different", () => {
    expect(
      isMerchantApprovedForMandate(
        mandate({ approvedMerchantDomains: [], approvedVendorIds: ["vendor-approved"] }),
        { domain: "merchant.vendor.test", vendorId: "vendor-approved" },
      ),
    ).toBe(true);
  });
});
