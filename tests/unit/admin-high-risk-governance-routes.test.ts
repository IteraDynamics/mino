import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AdminHighRiskGovernanceRouteDependencies } from "../../src/api/admin-high-risk-governance.routes.js";
import type { AdminMandateManagementRouteDependencies } from "../../src/api/admin-mandate-management.routes.js";
import type { AdminPolicyManagementRouteDependencies } from "../../src/api/admin-policy-management.routes.js";
import { createApp } from "../../src/app.js";
import type {
  AdminGovernanceRequestProjection,
  AdminGovernanceProposalResult,
} from "../../src/modules/admin/admin-high-risk-governance.js";
import type { AdminPermission } from "../../src/modules/admin/admin-authorizer.js";
import type { CheckoutProxyService } from "../../src/modules/proxy/checkout-proxy.service.js";

function proxyStub(): CheckoutProxyService {
  return {} as CheckoutProxyService;
}

function authorization(
  organizationId: string,
  allowed: (permission: AdminPermission) => boolean = () => true,
  seen?: AdminPermission[],
) {
  return {
    authenticator: {
      authenticateAuthorizationHeader: () => ({
        authenticated: true as const,
        issuer: "https://id.example",
        subject: "finance-admin",
      }),
    },
    authorizer: {
      authorize: async (request: { readonly permission: AdminPermission }) => {
        seen?.push(request.permission);
        if (!allowed(request.permission)) {
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
          roles: ["FINANCE_MANAGER" as const],
        };
      },
    },
  };
}

function governanceRequest(
  organizationId: string,
  overrides: Partial<AdminGovernanceRequestProjection> = {},
): AdminGovernanceRequestProjection {
  return {
    id: randomUUID(),
    organizationId,
    action: "POLICY_ACTIVATE",
    requiredPermission: "policy.activate",
    proposerPrincipalId: "33333333-3333-4333-8333-333333333333",
    proposerMembershipId: "44444444-4444-4444-8444-444444444444",
    proposalDigest: "proposal-digest",
    preconditionDigest: "precondition-digest",
    targetType: "policy",
    targetId: randomUUID(),
    proposal: { policyId: randomUUID(), name: "Procurement", version: 1 },
    status: "PENDING",
    requiredApprovals: 1,
    voteCount: 0,
    approveCount: 0,
    rejectCount: 0,
    createdAt: "2026-08-20T12:00:00.000Z",
    expiresAt: "2026-08-20T12:30:00.000Z",
    ...overrides,
  };
}

function proposalResult(organizationId: string): AdminGovernanceProposalResult {
  return {
    outcome: "PENDING_GOVERNANCE",
    requestId: randomUUID(),
    governanceRequest: governanceRequest(organizationId),
    audit: {
      chainSequence: "1",
      eventDigest: "event",
      chainDigest: "chain",
      signingKeyId: "audit-k1",
    },
  };
}

