import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerAdminBeneficiaryAdministrationRoutes } from "../../src/api/admin-beneficiary-administration.routes.js";
import type {
  AdminAuthorizationDecision,
  AdminAuthorizationRequest,
} from "../../src/modules/admin/admin-authorizer.js";
import type { AdminJwtAuthenticationResult } from "../../src/modules/admin/admin-jwt-authenticator.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const beneficiaryId = "22222222-2222-4222-8222-222222222222";

class StubAuthenticator {
  public authenticateAuthorizationHeader(): AdminJwtAuthenticationResult {
    return { authenticated: true, issuer: "https://login.example/", subject: "alice" };
  }
}

class CapturingAuthorizer {
  public requests: AdminAuthorizationRequest[] = [];

  public async authorize(request: AdminAuthorizationRequest): Promise<AdminAuthorizationDecision> {
    this.requests.push(request);
    return {
      allowed: true,
      principalId: "principal-1",
      membershipId: "membership-1",
      organizationId: request.organizationId,
      permission: request.permission,
      roles: ["FINANCE_MANAGER"],
    };
  }
}

function beneficiary(status = "ACTIVE") {
  return {
    id: beneficiaryId,
    organizationId,
    email: "buyer@example.test",
    status,
    createdAt: "2026-08-20T17:00:00.000Z",
    updatedAt: "2026-08-20T17:00:00.000Z",
  };
}

describe("admin beneficiary administration routes", () => {
  it("uses beneficiary.read for organization-scoped inventory and detail", async () => {
    const authorizer = new CapturingAuthorizer();
    const app = Fastify();
    await registerAdminBeneficiaryAdministrationRoutes(app, {
      authenticator: new StubAuthenticator(),
      authorizer,
      beneficiaries: {
        async listBeneficiaries() {
          return { items: [beneficiary()] };
        },
        async getBeneficiary() {
          return beneficiary();
        },
        async createBeneficiary() {
          throw new Error("unexpected create");
        },
        async suspendBeneficiary() {
          throw new Error("unexpected suspend");
        },
      },
    });

    const headers = { authorization: "Bearer signed-token" };
    const list = await app.inject({
      method: "GET",
      url: `/v1/admin/organizations/${organizationId}/beneficiaries?limit=20`,
      headers,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ items: [{ email: "buyer@example.test" }] });

    const detail = await app.inject({
      method: "GET",
      url: `/v1/admin/organizations/${organizationId}/beneficiaries/${beneficiaryId}`,
      headers,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ beneficiary: { id: beneficiaryId } });
    expect(authorizer.requests.map((request) => request.permission)).toEqual([
      "beneficiary.read",
      "beneficiary.read",
    ]);
    await app.close();
  });

  it("creates through beneficiary.create and returns signed-audit mutation shape", async () => {
    const authorizer = new CapturingAuthorizer();
    const app = Fastify();
    await registerAdminBeneficiaryAdministrationRoutes(app, {
      authenticator: new StubAuthenticator(),
      authorizer,
      beneficiaries: {
        async listBeneficiaries() {
          return { items: [] };
        },
        async getBeneficiary() {
          return undefined;
        },
        async createBeneficiary(actor, request) {
          expect(actor).toMatchObject({ organizationId, principalId: "principal-1" });
          expect(request).toEqual({ email: "buyer@example.test" });
          return {
            outcome: "CREATED",
            requestId: "request-1",
            beneficiary: beneficiary(),
            audit: {
              chainSequence: "1",
              eventDigest: "event",
              chainDigest: "chain",
              signingKeyId: "audit-k1",
            },
          };
        },
        async suspendBeneficiary() {
          throw new Error("unexpected suspend");
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/admin/organizations/${organizationId}/beneficiaries`,
      headers: { authorization: "Bearer signed-token" },
      payload: { email: "buyer@example.test" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      outcome: "CREATED",
      changed: true,
      beneficiary: { email: "buyer@example.test" },
      auditReceipt: { chainSequence: "1" },
    });
    expect(authorizer.requests.at(-1)?.permission).toBe("beneficiary.create");
    await app.close();
  });

  it("suspends through beneficiary.suspend and exposes no reactivation route", async () => {
    const authorizer = new CapturingAuthorizer();
    const app = Fastify();
    await registerAdminBeneficiaryAdministrationRoutes(app, {
      authenticator: new StubAuthenticator(),
      authorizer,
      beneficiaries: {
        async listBeneficiaries() {
          return { items: [] };
        },
        async getBeneficiary() {
          return undefined;
        },
        async createBeneficiary() {
          throw new Error("unexpected create");
        },
        async suspendBeneficiary() {
          return {
            outcome: "UPDATED",
            requestId: "request-2",
            beneficiary: beneficiary("SUSPENDED"),
            audit: {
              chainSequence: "2",
              eventDigest: "event-2",
              chainDigest: "chain-2",
              signingKeyId: "audit-k1",
            },
          };
        },
      },
    });

    const headers = { authorization: "Bearer signed-token" };
    const response = await app.inject({
      method: "POST",
      url: `/v1/admin/organizations/${organizationId}/beneficiaries/${beneficiaryId}/suspend`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      outcome: "UPDATED",
      changed: true,
      beneficiary: { status: "SUSPENDED" },
    });
    expect(authorizer.requests.at(-1)?.permission).toBe("beneficiary.suspend");

    const absent = await app.inject({
      method: "POST",
      url: `/v1/admin/organizations/${organizationId}/beneficiaries/${beneficiaryId}/reactivate`,
      headers,
    });
    expect(absent.statusCode).toBe(404);
    await app.close();
  });

  it("rejects malformed beneficiary input before RBAC or mutation", async () => {
    const authorizer = new CapturingAuthorizer();
    const app = Fastify();
    await registerAdminBeneficiaryAdministrationRoutes(app, {
      authenticator: new StubAuthenticator(),
      authorizer,
      beneficiaries: {
        async listBeneficiaries() {
          return { items: [] };
        },
        async getBeneficiary() {
          return undefined;
        },
        async createBeneficiary() {
          throw new Error("unexpected create");
        },
        async suspendBeneficiary() {
          throw new Error("unexpected suspend");
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/admin/organizations/${organizationId}/beneficiaries`,
      headers: { authorization: "Bearer signed-token" },
      payload: { email: "not-an-email" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
    expect(authorizer.requests).toHaveLength(0);
    await app.close();
  });
});
