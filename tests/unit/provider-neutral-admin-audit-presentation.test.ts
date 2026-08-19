import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AdminAuditOperationsRouteDependencies } from "../../src/api/admin-audit-operations.routes.js";
import { createApp } from "../../src/app.js";
import type { CheckoutProxyService } from "../../src/modules/proxy/checkout-proxy.service.js";

function proxyStub(): CheckoutProxyService {
  return {} as CheckoutProxyService;
}

describe("provider-neutral transaction audit presentation", () => {
  it("adds provider and counterparty semantics without removing legacy audit fields", async () => {
    const organizationId = randomUUID();
    const dependencies: AdminAuditOperationsRouteDependencies = {
      authenticator: {
        authenticateAuthorizationHeader: () => ({
          authenticated: true as const,
          issuer: "https://id.example",
          subject: "auditor",
        }),
      },
      authorizer: {
        authorize: async (request) => ({
          allowed: true as const,
          principalId: "11111111-1111-4111-8111-111111111111",
          membershipId: "22222222-2222-4222-8222-222222222222",
          organizationId,
          permission: request.permission,
          roles: ["AUDITOR" as const],
        }),
      },
      operations: {
        listTransactionAudit: async () => ({
          items: [
            {
              chainSequence: "1",
              timestamp: "2026-08-19T20:00:00.000Z",
              requestId: randomUUID(),
              decisionId: randomUUID(),
              userId: randomUUID(),
              agentId: randomUUID(),
              protocol: "ACP",
              operation: "COMPLETE_CHECKOUT",
              merchantDomain: "supplier.example",
              merchantVendorId: "vendor-42",
              verdict: "ALLOW" as const,
              reasonCodes: ["POLICY_ALLOW"],
              evaluationLatencyMicros: 100,
              eventDigest: "event-1",
              chainDigest: "chain-1",
              signingKeyId: "audit-k1",
            },
          ],
        }),
        listAdministrativeAudit: async () => ({ items: [] }),
        operationalSnapshot: async () => ({
          capturedAt: "2026-08-19T20:00:00.000Z",
          payments: {
            forwarding: 0,
            unknown: 0,
            succeeded: 0,
            failedDefinitive: 0,
            unresolved: 0,
            claimable: 0,
            stale: 0,
            highAttempt: 0,
            leased: 0,
            oldestUnresolvedAgeSeconds: 0,
          },
          approvals: {
            pending: 0,
            approved: 0,
            rejected: 0,
            expired: 0,
            expiredPending: 0,
            notificationPending: 0,
            notificationLeased: 0,
            notificationDelivered: 0,
            notificationDeadLetter: 0,
            notificationClaimable: 0,
            oldestUndeliveredAgeSeconds: 0,
          },
          reservations: {
            reserved: 0,
            committed: 0,
            released: 0,
            expired: 0,
            overdueReserved: 0,
          },
          audit: {
            transaction: { headSequence: "1" },
            administrative: { headSequence: "0" },
          },
        }),
      },
      transactionVerifier: {
        verifyOrganization: async () => ({
          valid: true,
          checkedEvents: 1,
          headSequence: "1",
          headDigest: "chain-1",
        }),
      },
      administrativeVerifier: {
        verifyOrganization: async () => ({
          valid: true,
          checkedEvents: 0,
          headSequence: "0",
        }),
      },
      retainedAdministrativeVerifier: {
        verifyOrganization: async () => ({
          valid: true,
          checkpointSequence: "0",
          currentHeadSequence: "0",
        }),
      },
    };

    const app = await createApp({ proxy: proxyStub(), adminAuditOperations: dependencies });
    const response = await app.inject({
      method: "GET",
      url: `/v1/admin/organizations/${organizationId}/audit/transactions`,
      headers: { authorization: "Bearer token" },
    });

    expect(response.statusCode).toBe(200);
    const item = response.json<{ items: Array<Record<string, unknown>> }>().items[0] as {
      protocol: string;
      merchantDomain: string;
      merchantVendorId: string;
      economic: {
        provider: { protocol: string };
        counterparty: { kind: string; identifiers: Array<{ scheme: string; value: string }> };
      };
    };

    expect(item.protocol).toBe("ACP");
    expect(item.merchantDomain).toBe("supplier.example");
    expect(item.merchantVendorId).toBe("vendor-42");
    expect(item.economic).toEqual({
      provider: { protocol: "ACP" },
      counterparty: {
        kind: "MERCHANT",
        identifiers: [
          { scheme: "DOMAIN", value: "supplier.example" },
          { scheme: "VENDOR_ID", value: "vendor-42" },
        ],
      },
    });

    await app.close();
  });
});
