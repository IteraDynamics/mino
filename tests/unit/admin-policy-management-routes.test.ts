import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { AdminPolicyManagementRouteDependencies } from "../../src/api/admin-policy-management.routes.js";
import type { CheckoutProxyService } from "../../src/modules/proxy/checkout-proxy.service.js";

function proxyStub(): CheckoutProxyService {
  return {} as CheckoutProxyService;
}

const policyBody = {
  name: "Procurement",
  baseCurrency: "USD",
  maxBudgetMinor: "25000",
  rollingDailyLimitMinor: "100000",
  approvedMerchantDomains: ["example.com"],
  approvedVendorIds: ["vendor-1"],
  restrictedCategories: ["GAMBLING"],
  approvalMode: "DUAL_SIGNATURE_SLACK" as const,
  maxTransactionsPerMinute: 10,
  crossMerchantWindowSecs: 60,
  maxDistinctMerchants: 5,
};

function policy(organizationId: string) {
  return {
    id: randomUUID(),
    organizationId,
    name: "Procurement",
    version: 1,
    active: false,
    baseCurrency: "USD",
    maxBudgetMinor: "25000",
    rollingDailyLimitMinor: "100000",
    approvedMerchantDomains: ["example.com"],
    approvedVendorIds: ["vendor-1"],
    restrictedCategories: ["GAMBLING"],
    approvalMode: "DUAL_SIGNATURE_SLACK" as const,
    maxTransactionsPerMinute: 10,
    crossMerchantWindowSecs: 60,
    maxDistinctMerchants: 5,
    createdAt: "2026-08-16T14:00:00.000Z",
    updatedAt: "2026-08-16T14:00:00.000Z",
  };
}