describe("high-risk administrative governance routes", () => {
  it("turns production-style mandate issuance into a durable proposal instead of direct authority", async () => {
    const organizationId = randomUUID();
    let directIssueCalled = false;
    let proposalCalled = false;
    const dependencies: AdminMandateManagementRouteDependencies = {
      ...authorization(organizationId),
      mandateManagement: {
        getMandate: async () => undefined,
        issue: async () => {
          directIssueCalled = true;
          throw new Error("direct issue must not run");
        },
        revoke: async () => ({ outcome: "NOT_FOUND" as const, requestId: randomUUID() }),
      },
      highRiskGovernance: {
        proposeMandateIssue: async () => {
          proposalCalled = true;
          return proposalResult(organizationId);
        },
      },
    };
    const app = await createApp({ proxy: proxyStub(), adminMandateManagement: dependencies });

    const response = await app.inject({
      method: "POST",
      url: `/v1/admin/organizations/${organizationId}/mandates`,
      headers: {
        authorization: "Bearer token",
        "idempotency-key": "proposal-key-1",
      },
      payload: {
        userId: randomUUID(),
        agentId: randomUUID(),
        policyId: randomUUID(),
        expiresAt: "2026-08-21T12:00:00.000Z",
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ outcome: "PENDING_GOVERNANCE", changed: false });
    expect(proposalCalled).toBe(true);
    expect(directIssueCalled).toBe(false);
    await app.close();
  });

  it("turns policy activation into a proposal and requires an idempotency key when governance is active", async () => {
    const organizationId = randomUUID();
    const policyId = randomUUID();
    let directActivateCalled = false;
    let proposalCalled = false;
    const dependencies: AdminPolicyManagementRouteDependencies = {
      ...authorization(organizationId),
      policyManagement: {
        getPolicy: async () => undefined,
        createPolicy: async () => ({ outcome: "CONFLICT" as const, requestId: randomUUID() }),
        createVersion: async () => ({ outcome: "CONFLICT" as const, requestId: randomUUID() }),
        activate: async () => {
          directActivateCalled = true;
          throw new Error("direct activation must not run");
        },
        deactivate: async () => ({ outcome: "NOT_FOUND" as const, requestId: randomUUID() }),
      },
      highRiskGovernance: {
        proposePolicyActivation: async () => {
          proposalCalled = true;
          return proposalResult(organizationId);
        },
      },
    };
    const app = await createApp({ proxy: proxyStub(), adminPolicyManagement: dependencies });

    const missingKey = await app.inject({
      method: "POST",
      url: `/v1/admin/organizations/${organizationId}/policies/${policyId}/activate`,
      headers: { authorization: "Bearer token" },
    });
    expect(missingKey.statusCode).toBe(400);
    expect(proposalCalled).toBe(false);

    const proposed = await app.inject({
      method: "POST",
      url: `/v1/admin/organizations/${organizationId}/policies/${policyId}/activate`,
      headers: {
        authorization: "Bearer token",
        "idempotency-key": "policy-activate-1",
      },
    });
    expect(proposed.statusCode).toBe(202);
    expect(proposed.json()).toMatchObject({ outcome: "PENDING_GOVERNANCE" });
    expect(proposalCalled).toBe(true);
    expect(directActivateCalled).toBe(false);
    await app.close();
  });

  it("requires governance visibility and the request-bound underlying permission before voting or applying", async () => {
    const organizationId = randomUUID();
    const request = governanceRequest(organizationId);
    const seen: AdminPermission[] = [];
    let votes = 0;
    let applies = 0;
    const dependencies: AdminHighRiskGovernanceRouteDependencies = {
      ...authorization(organizationId, () => true, seen),
      governance: {
        list: async () => ({ items: [request] }),
        get: async () => request,
        requiredPermission: async () => "policy.activate",
        vote: async () => {
          votes += 1;
          return {
            outcome: "UPDATED" as const,
            requestId: randomUUID(),
            governanceRequest: governanceRequest(organizationId, {
              id: request.id,
              status: "APPROVED",
              voteCount: 1,
              approveCount: 1,
            }),
            audit: {
              chainSequence: "2",
              eventDigest: "event-2",
              chainDigest: "chain-2",
              signingKeyId: "audit-k1",
            },
          };
        },
        apply: async () => {
          applies += 1;
          return {
            outcome: "REPLAYED" as const,
            requestId: randomUUID(),
            governanceRequest: governanceRequest(organizationId, {
              id: request.id,
              status: "APPLIED",
            }),
          };
        },
      },
    };
    const app = await createApp({ proxy: proxyStub(), adminHighRiskGovernance: dependencies });
    const headers = { authorization: "Bearer token" };

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/admin/organizations/${organizationId}/governance/${request.id}/votes`,
          headers,
          payload: { decision: "APPROVE" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/admin/organizations/${organizationId}/governance/${request.id}/apply`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(seen).toEqual([
      "governance.read",
      "policy.activate",
      "governance.read",
      "policy.activate",
    ]);
    expect(votes).toBe(1);
    expect(applies).toBe(1);
    await app.close();
  });

  it("returns 403 before the governance service when the underlying mutation permission is missing", async () => {
    const organizationId = randomUUID();
    const request = governanceRequest(organizationId);
    let voted = false;
    const dependencies: AdminHighRiskGovernanceRouteDependencies = {
      ...authorization(
        organizationId,
        (permission) => permission === "governance.read",
      ),
      governance: {
        list: async () => ({ items: [request] }),
        get: async () => request,
        requiredPermission: async () => "policy.activate",
        vote: async () => {
          voted = true;
          throw new Error("vote must not run");
        },
        apply: async () => ({
          outcome: "NOT_FOUND" as const,
          requestId: randomUUID(),
        }),
      },
    };
    const app = await createApp({ proxy: proxyStub(), adminHighRiskGovernance: dependencies });
    const response = await app.inject({
      method: "POST",
      url: `/v1/admin/organizations/${organizationId}/governance/${request.id}/votes`,
      headers: { authorization: "Bearer token" },
      payload: { decision: "APPROVE" },
    });
    expect(response.statusCode).toBe(403);
    expect(voted).toBe(false);
    await app.close();
  });
});
