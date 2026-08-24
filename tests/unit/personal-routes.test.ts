import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerPersonalRoutes } from "../../src/api/personal.routes.js";
import type { PersonalOwnerBearerAuthenticator } from "../../src/modules/personal/personal-owner-authenticator.js";

const authenticated: PersonalOwnerBearerAuthenticator = {
  authenticateAuthorizationHeader(value) {
    return value === "Bearer owner-token"
      ? { authenticated: true, issuer: "https://personal.test", subject: "owner-1" }
      : { authenticated: false, reason: "AUTHORIZATION_HEADER_INVALID" };
  },
};

const owner = {
  id: "10000000-0000-4000-8000-000000000001",
  organizationId: "10000000-0000-4000-8000-000000000002",
  userId: "10000000-0000-4000-8000-000000000003",
  email: "owner@example.test",
  status: "ACTIVE" as const,
};

function personalDouble() {
  return {
    async bootstrap() {
      return { outcome: "CREATED" as const, owner };
    },
    async getOwner() {
      return owner;
    },
    async createPairingRequest() {
      return {
        id: "20000000-0000-4000-8000-000000000001",
        status: "PENDING" as const,
        externalAgentId: "openclaw-home",
        keyId: "k1",
        publicKeyFingerprint: "fingerprint",
        createdAt: "2026-08-24T15:30:00.000Z",
        expiresAt: "2026-08-24T15:40:00.000Z",
        claimSecret: "a".repeat(43),
      };
    },
    async getPairingRequest() {
      return {
        id: "20000000-0000-4000-8000-000000000001",
        status: "PENDING" as const,
        externalAgentId: "openclaw-home",
        keyId: "k1",
        publicKeyFingerprint: "fingerprint",
        createdAt: "2026-08-24T15:30:00.000Z",
        expiresAt: "2026-08-24T15:40:00.000Z",
      };
    },
    async claimPairingRequest() {
      return {
        outcome: "CLAIMED" as const,
        owner,
        pairing: {
          id: "20000000-0000-4000-8000-000000000001",
          status: "CLAIMED" as const,
          externalAgentId: "openclaw-home",
          keyId: "k1",
          publicKeyFingerprint: "fingerprint",
          createdAt: "2026-08-24T15:30:00.000Z",
          expiresAt: "2026-08-24T15:40:00.000Z",
          agentId: "30000000-0000-4000-8000-000000000001",
        },
      };
    },
  };
}

describe("Personal routes", () => {
  it("keeps owner operations authenticated while allowing an agent to create and poll a pairing request", async () => {
    const app = Fastify();
    await registerPersonalRoutes(app, { authenticator: authenticated, personal: personalDouble() });

    const unauthorized = await app.inject({
      method: "POST",
      url: "/v1/personal/bootstrap",
      payload: { beneficiaryEmail: "owner@example.test" },
    });
    expect(unauthorized.statusCode).toBe(401);

    const bootstrapped = await app.inject({
      method: "POST",
      url: "/v1/personal/bootstrap",
      headers: { authorization: "Bearer owner-token" },
      payload: { beneficiaryEmail: "owner@example.test" },
    });
    expect(bootstrapped.statusCode).toBe(201);
    expect(bootstrapped.headers["cache-control"]).toBe("no-store");

    const pairing = await app.inject({
      method: "POST",
      url: "/v1/personal/pairing-requests",
      payload: {
        externalAgentId: "openclaw-home",
        keyId: "k1",
        publicKey: "public-key-placeholder",
      },
    });
    expect(pairing.statusCode).toBe(201);
    expect(pairing.json().pairing.claimSecret).toBe("a".repeat(43));

    const polled = await app.inject({
      method: "GET",
      url: "/v1/personal/pairing-requests/20000000-0000-4000-8000-000000000001",
    });
    expect(polled.statusCode).toBe(200);
    expect(polled.json().pairing).not.toHaveProperty("claimSecret");

    const claimed = await app.inject({
      method: "POST",
      url: "/v1/personal/pairing-requests/20000000-0000-4000-8000-000000000001/claim",
      headers: { authorization: "Bearer owner-token" },
      payload: { claimSecret: "a".repeat(43) },
    });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json().pairing.agentId).toBe("30000000-0000-4000-8000-000000000001");

    await app.close();
  });
});