describe("admin policy management routes", () => {
  it("authorizes policy.create and forwards the authenticated actor", async () => {
    const organizationId = randomUUID();
    const principalId = randomUUID();
    const membershipId = randomUUID();
    let seenActor: unknown;
    let seenPermission: string | undefined;

    const dependencies: AdminPolicyManagementRouteDependencies = {
      authenticator: {
        authenticateAuthorizationHeader: () => ({
          authenticated: true as const,
          issuer: "https://id.example",
          subject: "finance-admin",
        }),
      },
      authorizer: {
        authorize: async (request) => {
          seenPermission = request.permission;
          return {
            allowed: true as const,
            principalId,
            membershipId,
            organizationId,
            permission: request.permission,
            roles: ["FINANCE_MANAGER" as const],
          };
        },
      },
      policyManagement: {
        getPolicy: async () => undefined,
        createPolicy: async (actor) => {
          seenActor = actor;
          return {
            outcome: "CREATED" as const,
            requestId: randomUUID(),
            policy: policy(organizationId),
            audit: {
              chainSequence: "1",
              eventDigest: "event",
              chainDigest: "chain",
              signingKeyId: "audit-k1",
            },
          };
        },
        createVersion: async () => ({ outcome: "CONFLICT" as const, requestId: randomUUID() }),
        activate: async () => ({ outcome: "NOT_FOUND" as const, requestId: randomUUID() }),
        deactivate: async () => ({ outcome: "NOT_FOUND" as const, requestId: randomUUID() }),
      },
    };

    const app = await createApp({ proxy: proxyStub(), adminPolicyManagement: dependencies });
    const response = await app.inject({
      method: "POST",
      url: `/v1/admin/organizations/${organizationId}/policies`,
      headers: { authorization: "Bearer token" },
      payload: policyBody,
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(seenPermission).toBe("policy.create");
    expect(seenActor).toEqual({
      principalId,
      membershipId,
      organizationId,
      roles: ["FINANCE_MANAGER"],
    });
    await app.close();
  });

  it("uses distinct activate/deactivate permissions", async () => {
    const organizationId = randomUUID();
    const policyId = randomUUID();
    const permissions: string[] = [];
    const current = policy(organizationId);
    const app = await createApp({
      proxy: proxyStub(),
      adminPolicyManagement: {
        authenticator: {
          authenticateAuthorizationHeader: () => ({
            authenticated: true as const,
            issuer: "https://id.example",
            subject: "finance-admin",
          }),
        },
        authorizer: {
          authorize: async (request) => {
            permissions.push(request.permission);
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
        policyManagement: {
          getPolicy: async () => current,
          createPolicy: async () => ({ outcome: "CONFLICT" as const, requestId: randomUUID() }),
          createVersion: async () => ({ outcome: "CONFLICT" as const, requestId: randomUUID() }),
          activate: async () => ({
            outcome: "REPLAYED" as const,
            requestId: randomUUID(),
            policy: { ...current, active: true },
          }),
          deactivate: async () => ({
            outcome: "REPLAYED" as const,
            requestId: randomUUID(),
            policy: current,
          }),
        },
      },
    });

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/admin/organizations/${organizationId}/policies/${policyId}/activate`,
          headers: { authorization: "Bearer token" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/admin/organizations/${organizationId}/policies/${policyId}/deactivate`,
          headers: { authorization: "Bearer token" },
        })
      ).statusCode,
    ).toBe(200);
    expect(permissions).toEqual(["policy.activate", "policy.deactivate"]);
    await app.close();
  });

  it("fails malformed policy configuration before authorization or persistence", async () => {
    const organizationId = randomUUID();
    let authorized = false;
    let persisted = false;
    const app = await createApp({
      proxy: proxyStub(),
      adminPolicyManagement: {
        authenticator: {
          authenticateAuthorizationHeader: () => ({
            authenticated: true as const,
            issuer: "https://id.example",
            subject: "finance-admin",
          }),
        },
        authorizer: {
          authorize: async () => {
            authorized = true;
            throw new Error("must not authorize");
          },
        },
        policyManagement: {
          getPolicy: async () => undefined,
          createPolicy: async () => {
            persisted = true;
            throw new Error("must not persist");
          },
          createVersion: async () => ({ outcome: "CONFLICT" as const, requestId: randomUUID() }),
          activate: async () => ({ outcome: "NOT_FOUND" as const, requestId: randomUUID() }),
          deactivate: async () => ({ outcome: "NOT_FOUND" as const, requestId: randomUUID() }),
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/admin/organizations/${organizationId}/policies`,
      headers: { authorization: "Bearer token" },
      payload: { ...policyBody, maxBudgetMinor: 25000 },
    });
    expect(response.statusCode).toBe(400);
    expect(authorized).toBe(false);
    expect(persisted).toBe(false);
    await app.close();
  });

  it("returns 403 before policy mutation when permission is absent", async () => {
    const organizationId = randomUUID();
    let called = false;
    const app = await createApp({
      proxy: proxyStub(),
      adminPolicyManagement: {
        authenticator: {
          authenticateAuthorizationHeader: () => ({
            authenticated: true as const,
            issuer: "https://id.example",
            subject: "auditor",
          }),
        },
        authorizer: {
          authorize: async (request) => ({
            allowed: false as const,
            permission: request.permission,
            reason: "PERMISSION_DENIED" as const,
          }),
        },
        policyManagement: {
          getPolicy: async () => undefined,
          createPolicy: async () => {
            called = true;
            throw new Error("must not run");
          },
          createVersion: async () => ({ outcome: "CONFLICT" as const, requestId: randomUUID() }),
          activate: async () => ({ outcome: "NOT_FOUND" as const, requestId: randomUUID() }),
          deactivate: async () => ({ outcome: "NOT_FOUND" as const, requestId: randomUUID() }),
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/admin/organizations/${organizationId}/policies`,
      headers: { authorization: "Bearer token" },
      payload: policyBody,
    });
    expect(response.statusCode).toBe(403);
    expect(called).toBe(false);
    await app.close();
  });
});
