import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AdminAuditOperationsRouteDependencies } from "../../src/api/admin-audit-operations.routes.js";
import { createApp } from "../../src/app.js";
import type { CheckoutProxyService } from "../../src/modules/proxy/checkout-proxy.service.js";

function proxyStub(): CheckoutProxyService {
  return {} as CheckoutProxyService;
}

function dependencies(
  organizationId: string,
  hooks: {
    readonly authorize?: (permission: string) => boolean;
    readonly onTransactionFilter?: (filter: unknown) => void;
    readonly onAdminFilter?: (filter: unknown) => void;
    readonly onTransactionVerify?: (checkpoint: unknown) => void;
    readonly onAdminRetainedVerify?: (checkpoint: unknown) => void;
  } = {},
): AdminAuditOperationsRouteDependencies {
  return {
    authenticator: {
      authenticateAuthorizationHeader: () => ({
        authenticated: true as const,
        issuer: "https://id.example",
        subject: "auditor",
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
          roles: ["AUDITOR" as const],
        };
      },
    },
    operations: {
      listTransactionAudit: async (_organizationId, filter) => {
        hooks.onTransactionFilter?.(filter);
        return {
          items: [
            {
              chainSequence: "7",
              timestamp: "2026-08-16T18:00:00.000Z",
              requestId: randomUUID(),
              decisionId: randomUUID(),
              userId: randomUUID(),
              agentId: randomUUID(),
              protocol: "ACP",
              operation: "complete_checkout",
              merchantDomain: "shop.example.com",
              verdict: "ALLOW" as const,
              reasonCodes: [],
              evaluationLatencyMicros: 120,
              eventDigest: "event-7",
              chainDigest: "chain-7",
              signingKeyId: "audit-k1",
            },
          ],
        };
      },
      listAdministrativeAudit: async (_organizationId, filter) => {
        hooks.onAdminFilter?.(filter);
        return {
          items: [
            {
              chainSequence: "4",
              timestamp: "2026-08-16T18:05:00.000Z",
              requestId: randomUUID(),
              principalId: randomUUID(),
              membershipId: randomUUID(),
              permission: "mandate.revoke",
              action: "mandate.revoke",
              resourceType: "mandate",
              roles: ["SECURITY_ADMIN"],
              eventDigest: "admin-event-4",
              chainDigest: "admin-chain-4",
              signingKeyId: "audit-k1",
            },
          ],
        };
      },
      operationalSnapshot: async () => ({
        capturedAt: "2026-08-16T18:10:00.000Z",
        payments: {
          forwarding: 1,
          unknown: 2,
          succeeded: 3,
          failedDefinitive: 4,
          unresolved: 3,
          claimable: 2,
          stale: 1,
          highAttempt: 0,
          leased: 1,
          oldestUnresolvedAgeSeconds: 600,
        },
        approvals: {
          pending: 2,
          approved: 3,
          rejected: 1,
          expired: 1,
          expiredPending: 1,
          notificationPending: 1,
          notificationLeased: 1,
          notificationDelivered: 2,
          notificationDeadLetter: 1,
          notificationClaimable: 1,
          oldestUndeliveredAgeSeconds: 300,
        },
        reservations: {
          reserved: 1,
          committed: 3,
          released: 2,
          expired: 1,
          overdueReserved: 1,
        },
        audit: {
          transaction: { headSequence: "7", headDigest: "chain-7" },
          administrative: { headSequence: "4", headDigest: "admin-chain-4" },
        },
      }),
    },
    transactionVerifier: {
      verifyOrganization: async (_organizationId, checkpoint) => {
        hooks.onTransactionVerify?.(checkpoint);
        return {
          valid: true,
          checkedEvents: 7,
          headSequence: "7",
          headDigest: "chain-7",
        };
      },
    },
    administrativeVerifier: {
      verifyOrganization: async () => ({
        valid: true,
        checkedEvents: 4,
        headSequence: "4",
        headDigest: "admin-chain-4",
      }),
    },
    retainedAdministrativeVerifier: {
      verifyOrganization: async (_organizationId, checkpoint) => {
        hooks.onAdminRetainedVerify?.(checkpoint);
        return {
          valid: true,
          checkpointSequence: checkpoint.chainSequence,
          currentHeadSequence: "4",
          currentHeadDigest: "admin-chain-4",
        };
      },
    },
  };
}

const checkpoint = (organizationId: string) => ({
  version: 1,
  organizationId,
  chainSequence: "2",
  chainDigest: "checkpoint-chain-2",
  issuedAt: "2026-08-16T18:00:00.000Z",
  signingKeyId: "audit-k1",
  signature: "signed-checkpoint",
});

