import type { PrismaClient } from "../../generated/prisma/client.js";
import type {
  AdminAuthorizationContextRepository,
  AdminIdentityAuthorizationContext,
  AdminIdentityLookup,
  AdminMembershipStatus,
  AdminPrincipalStatus,
  AdminRole,
} from "../../modules/admin/admin-authorizer.js";

export class PrismaAdminAuthorizationContextRepository
  implements AdminAuthorizationContextRepository
{
  public constructor(private readonly prisma: PrismaClient) {}

  public async findForIdentity(
    input: AdminIdentityLookup,
  ): Promise<AdminIdentityAuthorizationContext | undefined> {
    const principal = await this.prisma.adminPrincipal.findUnique({
      where: {
        issuer_subject: {
          issuer: input.issuer,
          subject: input.subject,
        },
      },
      select: {
        id: true,
        status: true,
        memberships: {
          where: { organizationId: input.organizationId },
          take: 1,
          select: {
            id: true,
            organizationId: true,
            status: true,
            roleAssignments: {
              orderBy: { role: "asc" },
              select: { role: true },
            },
          },
        },
      },
    });

    if (!principal) {
      return undefined;
    }

    const membership = principal.memberships[0];
    return {
      principalId: principal.id,
      principalStatus: principal.status as AdminPrincipalStatus,
      ...(membership
        ? {
            membership: {
              membershipId: membership.id,
              organizationId: membership.organizationId,
              status: membership.status as AdminMembershipStatus,
              roles: membership.roleAssignments.map((assignment) => assignment.role as AdminRole),
            },
          }
        : {}),
    };
  }
}
