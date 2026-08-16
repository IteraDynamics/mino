import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { AdminMandateManagementRouteDependencies } from "../../src/api/admin-mandate-management.routes.js";
import type { CheckoutProxyService } from "../../src/modules/proxy/checkout-proxy.service.js";

function proxyStub(): CheckoutProxyService {
  return {} as CheckoutProxyService;
}

function mandate(organizationId: string) {
  return {
    id: randomUUID(),
    organizationId,
    userId: randomUUID(),
    agentId: randomUUID(),
    policyId: randomUUID(),
    policyVersion: 2,
    currency: "USD",
    maxBudgetMinor: "25000",
    rollingDailyLimitMinor: "100000",
    approvedMerchantDomains: ["shop.example.com"],
    approvedVendorIds: ["vendor-1"],
    restrictedCategories: ["GAMBLING"],
    approvalMode: "DUAL_SIGNATURE_SLACK" as const,
    maxTransactionsPerMinute: 10,
    crossMerchantWindowSecs: 60,
    maxDistinctMerchants: 5,
    status: "ACTIVE" as const,
    issuedAt: "2026-08-16T15:30:00.000Z",
    expiresAt: "2026-09-16T15:30:00.000Z",
    signingKeyId: "mino-k1",
    tokenJtiHash: "jti-hash",
  };
}

function dependencies(
  organizationId: string,
  hooks: {
    readonly authorize?: (permission: string) => boolean;
    readonly onIssue?: (actor: unknown, request: unknown) => void;
  } = {},
): AdminMandateManagementRouteDependencies {
  const current = mandate(organizationId);
  return {
    authenticator: {
      authenticateAuthorizationHeader: () => ({
        authenticated: true as const,
        issuer: "https://id.example",
        subject: "finance-admin",
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
          principalId: randomUUID(),
          membershipId: randomUUID(),
          organizationId,
          permission: request.permission,
          roles: ["FINANCE_MANAGER" as const],
        };
      },
    },
    mandateManagement: {
      getMandate: async () => current,
      issue: async (actor, request) => {
        hooks.onIssue?.(actor, request);
        return {
          outcome: "CREATED" as const,
          requestId: randomUUID(),
          mandate: current,
          mandateToken: "header.claims.signature",
          audit: {
            chainSequence: "1",
            eventDigest: "event",
            chainDigest: "chain",
            signingKeyId: "audit-k1",
          },
        };
      },
      revoke: async () => ({
        outcome: "UPDATED" as const,
        requestId: randomUUID(),
        mandate: { ...current, status: "REVOKED" as const, revokedAt: "2026-08-16T15:40:00.000Z" },
        audit: {
          chainSequence: "2",
          eventDigest: "event-2",
          chainDigest: "chain-2",
          signingKeyId: "audit-k1",
        },
      }),
    },
  };
}

const issueBody = {
  userId: "11111111-1111-4111-8111-111111111111",
  agentId: "22222222-2222-4222-8222-222222222222",
  policyId: "33333333-3333-4333-8333-333333333333",
  expiresAt: "2026-09-16T15:30:00.000Z",
};

describe("admin mandate management routes", () => {
  it("authorizes mandate.issue, forwards actor and idempotency key, and returns the token only on creation", async () => {
    const organizationId = randomUUID();
    let capturedActor: unknown;
    let capturedRequest: unknown;
    const app = await createApp({
      proxy: proxyStub(),
      adminMandateManagement: dependencies(organizationId, {
        onIssue: (actor, request) => {
          capturedActor = actor;
          capturedRequest = request;
        },
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/admin/organizations/${organizationId}/mandates`,
      headers: {
        authorization: "Bearer token",
        "idempotency-key": "grant-procurement-2026-08-16",
      },
      payload: issueBody,
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      outcome: "CREATED",
      changed: true,
      mandateToken: "header.claims.signature",
    });
    expect(capturedActor).toMatchObject({ organizationId, roles: ["FINANCE_MANAGER"] });
    expect(capturedRequest).toEqual({
      ...issueBody,
      idempotencyKey: "grant-procurement-2026-08-16",
    });
    await app.close();
  });

  it("rejects malformed issuance before RBAC or persistence", async () => {
    const organizationId = randomUUID();
    let authorized = false;
    let issued = false;
    const deps = dependencies(organizationId, {
      authorize: () => {
        authorized = true;
        return true;
      },
      onIssue: () => {
        issued = true;
      },
    });
    const app = await createApp({ proxy: proxyStub(), adminMandateManagement: deps });

    for (const input of [
      { headers: { authorization: "Bearer token" }, payload: issueBody },
      {
        headers: { authorization: "Bearer token", "idempotency-key": "idem" },
        payload: { ...issueBody, userId: "not-a-uuid" },
      },
      {
        headers: { authorization: "Bearer token", "idempotency-key": "idem" },
        payload: { ...issueBody, secret: "must-not-be-accepted" },
      },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/admin/organizations/${organizationId}/mandates`,
        headers: input.headers,
        payload: input.payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.headers["cache-control"]).toBe("no-store");
    }

    expect(authorized).toBe(false);
    expect(issued).toBe(false);
    await app.close();
  });

  it("maps detail and revocation to mandate.read and mandate.revoke", async () => {
    const organizationId = randomUUID();
    const mandateId = randomUUID();
    const permissions: string[] = [];
    const app = await createApp({
      proxy: proxyStub(),
      adminMandateManagement: dependencies(organizationId, {
        authorize: (permission) => {
          permissions.push(permission);
          return true;
        },
      }),
    });

    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v1/admin/organizations/${organizationId}/mandates/${mandateId}`,
          headers: { authorization: "Bearer token" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/admin/organizations/${organizationId}/mandates/${mandateId}/revoke`,
          headers: { authorization: "Bearer token" },
        })
      ).statusCode,
    ).toBe(200);
    expect(permissions).toEqual(["mandate.read", "mandate.revoke"]);
    await app.close();
  });

  it("returns 403 before issuance when mandate.issue is absent", async () => {
    const organizationId = randomUUID();
    let issued = false;
    const app = await createApp({
      proxy: proxyStub(),
      adminMandateManagement: dependencies(organizationId, {
        authorize: (permission) => permission !== "mandate.issue",
        onIssue: () => {
          issued = true;
        },
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/admin/organizations/${organizationId}/mandates`,
      headers: { authorization: "Bearer token", "idempotency-key": "idem" },
      payload: issueBody,
    });
    expect(response.statusCode).toBe(403);
    expect(issued).toBe(false);
    await app.close();
  });

  it("does not redeliver a raw token on an issuance replay", async () => {
    const organizationId = randomUUID();
    const current = mandate(organizationId);
    const deps = dependencies(organizationId);
    deps.mandateManagement.issue = async () => ({
      outcome: "REPLAYED" as const,
      requestId: randomUUID(),
      mandate: current,
    });
    const app = await createApp({ proxy: proxyStub(), adminMandateManagement: deps });
    const response = await app.inject({
      method: "POST",
      url: `/v1/admin/organizations/${organizationId}/mandates`,
      headers: { authorization: "Bearer token", "idempotency-key": "idem" },
      payload: issueBody,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("mandateToken");
    expect(response.json()).toMatchObject({ outcome: "REPLAYED", changed: false });
    await app.close();
  });
});
