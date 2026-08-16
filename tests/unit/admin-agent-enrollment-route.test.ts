import { generateKeyPairSync, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { AdminAgentEnrollmentRouteDependencies } from "../../src/api/admin-agent-enrollment.routes.js";
import type {
  AdminAgentEnrollmentActor,
  AdminAgentEnrollmentRequest,
} from "../../src/modules/admin/admin-agent-enrollment.js";
import type { CheckoutProxyService } from "../../src/modules/proxy/checkout-proxy.service.js";

function proxyStub(): CheckoutProxyService {
  return {} as CheckoutProxyService;
}

describe("admin agent enrollment route", () => {
  it("returns 201 for authorized creation and forwards authenticated actor context", async () => {
    const organizationId = randomUUID();
    const principalId = randomUUID();
    const membershipId = randomUUID();
    const keyPair = generateKeyPairSync("ed25519");
    const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
    let seenActor: unknown;

    const dependencies: AdminAgentEnrollmentRouteDependencies = {
      authenticator: {
        authenticateAuthorizationHeader: () => ({
          authenticated: true as const,
          issuer: "https://id.example",
          subject: "alice",
        }),
      },
      authorizer: {
        authorize: async () => ({
          allowed: true as const,
          principalId,
          membershipId,
          organizationId,
          permission: "agent.create" as const,
          roles: ["AGENT_MANAGER" as const],
        }),
      },
      agentEnrollment: {
        enroll: async (
          actor: AdminAgentEnrollmentActor,
          request: AdminAgentEnrollmentRequest,
        ) => {
          seenActor = actor;
          return {
            outcome: "CREATED" as const,
            requestId: "request-1",
            agent: {
              id: randomUUID(),
              organizationId,
              externalAgentId: request.externalAgentId,
              ...(request.displayName ? { displayName: request.displayName } : {}),
              status: "ACTIVE" as const,
              keyId: request.keyId,
              publicKeyFingerprint: "fingerprint",
              createdAt: "2026-08-15T20:00:00.000Z",
              updatedAt: "2026-08-15T20:00:00.000Z",
            },
            audit: { sequence: 1n, chainDigest: "digest" },
          };
        },
      },
    };

    const app = await createApp({ proxy: proxyStub(), adminAgentEnrollment: dependencies });
    const response = await app.inject({
      method: "POST",
      url: `/v1/admin/organizations/${organizationId}/agents`,
      headers: { authorization: "Bearer token" },
      payload: {
        externalAgentId: "procurement-agent",
        displayName: "Procurement Agent",
        keyId: "agent-k1",
        publicKey,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(seenActor).toEqual({
      principalId,
      membershipId,
      organizationId,
      roles: ["AGENT_MANAGER"],
    });
    expect(response.json()).toMatchObject({ outcome: "CREATED", requestId: "request-1" });
    await app.close();
  });

  it("returns 403 before enrollment when agent.create is not granted", async () => {
    const organizationId = randomUUID();
    let called = false;
    const app = await createApp({
      proxy: proxyStub(),
      adminAgentEnrollment: {
        authenticator: {
          authenticateAuthorizationHeader: () => ({
            authenticated: true as const,
            issuer: "https://id.example",
            subject: "alice",
          }),
        },
        authorizer: {
          authorize: async () => ({
            allowed: false as const,
            permission: "agent.create" as const,
            reason: "PERMISSION_MISSING" as const,
          }),
        },
        agentEnrollment: {
          enroll: async () => {
            called = true;
            throw new Error("must not run");
          },
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/admin/organizations/${organizationId}/agents`,
      headers: { authorization: "Bearer token" },
      payload: {
        externalAgentId: "agent",
        keyId: "k1",
        publicKey: "not-reached",
      },
    });
    expect(response.statusCode).toBe(403);
    expect(called).toBe(false);
    await app.close();
  });
});
