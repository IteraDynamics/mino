import { describe, expect, it } from "vitest";
import {
  ADMIN_PERMISSIONS,
  AdminAuthorizer,
  hasPermission,
  permissionsForRoles,
  type AdminAuthorizationContextRepository,
  type AdminIdentityAuthorizationContext,
} from "../../src/modules/admin/admin-authorizer.js";

class StaticAdminContextRepository implements AdminAuthorizationContextRepository {
  public constructor(private readonly context?: AdminIdentityAuthorizationContext) {}

  public async findForIdentity(): Promise<AdminIdentityAuthorizationContext | undefined> {
    return this.context;
  }
}

const activeContext: AdminIdentityAuthorizationContext = {
  principalId: "principal-1",
  principalStatus: "ACTIVE",
  membership: {
    membershipId: "membership-1",
    organizationId: "org-1",
    status: "ACTIVE",
    roles: ["FINANCE_MANAGER"],
  },
};

describe("administrative RBAC", () => {
  it("gives organization owners the complete built-in permission catalog", () => {
    expect(permissionsForRoles(["ORGANIZATION_OWNER"])).toEqual(ADMIN_PERMISSIONS);
  });

  it("keeps finance policy authority separate from human approval voting", () => {
    expect(hasPermission(["FINANCE_MANAGER"], "policy.activate")).toBe(true);
    expect(hasPermission(["FINANCE_MANAGER"], "mandate.issue")).toBe(true);
    expect(hasPermission(["FINANCE_MANAGER"], "approval.vote")).toBe(false);
    expect(hasPermission(["APPROVER"], "approval.vote")).toBe(true);
  });

  it("unions permissions across multiple role assignments deterministically", () => {
    expect(permissionsForRoles(["AUDITOR", "APPROVER", "AUDITOR"])).toContain("audit.verify");
    expect(permissionsForRoles(["AUDITOR", "APPROVER", "AUDITOR"])).toContain("approval.vote");
    expect(permissionsForRoles(["AUDITOR", "APPROVER", "AUDITOR"])).not.toContain("policy.activate");
  });

  it("allows an active enrolled principal with the required organization permission", async () => {
    const authorizer = new AdminAuthorizer(new StaticAdminContextRepository(activeContext));

    await expect(
      authorizer.authorize({
        issuer: "https://idp.example",
        subject: "alice",
        organizationId: "org-1",
        permission: "policy.activate",
      }),
    ).resolves.toMatchObject({
      allowed: true,
      principalId: "principal-1",
      membershipId: "membership-1",
      organizationId: "org-1",
      permission: "policy.activate",
    });
  });

  it("fails closed for an identity that is not enrolled", async () => {
    const authorizer = new AdminAuthorizer(new StaticAdminContextRepository());

    await expect(
      authorizer.authorize({
        issuer: "https://idp.example",
        subject: "unknown",
        organizationId: "org-1",
        permission: "organization.read",
      }),
    ).resolves.toEqual({
      allowed: false,
      permission: "organization.read",
      reason: "IDENTITY_NOT_ENROLLED",
    });
  });

  it("fails closed when a principal has no membership in the target organization", async () => {
    const authorizer = new AdminAuthorizer(
      new StaticAdminContextRepository({
        principalId: "principal-1",
        principalStatus: "ACTIVE",
      }),
    );

    await expect(
      authorizer.authorize({
        issuer: "https://idp.example",
        subject: "alice",
        organizationId: "org-1",
        permission: "organization.read",
      }),
    ).resolves.toMatchObject({ allowed: false, reason: "MEMBERSHIP_NOT_FOUND" });
  });

  it("fails closed for suspended or disabled principals before evaluating roles", async () => {
    for (const principalStatus of ["SUSPENDED", "DISABLED"] as const) {
      const authorizer = new AdminAuthorizer(
        new StaticAdminContextRepository({ ...activeContext, principalStatus }),
      );
      const decision = await authorizer.authorize({
        issuer: "https://idp.example",
        subject: "alice",
        organizationId: "org-1",
        permission: "organization.read",
      });
      expect(decision).toMatchObject({ allowed: false, reason: "PRINCIPAL_INACTIVE" });
    }
  });

  it("fails closed for suspended or removed organization memberships", async () => {
    for (const status of ["SUSPENDED", "REMOVED"] as const) {
      const authorizer = new AdminAuthorizer(
        new StaticAdminContextRepository({
          ...activeContext,
          membership: { ...activeContext.membership!, status },
        }),
      );
      const decision = await authorizer.authorize({
        issuer: "https://idp.example",
        subject: "alice",
        organizationId: "org-1",
        permission: "organization.read",
      });
      expect(decision).toMatchObject({ allowed: false, reason: "MEMBERSHIP_INACTIVE" });
    }
  });

  it("rejects cross-organization context before considering otherwise sufficient roles", async () => {
    const authorizer = new AdminAuthorizer(
      new StaticAdminContextRepository({
        ...activeContext,
        membership: {
          ...activeContext.membership!,
          organizationId: "org-2",
          roles: ["ORGANIZATION_OWNER"],
        },
      }),
    );

    await expect(
      authorizer.authorize({
        issuer: "https://idp.example",
        subject: "alice",
        organizationId: "org-1",
        permission: "organization.manage",
      }),
    ).resolves.toMatchObject({ allowed: false, reason: "ORGANIZATION_MISMATCH" });
  });

  it("denies a valid principal whose assigned roles do not grant the requested action", async () => {
    const authorizer = new AdminAuthorizer(new StaticAdminContextRepository(activeContext));

    await expect(
      authorizer.authorize({
        issuer: "https://idp.example",
        subject: "alice",
        organizationId: "org-1",
        permission: "role.assign",
      }),
    ).resolves.toMatchObject({ allowed: false, reason: "PERMISSION_DENIED" });
  });
});
