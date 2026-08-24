import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerPersonalAuthorityRoutes } from "../../src/api/personal-authority.routes.js";
import type { PersonalOwnerBearerAuthenticator } from "../../src/modules/personal/personal-owner-authenticator.js";

const authenticator: PersonalOwnerBearerAuthenticator = {
  authenticateAuthorizationHeader(value) {
    return value === "Bearer owner-token"
      ? { authenticated: true, issuer: "https://personal.test", subject: "owner-1" }
      : { authenticated: false, reason: "AUTHORIZATION_HEADER_INVALID" };
  },
};

const agentId = "10000000-0000-4000-8000-000000000001";

describe("Personal authority routes", () => {
  it("requires owner auth to grant authority but lets the paired agent request its own mandate with key proof", async () => {
    const calls: string[] = [];
    const authority = {
      async getAuthority() {
        return undefined;
      },
      async setAuthority() {
        calls.push("set");
        return {
          outcome: "CREATED" as const,
          authority: {
            agentId,
            policyId: "20000000-0000-4000-8000-000000000001",
            version: 1,
            active: true,
            profile: {
              currency: "USD",
              perTransactionLimit: "100.00",
              dailyLimit: "300.00",
              allowedMerchantDomains: ["shop.example"],
            },
            updatedAt: "2026-08-24T17:00:00.000Z",
          },
        };
      },
      async revokeAuthority() {
        return { outcome: "REVOKED" as const };
      },
      async issueMandate() {
        calls.push("issue");
        return {
          outcome: "ISSUED" as const,
          mandateId: "30000000-0000-4000-8000-000000000001",
          mandateToken: "header.claims.signature",
          expiresAt: "2026-09-23T17:00:00.000Z",
          policyVersion: 1,
        };
      },
    };
    const app = Fastify();
    await registerPersonalAuthorityRoutes(app, { authenticator, authority });

    const unauthorized = await app.inject({
      method: "PUT",
      url: `/v1/personal/agents/${agentId}/authority`,
      payload: {
        currency: "USD",
        perTransactionLimit: "100.00",
        dailyLimit: "300.00",
        allowedMerchantDomains: ["shop.example"],
      },
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(calls).not.toContain("set");

    const granted = await app.inject({
      method: "PUT",
      url: `/v1/personal/agents/${agentId}/authority`,
      headers: { authorization: "Bearer owner-token" },
      payload: {
        currency: "USD",
        perTransactionLimit: "100.00",
        dailyLimit: "300.00",
        allowedMerchantDomains: ["shop.example"],
      },
    });
    expect(granted.statusCode).toBe(201);
    expect(calls).toContain("set");

    const mandate = await app.inject({
      method: "POST",
      url: `/v1/personal/agents/${agentId}/mandate`,
      payload: {
        keyId: "openclaw-k1",
        timestamp: 1_787_590_000,
        nonce: "abcdefghijklmnop12345678",
        signature: "a".repeat(86),
      },
    });
    expect(mandate.statusCode).toBe(201);
    expect(mandate.headers["cache-control"]).toBe("no-store");
    expect(mandate.json().mandateToken).toBe("header.claims.signature");
    expect(calls).toContain("issue");

    await app.close();
  });
});
