import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerAdminAccessRoutes } from "../../src/api/admin-access.routes.js";
import type {
  AdminAuthorizationDecision,
  AdminAuthorizationRequest,
} from "../../src/modules/admin/admin-authorizer.js";
import type {
  AdminBearerAuthenticator,
  AdminJwtAuthenticationResult,
} from "../../src/modules/admin/admin-jwt-authenticator.js";

const organizationId = "11111111-1111-4111-8111-111111111111";

class StubAuthenticator implements AdminBearerAuthenticator {
  public constructor(private readonly result: AdminJwtAuthenticationResult) {}

  public authenticateAuthorizationHeader(): AdminJwtAuthenticationResult {
    return this.result;
  }
}

class CapturingAuthorizer {
  public requests: AdminAuthorizationRequest[] = [];

  public constructor(private readonly decision: AdminAuthorizationDecision) {}

  public async authorize(request: AdminAuthorizationRequest): Promise<AdminAuthorizationDecision> {
    this.requests.push(request);
    return this.decision;
  }
}

describe("admin access routes", () => {
  it("returns 401 without a bearer credential and never reaches RBAC", async () => {
    const authorizer = new CapturingAuthorizer({
      allowed: false,
      permission: "organization.read",
      reason: "IDENTITY_NOT_ENROLLED",
    });
    const app = Fastify();
    await registerAdminAccessRoutes(app, {
      authenticator: new StubAuthenticator({
        authenticated: false,
        reason: "AUTHORIZATION_HEADER_INVALID",
      }),
      authorizer,
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/admin/organizations/${organizationId}/access`,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "unauthorized" });
    expect(response.headers["www-authenticate"]).toBe('Bearer realm="mino-admin"');
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(authorizer.requests).toHaveLength(0);
    await app.close();
  });

  it("returns a generic 403 when cryptographic identity is valid but tenant RBAC denies access", async () => {
    const authorizer = new CapturingAuthorizer({
      allowed: false,
      permission: "organization.read",
      reason: "MEMBERSHIP_NOT_FOUND",
    });
    const app = Fastify();
    await registerAdminAccessRoutes(app, {
      authenticator: new StubAuthenticator({
        authenticated: true,
        issuer: "https://login.example/",
        subject: "alice",
      }),
      authorizer,
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/admin/organizations/${organizationId}/access`,
      headers: { authorization: "Bearer signed-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "forbidden" });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(authorizer.requests).toEqual([
      {
        issuer: "https://login.example/",
        subject: "alice",
        organizationId,
        permission: "organization.read",
      },
    ]);
    await app.close();
  });

  it("returns human-readable organization/admin metadata alongside stable IDs and effective permissions", async () => {
    const authorizer = new CapturingAuthorizer({
      allowed: true,
      principalId: "principal-1",
      principalDisplayName: "Alice Admin",
      principalEmail: "alice@example.test",
      membershipId: "membership-1",
      organizationId,
      organizationName: "Northstar Operations",
      permission: "organization.read",
      roles: ["FINANCE_MANAGER", "AUDITOR"],
    });
    const app = Fastify();
    await registerAdminAccessRoutes(app, {
      authenticator: new StubAuthenticator({
        authenticated: true,
        issuer: "https://login.example/",
        subject: "alice",
      }),
      authorizer,
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/admin/organizations/${organizationId}/access`,
      headers: { authorization: "Bearer signed-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json();
    expect(body).toMatchObject({
      principalId: "principal-1",
      membershipId: "membership-1",
      organizationId,
      organization: {
        id: organizationId,
        name: "Northstar Operations",
      },
      principal: {
        id: "principal-1",
        displayName: "Alice Admin",
        email: "alice@example.test",
      },
      roles: ["FINANCE_MANAGER", "AUDITOR"],
    });
    expect(body.permissions).toContain("policy.activate");
    expect(body.permissions).toContain("audit.verify");
    expect(body.permissions).not.toContain("approval.vote");
    await app.close();
  });

  it("keeps presentation metadata optional for enrolled records that do not have it", async () => {
    const authorizer = new CapturingAuthorizer({
      allowed: true,
      principalId: "principal-1",
      membershipId: "membership-1",
      organizationId,
      permission: "organization.read",
      roles: ["AUDITOR"],
    });
    const app = Fastify();
    await registerAdminAccessRoutes(app, {
      authenticator: new StubAuthenticator({
        authenticated: true,
        issuer: "https://login.example/",
        subject: "alice",
      }),
      authorizer,
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/admin/organizations/${organizationId}/access`,
      headers: { authorization: "Bearer signed-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      organization: { id: organizationId },
      principal: { id: "principal-1" },
    });
    expect(response.body).not.toContain("displayName");
    expect(response.body).not.toContain("email");
    await app.close();
  });

  it("rejects a malformed organization ID before identity or tenancy lookup", async () => {
    const authorizer = new CapturingAuthorizer({
      allowed: false,
      permission: "organization.read",
      reason: "PERMISSION_DENIED",
    });
    const app = Fastify();
    await registerAdminAccessRoutes(app, {
      authenticator: new StubAuthenticator({
        authenticated: true,
        issuer: "https://login.example/",
        subject: "alice",
      }),
      authorizer,
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/organizations/not-a-uuid/access",
      headers: { authorization: "Bearer signed-token" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(authorizer.requests).toHaveLength(0);
    await app.close();
  });
});
