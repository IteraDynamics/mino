export const ADMIN_PERMISSIONS = [
  "organization.read",
  "organization.manage",
  "membership.read",
  "membership.manage",
  "role.assign",
  "agent.read",
  "agent.create",
  "agent.update",
  "agent.suspend",
  "agent.reactivate",
  "agent.rotate_key",
  "merchant.read",
  "merchant.manage",
  "policy.read",
  "policy.create",
  "policy.activate",
  "policy.deactivate",
  "mandate.read",
  "mandate.issue",
  "mandate.revoke",
  "governance.read",
  "approval.read",
  "approval.vote",
  "payment.read",
  "audit.read",
  "audit.verify",
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

export const ADMIN_ROLES = [
  "ORGANIZATION_OWNER",
  "SECURITY_ADMIN",
  "FINANCE_MANAGER",
  "AGENT_MANAGER",
  "APPROVER",
  "AUDITOR",
] as const;

export type AdminRole = (typeof ADMIN_ROLES)[number];
export type AdminPrincipalStatus = "ACTIVE" | "SUSPENDED" | "DISABLED";
export type AdminMembershipStatus = "ACTIVE" | "SUSPENDED" | "REMOVED";

const READ_ONLY_PERMISSIONS = [
  "organization.read",
  "membership.read",
  "agent.read",
  "merchant.read",
  "policy.read",
  "mandate.read",
  "governance.read",
  "approval.read",
  "payment.read",
  "audit.read",
  "audit.verify",
] as const satisfies readonly AdminPermission[];

const ROLE_PERMISSIONS = {
  ORGANIZATION_OWNER: ADMIN_PERMISSIONS,
  SECURITY_ADMIN: [
    "organization.read",
    "membership.read",
    "agent.read",
    "agent.create",
    "agent.update",
    "agent.suspend",
    "agent.reactivate",
    "agent.rotate_key",
    "merchant.read",
    "merchant.manage",
    "policy.read",
    "policy.create",
    "policy.activate",
    "policy.deactivate",
    "mandate.read",
    "mandate.issue",
    "mandate.revoke",
    "governance.read",
    "approval.read",
    "payment.read",
    "audit.read",
    "audit.verify",
  ],
  FINANCE_MANAGER: [
    "organization.read",
    "membership.read",
    "agent.read",
    "merchant.read",
    "policy.read",
    "policy.create",
    "policy.activate",
    "policy.deactivate",
    "mandate.read",
    "mandate.issue",
    "mandate.revoke",
    "governance.read",
    "approval.read",
    "payment.read",
    "audit.read",
  ],
  AGENT_MANAGER: [
    "organization.read",
    "agent.read",
    "agent.create",
    "agent.update",
    "agent.suspend",
    "agent.reactivate",
    "agent.rotate_key",
    "merchant.read",
    "policy.read",
    "mandate.read",
    "mandate.issue",
    "mandate.revoke",
    "governance.read",
  ],
  APPROVER: [
    "organization.read",
    "agent.read",
    "policy.read",
    "mandate.read",
    "governance.read",
    "approval.read",
    "approval.vote",
    "payment.read",
  ],
  AUDITOR: READ_ONLY_PERMISSIONS,
} as const satisfies Record<AdminRole, readonly AdminPermission[]>;

export interface AdminMembershipAuthorizationContext {
  readonly membershipId: string;
  readonly organizationId: string;
  readonly status: AdminMembershipStatus;
  readonly roles: readonly AdminRole[];
}

export interface AdminIdentityAuthorizationContext {
  readonly principalId: string;
  readonly principalStatus: AdminPrincipalStatus;
  readonly membership?: AdminMembershipAuthorizationContext;
}

export interface AdminIdentityLookup {
  readonly issuer: string;
  readonly subject: string;
  readonly organizationId: string;
}

export interface AdminAccessPresentationLookup {
  readonly principalId: string;
  readonly membershipId: string;
  readonly organizationId: string;
}

export interface AdminAccessPresentation {
  readonly organizationName: string;
  readonly principalDisplayName?: string;
  readonly principalEmail?: string;
}

export interface AdminAuthorizationContextRepository {
  findForIdentity(input: AdminIdentityLookup): Promise<AdminIdentityAuthorizationContext | undefined>;
  findAccessPresentation?(
    input: AdminAccessPresentationLookup,
  ): Promise<AdminAccessPresentation | undefined>;
}

export type AdminAuthorizationDenialReason =
  | "IDENTITY_NOT_ENROLLED"
  | "MEMBERSHIP_NOT_FOUND"
  | "PRINCIPAL_INACTIVE"
  | "MEMBERSHIP_INACTIVE"
  | "ORGANIZATION_MISMATCH"
  | "PERMISSION_DENIED";

export type AdminAuthorizationDecision =
  | {
      readonly allowed: true;
      readonly principalId: string;
      readonly membershipId: string;
      readonly organizationId: string;
      readonly permission: AdminPermission;
      readonly roles: readonly AdminRole[];
    }
  | {
      readonly allowed: false;
      readonly permission: AdminPermission;
      readonly reason: AdminAuthorizationDenialReason;
    };

export interface AdminAuthorizationRequest extends AdminIdentityLookup {
  readonly permission: AdminPermission;
}

export class AdminAuthorizer {
  public constructor(private readonly repository: AdminAuthorizationContextRepository) {}

  public async authorize(request: AdminAuthorizationRequest): Promise<AdminAuthorizationDecision> {
    const context = await this.repository.findForIdentity(request);
    if (!context) {
      return deny(request.permission, "IDENTITY_NOT_ENROLLED");
    }
    if (context.principalStatus !== "ACTIVE") {
      return deny(request.permission, "PRINCIPAL_INACTIVE");
    }
    if (!context.membership) {
      return deny(request.permission, "MEMBERSHIP_NOT_FOUND");
    }
    if (context.membership.status !== "ACTIVE") {
      return deny(request.permission, "MEMBERSHIP_INACTIVE");
    }
    if (context.membership.organizationId !== request.organizationId) {
      return deny(request.permission, "ORGANIZATION_MISMATCH");
    }
    if (!hasPermission(context.membership.roles, request.permission)) {
      return deny(request.permission, "PERMISSION_DENIED");
    }

    return {
      allowed: true,
      principalId: context.principalId,
      membershipId: context.membership.membershipId,
      organizationId: context.membership.organizationId,
      permission: request.permission,
      roles: [...new Set(context.membership.roles)],
    };
  }

  public async accessPresentation(
    input: AdminAccessPresentationLookup,
  ): Promise<AdminAccessPresentation | undefined> {
    return this.repository.findAccessPresentation?.(input);
  }
}

export function hasPermission(
  roles: readonly AdminRole[],
  permission: AdminPermission,
): boolean {
  return roles.some((role) => ROLE_PERMISSIONS[role].includes(permission as never));
}

export function permissionsForRoles(roles: readonly AdminRole[]): readonly AdminPermission[] {
  const permissions = new Set<AdminPermission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role]) {
      permissions.add(permission);
    }
  }
  return ADMIN_PERMISSIONS.filter((permission) => permissions.has(permission));
}

function deny(
  permission: AdminPermission,
  reason: AdminAuthorizationDenialReason,
): AdminAuthorizationDecision {
  return { allowed: false, permission, reason };
}
