import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerAdminInventoryRoutes } from "../../src/api/admin-inventory.routes.js";
import type {
  AdminAuthorizationDecision,
  AdminAuthorizationRequest,
} from "../../src/modules/admin/admin-authorizer.js";
import type { AdminInventoryRepository } from "../../src/modules/admin/admin-inventory.js";
import type { AdminBearerAuthenticator } from "../../src/modules/admin/admin-jwt-authenticator.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const cursor = "22222222-2222-4222-8222-222222222222";

class CapturingAuthorizer {
  public requests: AdminAuthorizationRequest[] = [];

  public constructor(private readonly allow = true) {}

  public async authorize(request: AdminAuthorizationRequest): Promise<AdminAuthorizationDecision> {
    this.requests.push(request);
    return this.allow
      ? {
          allowed: true,
          principalId: "principal-1",
          membershipId: "membership-1",
          organizationId: request.organizationId,
          permission: request.permission,
          roles: ["AUDITOR"],
        }
      : { allowed: false, permission: request.permission, reason: "PERMISSION_DENIED" };
  }
}

class CapturingInventory implements AdminInventoryRepository {
  public agentRequests: unknown[] = [];
  public policyRequests: unknown[] = [];
  public merchantRequests: unknown[] = [];
  public mandateRequests: unknown[] = [];

  public async listAgents(input: unknown) {
    this.agentRequests.push(input);
    return { items: [{ id: "agent-1" }], nextCursor: "next-agent" } as never;
  }

  public async listPolicies(input: unknown) {
    this.policyRequests.push(input);
    return { items: [{ id: "policy-1" }] } as never;
  }

  public async listMerchants(input: unknown) {
    this.merchantRequests.push(input);
    return { items: [{ id: "merchant-1" }] } as never;
  }

  public async listMandates(input: unknown) {
    this.mandateRequests.push(input);
    return { items: [{ id: "mandate-1" }] } as never;
  }
}

const authenticator: AdminBearerAuthenticator = {
  authenticateAuthorizationHeader: () => ({
    authenticated: true,
    issuer: "https://login.example/",
    subject: "alice",
  }),
};

describe("admin inventory routes", () => {
  it("maps each resource route to its narrow read permission and forwards pagination", async () => {
    const authorizer = new CapturingAuthorizer();
    const inventory = new CapturingInventory();
    const app = Fastify();
    await registerAdminInventoryRoutes(app, { authenticator, authorizer, inventory });

    const headers = { authorization: "Bearer signed-token" };
    const agents = await app.inject({
      method: "GET",
      url: `/v1/admin/organizations/${organizationId}/agents?limit=25&cursor=${cursor}`,
      headers,
    });
    const policies = await app.inject({
      method: "GET",
      url: `/v1/admin/organizations/${organizationId}/policies`,
      headers,
    });
    const merchants = await app.inject({
      method: "GET",
      url: `/v1/admin/organizations/${organizationId}/merchants?limit=100`,
      headers,
    });
    const mandates = await app.inject({
      method: "GET",
      url: `/v1/admin/organizations/${organizationId}/mandates?limit=10`,
      headers,
    });

    expect([agents.statusCode, policies.statusCode, merchants.statusCode, mandates.statusCode]).toEqual([
      200,
      200,
      200,
      200,
    ]);
    expect(authorizer.requests.map((request) => request.permission)).toEqual([
      "agent.read",
      "policy.read",
      "merchant.read",
      "mandate.read",
    ]);
    expect(inventory.agentRequests).toEqual([{ organizationId, limit: 25, cursor }]);
    expect(inventory.policyRequests).toEqual([{ organizationId, limit: 50 }]);
    expect(inventory.merchantRequests).toEqual([{ organizationId, limit: 100 }]);
    expect(inventory.mandateRequests).toEqual([{ organizationId, limit: 10 }]);
    expect(agents.headers["cache-control"]).toBe("no-store");
    expect(mandates.headers["cache-control"]).toBe("no-store");
    await app.close();
  });

  it("rejects invalid pagination before RBAC or database reads", async () => {
    const authorizer = new CapturingAuthorizer();
    const inventory = new CapturingInventory();
    const app = Fastify();
    await registerAdminInventoryRoutes(app, { authenticator, authorizer, inventory });

    for (const query of ["?limit=0", "?limit=101", "?limit=abc", "?cursor=not-a-uuid", "?extra=x"]) {
      const response = await app.inject({
        method: "GET",
        url: `/v1/admin/organizations/${organizationId}/agents${query}`,
        headers: { authorization: "Bearer signed-token" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "invalid_request" });
      expect(response.headers["cache-control"]).toBe("no-store");
    }

    expect(authorizer.requests).toHaveLength(0);
    expect(inventory.agentRequests).toHaveLength(0);
    await app.close();
  });

  it("does not read inventory when the authenticated principal lacks the route permission", async () => {
    const authorizer = new CapturingAuthorizer(false);
    const inventory = new CapturingInventory();
    const app = Fastify();
    await registerAdminInventoryRoutes(app, { authenticator, authorizer, inventory });

    const response = await app.inject({
      method: "GET",
      url: `/v1/admin/organizations/${organizationId}/policies`,
      headers: { authorization: "Bearer signed-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "forbidden" });
    expect(inventory.policyRequests).toHaveLength(0);
    await app.close();
  });
});
