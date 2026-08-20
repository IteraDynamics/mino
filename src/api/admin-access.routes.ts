import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  permissionsForRoles,
  type AdminAuthorizer,
} from "../modules/admin/admin-authorizer.js";
import {
  requireAdminPermission,
  type AdminHttpAuthorizationDependencies,
} from "./admin-http-authorization.js";

const paramsSchema = z.object({
  organizationId: z.string().uuid(),
});

export type AdminAccessRouteDependencies = Omit<
  AdminHttpAuthorizationDependencies,
  "authorizer"
> & {
  readonly authorizer: Pick<AdminAuthorizer, "authorize" | "accessPresentation">;
};

export async function registerAdminAccessRoutes(
  app: FastifyInstance,
  dependencies: AdminAccessRouteDependencies,
): Promise<void> {
  app.get("/v1/admin/organizations/:organizationId/access", async (request, reply) => {
    const parsedParams = paramsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      reply.header("cache-control", "no-store");
      return reply.code(400).send({ error: "invalid_request" });
    }

    const authorization = await requireAdminPermission(
      request,
      reply,
      dependencies,
      parsedParams.data.organizationId,
      "organization.read",
    );
    if (!authorization) {
      return;
    }

    const presentation = await dependencies.authorizer.accessPresentation({
      principalId: authorization.principalId,
      membershipId: authorization.membershipId,
      organizationId: authorization.organizationId,
    });

    return reply.code(200).send({
      principalId: authorization.principalId,
      membershipId: authorization.membershipId,
      organizationId: authorization.organizationId,
      organization: {
        id: authorization.organizationId,
        ...(presentation?.organizationName !== undefined
          ? { name: presentation.organizationName }
          : {}),
      },
      principal: {
        id: authorization.principalId,
        ...(presentation?.principalDisplayName !== undefined
          ? { displayName: presentation.principalDisplayName }
          : {}),
        ...(presentation?.principalEmail !== undefined
          ? { email: presentation.principalEmail }
          : {}),
      },
      roles: authorization.roles,
      permissions: permissionsForRoles(authorization.roles),
    });
  });
}
