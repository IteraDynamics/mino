import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { AdminTransactionApprovalRouteDependencies } from "../../src/api/admin-transaction-approval.routes.js";
import {
  presentAdminEconomicRecord,
} from "../../src/modules/admin/provider-neutral-economic-presentation.js";
import type { CheckoutProxyService } from "../../src/modules/proxy/checkout-proxy.service.js";

function proxyStub(): CheckoutProxyService {
  return {} as CheckoutProxyService;
}

function authorizationDependencies(
  organizationId: string,
): Pick<AdminTransactionApprovalRouteDependencies, "authenticator" | "authorizer"> {
  return {
    authenticator: {
      authenticateAuthorizationHeader: () => ({
        authenticated: true as const,
        issuer: "https://id.example",
        subject: "operator",
      }),
    },
    authorizer: {
      authorize: async (request) => ({
        allowed: true as const,
        principalId: "11111111-1111-4111-8111-111111111111",
        membershipId: "22222222-2222-4222-8222-222222222222",
        organizationId,
        permission: request.permission,
        roles: ["AUDITOR" as const],
      }),
    },
  };
}

function routeDependencies(organizationId: string): AdminTransactionApprovalRouteDependencies {
  const approval = {
    id: randomUUID(),
    organizationId,
    userId: randomUUID(),
    agentId: randomUUID(),
    mandateId: randomUUID(),
    decisionId: randomUUID(),
    requestId: randomUUID(),
    policyVersion: 1,
    merchantId: "merchant-1",
    merchantDomain: "supplier.example",
    checkoutSessionId: "cs_approval",
    reasonCodes: ["HUMAN_APPROVAL_REQUIRED"],
    amountMinor: "250000",
    currency: "USD",
    status: "PENDING" as const,
    requiredSignatures: 2,
    voteCount: 0,
    approveCount: 0,
    rejectCount: 0,
    createdAt: "2026-08-19T18:00:00.000Z",
    expiresAt: "2026-08-19T19:00:00.000Z",
  };
  const payment = {
    id: randomUUID(),
    organizationId,
    userId: randomUUID(),
    agentId: randomUUID(),
    mandateId: randomUUID(),
    reservationId: "reservation-1",
    merchantId: "merchant-1",
    merchantDomain: "supplier.example",
    checkoutSessionId: "cs_payment",
    amountMinor: "5000",
    currency: "USD",
    status: "SUCCEEDED" as const,
    reconciliationState: "RESOLVED" as const,
    reconcileAttempts: 0,
    createdAt: "2026-08-19T18:00:00.000Z",
    updatedAt: "2026-08-19T18:00:01.000Z",
    resolvedAt: "2026-08-19T18:00:01.000Z",
  };

  return {
    ...authorizationDependencies(organizationId),
    operations: {
      listApprovals: async () => ({ items: [approval] }),
      getApproval: async () => approval,
      castApprovalVote: async () => ({
        outcome: "REPLAYED" as const,
        requestId: randomUUID(),
        approval,
      }),
      listPayments: async () => ({ items: [payment] }),
      getPayment: async () => payment,
    },
  };
}

describe("provider-neutral admin presentation", () => {
  it("projects legacy transaction audit facts into provider-neutral economic vocabulary", () => {
    const presented = presentAdminEconomicRecord({
      protocol: "ACP",
      merchantDomain: "supplier.example",
      merchantVendorId: "vendor-42",
      checkoutSessionId: "cs_123",
      verdict: "ALLOW",
    });

    expect(presented.economic).toEqual({
      provider: { protocol: "ACP" },
      counterparty: {
        kind: "MERCHANT",
        identifiers: [
          { scheme: "DOMAIN", value: "supplier.example" },
          { scheme: "VENDOR_ID", value: "vendor-42" },
        ],
      },
      executionReference: "cs_123",
    });
    expect(presented.merchantDomain).toBe("supplier.example");
  });

  it("adds neutral economic presentation to approval and payment admin responses without breaking legacy fields", async () => {
    const organizationId = randomUUID();
    const app = await createApp({
      proxy: proxyStub(),
      adminTransactionApproval: routeDependencies(organizationId),
    });
    const headers = { authorization: "Bearer token" };

    const approvals = await app.inject({
      method: "GET",
      url: `/v1/admin/organizations/${organizationId}/approvals`,
      headers,
    });
    const payments = await app.inject({
      method: "GET",
      url: `/v1/admin/organizations/${organizationId}/payments`,
      headers,
    });

    expect(approvals.statusCode).toBe(200);
    expect(payments.statusCode).toBe(200);

    const approvalItem = approvals.json<{ items: Array<Record<string, unknown>> }>().items[0] as {
      merchantDomain: string;
      checkoutSessionId: string;
      economic: {
        counterparty: { kind: string; identifiers: Array<{ scheme: string; value: string }> };
        executionReference?: string;
      };
    };
    const paymentItem = payments.json<{ items: Array<Record<string, unknown>> }>().items[0] as {
      merchantDomain: string;
      checkoutSessionId: string;
      economic: {
        counterparty: { kind: string; identifiers: Array<{ scheme: string; value: string }> };
        executionReference?: string;
      };
    };

    expect(approvalItem.merchantDomain).toBe("supplier.example");
    expect(approvalItem.checkoutSessionId).toBe("cs_approval");
    expect(approvalItem.economic).toMatchObject({
      counterparty: {
        kind: "MERCHANT",
        identifiers: [{ scheme: "DOMAIN", value: "supplier.example" }],
      },
      executionReference: "cs_approval",
    });

    expect(paymentItem.merchantDomain).toBe("supplier.example");
    expect(paymentItem.checkoutSessionId).toBe("cs_payment");
    expect(paymentItem.economic).toMatchObject({
      counterparty: {
        kind: "MERCHANT",
        identifiers: [{ scheme: "DOMAIN", value: "supplier.example" }],
      },
      executionReference: "cs_payment",
    });

    await app.close();
  });
});
