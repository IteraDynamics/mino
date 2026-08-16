import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AdminMerchantAdministrationRouteDependencies } from "../../src/api/admin-merchant-administration.routes.js";
import { createApp } from "../../src/app.js";
import type { CheckoutProxyService } from "../../src/modules/proxy/checkout-proxy.service.js";

function proxyStub(): CheckoutProxyService {
  return {} as CheckoutProxyService;
}

function merchant(organizationId: string) {
  return {
    id: randomUUID(),
    organizationId,
    externalMerchantId: "merchant-alpha",
    domain: "shop.example.com",
    vendorId: "vendor-1",
    baseUrl: "https://shop.example.com",
    active: false,
    createdAt: "2026-08-16T15:00:00.000Z",
    updatedAt: "2026-08-16T15:00:00.000Z",
  };
}

function allowedDependencies(
  organizationId: string,
  onPermission?: (permission: string) => void,
): AdminMerchantAdministrationRouteDependencies {
  const current = merchant(organizationId);
  return {
    authenticator: {
      authenticateAuthorizationHeader: () => ({
        authenticated: true as const,
        issuer: "https://id.example",
        subject: "security-admin",
      }),
    },
    authorizer: {
      authorize: async (request) => {
        onPermission?.(request.permission);
        return {
          allowed: true as const,
          principalId: randomUUID(),
          membershipId: randomUUID(),
          organizationId,
          permission: request.permission,
          roles: ["SECURITY_ADMIN" as const],
        };
      },
    },
    merchantAdministration: {
      getMerchant: async () => current,
      createMerchant: async () => ({
        outcome: "CREATED" as const,
        requestId: randomUUID(),
        merchant: current,
        audit: {
          chainSequence: "1",
          eventDigest: "event",
          chainDigest: "chain",
          signingKeyId: "audit-k1",
        },
      }),
      updateConfiguration: async () => ({
        outcome: "REPLAYED" as const,
        requestId: randomUUID(),
        merchant: current,
      }),
      activate: async () => ({
        outcome: "REPLAYED" as const,
        requestId: randomUUID(),
        merchant: { ...current, active: true },
      }),
      deactivate: async () => ({
        outcome: "REPLAYED" as const,
        requestId: randomUUID(),
        merchant: current,
      }),
    },
  };
}

describe("admin merchant administration routes", () => {
  it("authorizes merchant.manage and forwards authenticated actor context on creation", async () => {
    const organizationId = randomUUID();
    const principalId = randomUUID();
    const membershipId = randomUUID();
    const current = merchant(organizationId);
    let seenActor: unknown;
    let seenPermission: string | undefined;

    const dependencies: AdminMerchantAdministrationRouteDependencies = {
      authenticator: {
        authenticateAuthorizationHeader: () => ({
          authenticated: true as const,
          issuer: "https://id.example",
          subject: "security-admin",
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
            roles: ["SECURITY_ADMIN" as const],
          };
        },
      },
      merchantAdministration: {
        getMerchant: async () => undefined,
        createMerchant: async (actor) => {
          seenActor = actor;
          return {
            outcome: "CREATED" as const,
            requestId: randomUUID(),
            merchant: current,
            audit: {
              chainSequence: "1",
              eventDigest: "event",
              chainDigest: "chain",
              signingKeyId: "audit-k1",
            },
          };
        },
        updateConfiguration: async () => ({ outcome: "NOT_FOUND" as const, requestId: randomUUID() }),
        activate: async () => ({ outcome: "NOT_FOUND" as const, requestId: randomUUID() }),
        deactivate: async () => ({ outcome: "NOT_FOUND" as const, requestId: randomUUID() }),
      },
    };

    const app = await createApp({ proxy: proxyStub(), adminMerchantAdministration: dependencies });
    const response = await app.inject({
      method: "POST",
      url: `/v1/admin/organizations/${organizationId}/merchants`,
      headers: { authorization: "Bearer token" },
      payload: {
        externalMerchantId: "merchant-alpha",
        domain: "shop.example.com",
        vendorId: "vendor-1",
        baseUrl: "https://shop.example.com",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(seenPermission).toBe("merchant.manage");
    expect(seenActor).toEqual({
      principalId,
      membershipId,
      organizationId,
      roles: ["SECURITY_ADMIN"],
    });
    await app.close();
  });

  it("uses merchant.read for detail and merchant.manage for configuration and lifecycle", async () => {
    const organizationId = randomUUID();
    const merchantId = randomUUID();
    const permissions: string[] = [];
    const app = await createApp({
      proxy: proxyStub(),
      adminMerchantAdministration: allowedDependencies(organizationId, (permission) => permissions.push(permission)),
    });
    const headers = { authorization: "Bearer token" };
    const base = `/v1/admin/organizations/${organizationId}/merchants/${merchantId}`;

    expect((await app.inject({ method: "GET", url: base, headers })).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${base}/configuration`,
          headers,
          payload: {
            domain: "shop.example.com",
            vendorId: "vendor-1",
            baseUrl: "https://shop.example.com",
          },
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject({ method: "POST", url: `${base}/activate`, headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `${base}/deactivate`, headers })).statusCode).toBe(200);
    expect(permissions).toEqual(["merchant.read", "merchant.manage", "merchant.manage", "merchant.manage"]);
    await app.close();
  });

  it("rejects credential-like or malformed fields before authorization or persistence", async () => {
    const organizationId = randomUUID();
    let authorized = false;
    let persisted = false;
    const dependencies = allowedDependencies(organizationId);
    dependencies.authorizer.authorize = async () => {
      authorized = true;
      throw new Error("must not authorize");
    };
    dependencies.merchantAdministration.createMerchant = async () => {
      persisted = true;
      throw new Error("must not persist");
    };

    const app = await createApp({ proxy: proxyStub(), adminMerchantAdministration: dependencies });
    const response = await app.inject({
      method: "POST",
      url: `/v1/admin/organizations/${organizationId}/merchants`,
      headers: { authorization: "Bearer token" },
      payload: {
        externalMerchantId: "merchant-alpha",
        domain: "shop.example.com",
        baseUrl: "https://shop.example.com",
        authorization: "Bearer must-never-enter-admin-payload",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(authorized).toBe(false);
    expect(persisted).toBe(false);
    await app.close();
  });

  it("returns 403 before merchant mutation when merchant.manage is absent", async () => {
    const organizationId = randomUUID();
    let called = false;
    const dependencies = allowedDependencies(organizationId);
    dependencies.authorizer.authorize = async (request) => ({
      allowed: false as const,
      permission: request.permission,
      reason: "PERMISSION_DENIED" as const,
    });
    dependencies.merchantAdministration.createMerchant = async () => {
      called = true;
      throw new Error("must not run");
    };

    const app = await createApp({ proxy: proxyStub(), adminMerchantAdministration: dependencies });
    const response = await app.inject({
      method: "POST",
      url: `/v1/admin/organizations/${organizationId}/merchants`,
      headers: { authorization: "Bearer token" },
      payload: {
        externalMerchantId: "merchant-alpha",
        domain: "shop.example.com",
        baseUrl: "https://shop.example.com",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(called).toBe(false);
    await app.close();
  });
});