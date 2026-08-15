import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  permissionsForRoles,
  type AdminAuthorizer,
} from "../modules/admin/admin-authorizer.js";
import type { AdminBearerAuthenticator } from "../modules/admin/admin-jwt-authenticator.js";

const paramsSchema = z.object({
  organizationId: z.string().uuid(),
});

export interface AdminAccessRouteDependencies {
  readonly authenticator: AdminBearerAuthenticator;
  readonly authorizer: Pick<AdminAuthorizer, "authorize">;
}

export async function registerAdminAccessRoutes(
  app: FastifyInstance,
  dependencies: AdminAccessRouteDependencies,
): Promise<void> {
  app.get("/v1/admin/organizations/:organizationId/access", async (request, reply) => {
    const parsedParams = paramsSchema.safeParse(request.params);
    if (!parsedParams.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }

    if (authorizationHeaderCount(request) !== 1) {
      reply.header("www-authenticate", 'Bearer realm="mino-admin"');
      return reply.code(401).send({ error: "unauthorized" });
    }

    const authentication = dependencies.authenticator.authenticateAuthorizationHeader(
      request.headers.authorization,
    );
    if (!authentication.authenticated) {
      reply.header("www-authenticate", 'Bearer realm="mino-admin"');
      return reply.code(401).send({ error: "unauthorized" });
    }

    const authorization = await dependencies.authorizer.authorize({
      issuer: authentication.issuer,
      subject: authentication.subject,
      organizationId: parsedParams.data.organizationId,
      permission: "organization.read",
    });
    if (!authorization.allowed) {
      return reply.code(403).send({ error: "forbidden" });
    }

    return reply.code(200).send({
      principalId: authorization.principalId,
      membershipId: authorization.membershipId,
      organizationId: authorization.organizationId,
      roles: authorization.roles,
      permissions: permissionsForRoles(authorization.roles),
    });
  });
}

function authorizationHeaderCount(request: FastifyRequest): number {
  let count = 0;
  const rawHeaders = request.raw.rawHeaders;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === "authorization") {
      count += 1;
    }
  }
  return count;
}
