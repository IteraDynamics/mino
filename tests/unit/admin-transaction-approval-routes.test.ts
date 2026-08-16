import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { AdminTransactionApprovalRouteDependencies } from "../../src/api/admin-transaction-approval.routes.js";
import type { CheckoutProxyService } from "../../src/modules/proxy/checkout-proxy.service.js";

function proxyStub(): CheckoutProxyService {
  return {} as CheckoutProxyService;
}

function approval(organizationId: string) {
  return {
    id: randomUUID(),
    organizationId,
    userId: randomUUID(),
    agentId: randomUUID(),
    mandateId: randomUUID(),
    decisionId: randomUUID(),
    requestId: randomUUID(),
    policyVersion: 3,
    merchantId: "merchant-1",
    merchantDomain: "shop.example.com",
    checkoutSessionId: "checkout-1",
    reasonCodes: ["TRANSACTION_LIMIT_EXCEEDED"],
    amountMinor: "9007199254740993000",
    currency: "USD",
    status: "PENDING" as const,
    requiredSignatures: 2,
    voteCount: 0,
    approveCount: 0,
    rejectCount: 0,
    createdAt: "2026-08-16T17:00:00.000Z",
    expiresAt: "2026-08-16T18:00:00.000Z",
  };
}

function payment(organizationId: string) {
  return {
    id: randomUUID(),
    organizationId,
    userId: randomUUID(),
    agentId: randomUUID(),
    mandateId: randomUUID(),
    reservationId: "reservation-1",
    merchantId: "merchant-1",
    merchantDomain: "shop.example.com",
    checkoutSessionId: "checkout-1",
    amountMinor: "9007199254740993000",
    currency: "USD",
    status: "UNKNOWN" as const,
    reconciliationState: "PENDING" as const,
    lastErrorCode: "MERCHANT_TRANSPORT_ERROR",
    reconcileAttempts: 2,
    createdAt: "2026-08-16T17:00:00.000Z",
    updatedAt: "2026-08-16T17:05:00.000Z",
    nextReconcileAt: "2026-08-16T17:10:00.000Z",
  };
}

function dependencies(
  organizationId: string,
  hooks: {
    readonly authorize?: (permission: string) => boolean;
    readonly onApprovalList?: (filter: unknown) => void;
    readonly onVote?: (actor: unknown, request: unknown) => void;
  } = {},
): AdminTransactionApprovalRouteDependencies {
  const currentApproval = approval(organizationId);
  const currentPayment = payment(organizationId);
  return {
    authenticator: {
      authenticateAuthorizationHeader: () => ({
        authenticated: true as const,
        issuer: "https://id.example",
        subject: "operator",
      }),
    },
    authorizer: {
      authorize: async (request) => {
        if (hooks.authorize && !hooks.authorize(request.permission)) {
          return {
            allowed: false as const,
            permission: request.permission,
            reason: "PERMISSION_DENIED" as const,
          };
        }
        return {
          allowed: true as const,
          principalId: "11111111-1111-4111-8111-111111111111",
          membershipId: "22222222-2222-4222-8222-222222222222",
          organizationId,
          permission: request.permission,
          roles: ["APPROVER" as const],
        };
      },
    },
    operations: {
      listApprovals: async (_organizationId, filter) => {
        hooks.onApprovalList?.(filter);
        return { items: [currentApproval] };
      },
      getApproval: async () => currentApproval,
      castApprovalVote: async (actor, _approvalRequestId, request) => {
        hooks.onVote?.(actor, request);
        return {
          outcome: "UPDATED" as const,
          requestId: randomUUID(),
          approval: {
            ...currentApproval,
            status: "APPROVED" as const,
            voteCount: 2,
            approveCount: 2,
            resolvedAt: "2026-08-16T17:15:00.000Z",
          },
          audit: {
            chainSequence: "1",
            eventDigest: "event",
            chainDigest: "chain",
            signingKeyId: "audit-k1",
          },
        };
      },
      listPayments: async () => ({ items: [currentPayment] }),
      getPayment: async () => currentPayment,
    },
  };
}