describe("admin audit and operations routes", () => {
  it("maps inventories and operational visibility to audit.read and forwards bounded filters", async () => {
    const organizationId = randomUUID();
    const permissions: string[] = [];
    let transactionFilter: unknown;
    let adminFilter: unknown;
    const app = await createApp({
      proxy: proxyStub(),
      adminAuditOperations: dependencies(organizationId, {
        authorize: (permission) => {
          permissions.push(permission);
          return true;
        },
        onTransactionFilter: (filter) => {
          transactionFilter = filter;
        },
        onAdminFilter: (filter) => {
          adminFilter = filter;
        },
      }),
    });
    const headers = { authorization: "Bearer token" };

    const transactions = await app.inject({
      method: "GET",
      url: `/v1/admin/organizations/${organizationId}/audit/transactions?verdict=ALLOW&limit=25&merchantDomain=SHOP.EXAMPLE.COM`,
      headers,
    });
    expect(transactions.statusCode).toBe(200);
    expect(transactions.headers["cache-control"]).toBe("no-store");
    expect(transactionFilter).toMatchObject({
      verdict: "ALLOW",
      limit: 25,
      merchantDomain: "SHOP.EXAMPLE.COM",
    });

    const administrative = await app.inject({
      method: "GET",
      url: `/v1/admin/organizations/${organizationId}/audit/administrative?permission=mandate.revoke&resourceType=mandate`,
      headers,
    });
    expect(administrative.statusCode).toBe(200);
    expect(adminFilter).toMatchObject({ permission: "mandate.revoke", resourceType: "mandate" });

    const operations = await app.inject({
      method: "GET",
      url: `/v1/admin/organizations/${organizationId}/operations`,
      headers,
    });
    expect(operations.statusCode).toBe(200);
    expect(operations.json()).toMatchObject({
      operations: {
        payments: { unresolved: 3, claimable: 2 },
        approvals: { notificationClaimable: 1 },
        audit: { transaction: { headSequence: "7" } },
      },
    });
    expect(permissions).toEqual(["audit.read", "audit.read", "audit.read"]);
    await app.close();
  });

  it("uses audit.verify for database and supplied retained-checkpoint verification", async () => {
    const organizationId = randomUUID();
    const permissions: string[] = [];
    const transactionCheckpoints: unknown[] = [];
    let adminCheckpoint: unknown;
    const app = await createApp({
      proxy: proxyStub(),
      adminAuditOperations: dependencies(organizationId, {
        authorize: (permission) => {
          permissions.push(permission);
          return true;
        },
        onTransactionVerify: (value) => transactionCheckpoints.push(value),
        onAdminRetainedVerify: (value) => {
          adminCheckpoint = value;
        },
      }),
    });
    const headers = { authorization: "Bearer token" };

    const transaction = await app.inject({
      method: "POST",
      url: `/v1/admin/organizations/${organizationId}/audit/transactions/verify`,
      headers,
      payload: { retainedCheckpoint: checkpoint(organizationId) },
    });
    expect(transaction.statusCode).toBe(200);
    expect(transaction.json()).toMatchObject({
      chain: "transaction",
      databaseVerification: { valid: true, headSequence: "7" },
      retainedCheckpointVerification: { valid: true, headSequence: "7" },
    });
    expect(transactionCheckpoints).toHaveLength(2);
    expect(transactionCheckpoints[0]).toBeUndefined();
    expect(transactionCheckpoints[1]).toMatchObject({ chainSequence: "2" });

    const administrative = await app.inject({
      method: "POST",
      url: `/v1/admin/organizations/${organizationId}/audit/administrative/verify`,
      headers,
      payload: { retainedCheckpoint: checkpoint(organizationId) },
    });
    expect(administrative.statusCode).toBe(200);
    expect(administrative.json()).toMatchObject({
      chain: "administrative",
      databaseVerification: { valid: true, headSequence: "4" },
      retainedCheckpointVerification: { valid: true, checkpointSequence: "2" },
    });
    expect(adminCheckpoint).toMatchObject({ chainSequence: "2" });
    expect(permissions).toEqual(["audit.verify", "audit.verify"]);
    await app.close();
  });

  it("rejects malformed filters and checkpoint payloads before authorization", async () => {
    const organizationId = randomUUID();
    let authorized = false;
    const app = await createApp({
      proxy: proxyStub(),
      adminAuditOperations: dependencies(organizationId, {
        authorize: () => {
          authorized = true;
          return true;
        },
      }),
    });
    const headers = { authorization: "Bearer token" };

    const invalidFilter = await app.inject({
      method: "GET",
      url: `/v1/admin/organizations/${organizationId}/audit/transactions?verdict=OVERRIDE&secret=x`,
      headers,
    });
    expect(invalidFilter.statusCode).toBe(400);
    expect(invalidFilter.headers["cache-control"]).toBe("no-store");

    const invalidCheckpoint = await app.inject({
      method: "POST",
      url: `/v1/admin/organizations/${organizationId}/audit/transactions/verify`,
      headers,
      payload: {
        retainedCheckpoint: {
          ...checkpoint(organizationId),
          version: 2,
          privateKey: "do-not-accept",
        },
      },
    });
    expect(invalidCheckpoint.statusCode).toBe(400);
    expect(authorized).toBe(false);
    await app.close();
  });

  it("keeps audit.verify distinct from audit.read", async () => {
    const organizationId = randomUUID();
    let verified = false;
    const deps = dependencies(organizationId, {
      authorize: (permission) => permission !== "audit.verify",
      onTransactionVerify: () => {
        verified = true;
      },
    });
    const app = await createApp({ proxy: proxyStub(), adminAuditOperations: deps });
    const headers = { authorization: "Bearer token" };

    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v1/admin/organizations/${organizationId}/operations`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
    const verify = await app.inject({
      method: "POST",
      url: `/v1/admin/organizations/${organizationId}/audit/transactions/verify`,
      headers,
      payload: {},
    });
    expect(verify.statusCode).toBe(403);
    expect(verified).toBe(false);
    await app.close();
  });
});