describe("admin transaction and approval routes", () => {
  it("maps approval and payment reads to narrow permissions and forwards bounded filters", async () => {
    const organizationId = randomUUID();
    const permissions: string[] = [];
    let capturedFilter: unknown;
    const deps = dependencies(organizationId, {
      authorize: (permission) => {
        permissions.push(permission);
        return true;
      },
      onApprovalList: (filter) => {
        capturedFilter = filter;
      },
    });
    const app = await createApp({ proxy: proxyStub(), adminTransactionApproval: deps });
    const headers = { authorization: "Bearer token" };

    const approvalList = await app.inject({
      method: "GET",
      url: `/v1/admin/organizations/${organizationId}/approvals?status=PENDING&limit=25&merchantId=merchant-1`,
      headers,
    });
    expect(approvalList.statusCode).toBe(200);
    expect(approvalList.headers["cache-control"]).toBe("no-store");
    expect(capturedFilter).toMatchObject({ status: "PENDING", limit: 25, merchantId: "merchant-1" });

    const approvalId = approvalList.json<{ items: Array<{ id: string }> }>().items[0]!.id;
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v1/admin/organizations/${organizationId}/approvals/${approvalId}`,
          headers,
        })
      ).statusCode,
    ).toBe(200);

    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v1/admin/organizations/${organizationId}/payments?status=UNKNOWN`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v1/admin/organizations/${organizationId}/payments/${randomUUID()}`,
          headers,
        })
      ).statusCode,
    ).toBe(200);

    expect(permissions).toEqual([
      "approval.read",
      "approval.read",
      "payment.read",
      "payment.read",
    ]);
    await app.close();
  });

  it("uses approval.vote and forwards the stable admin actor without a second approval auth path", async () => {
    const organizationId = randomUUID();
    let capturedActor: unknown;
    let capturedRequest: unknown;
    const app = await createApp({
      proxy: proxyStub(),
      adminTransactionApproval: dependencies(organizationId, {
        onVote: (actor, request) => {
          capturedActor = actor;
          capturedRequest = request;
        },
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/admin/organizations/${organizationId}/approvals/${randomUUID()}/votes`,
      headers: { authorization: "Bearer token" },
      payload: { decision: "APPROVE", comment: " reviewed " },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({ outcome: "UPDATED", changed: true });
    expect(capturedActor).toMatchObject({
      principalId: "11111111-1111-4111-8111-111111111111",
      membershipId: "22222222-2222-4222-8222-222222222222",
      organizationId,
      roles: ["APPROVER"],
    });
    expect(capturedRequest).toEqual({ decision: "APPROVE", comment: " reviewed " });
    await app.close();
  });

  it("rejects malformed filters and vote bodies before authorization or persistence", async () => {
    const organizationId = randomUUID();
    let authorized = false;
    let voted = false;
    const deps = dependencies(organizationId, {
      authorize: () => {
        authorized = true;
        return true;
      },
      onVote: () => {
        voted = true;
      },
    });
    const app = await createApp({ proxy: proxyStub(), adminTransactionApproval: deps });

    const invalidQuery = await app.inject({
      method: "GET",
      url: `/v1/admin/organizations/${organizationId}/approvals?status=NOT_A_STATUS&secret=x`,
      headers: { authorization: "Bearer token" },
    });
    expect(invalidQuery.statusCode).toBe(400);
    expect(invalidQuery.headers["cache-control"]).toBe("no-store");

    const invalidVote = await app.inject({
      method: "POST",
      url: `/v1/admin/organizations/${organizationId}/approvals/${randomUUID()}/votes`,
      headers: { authorization: "Bearer token" },
      payload: { decision: "FORCE_APPROVE", secret: "nope" },
    });
    expect(invalidVote.statusCode).toBe(400);
    expect(authorized).toBe(false);
    expect(voted).toBe(false);
    await app.close();
  });

  it("returns 403 before a vote when approval.vote is absent", async () => {
    const organizationId = randomUUID();
    let voted = false;
    const app = await createApp({
      proxy: proxyStub(),
      adminTransactionApproval: dependencies(organizationId, {
        authorize: (permission) => permission !== "approval.vote",
        onVote: () => {
          voted = true;
        },
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/admin/organizations/${organizationId}/approvals/${randomUUID()}/votes`,
      headers: { authorization: "Bearer token" },
      payload: { decision: "REJECT" },
    });
    expect(response.statusCode).toBe(403);
    expect(voted).toBe(false);
    await app.close();
  });
});
