import type { FastifyReply, FastifyRequest } from "fastify";
import type {
  AdminAuthorizer,
  AdminPermission,
  AdminRole,
} from "../modules/admin/admin-authorizer.js";
import type { AdminBearerAuthenticator } from "../modules/admin/admin-jwt-authenticator.js";

export interface AdminHttpAuthorizationDependencies {
  readonly authenticator: AdminBearerAuthenticator;
  readonly authorizer: Pick<AdminAuthorizer, "authorize">;
}

export interface AuthorizedAdminHttpContext {
  readonly principalId: string;
  readonly membershipId: string;
  readonly organizationId: string;
  readonly roles: readonly AdminRole[];
}

export async function requireAdminPermission(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AdminHttpAuthorizationDependencies,
  organizationId: string,
  permission: AdminPermission,
): Promise<AuthorizedAdminHttpContext | undefined> {
  reply.header("cache-control", "no-store");

  if (authorizationHeaderCount(request) !== 1) {
    reply.header("www-authenticate", 'Bearer realm="mino-admin"');
    await reply.code(401).send({ error: "unauthorized" });
    return undefined;
  }

  const authentication = dependencies.authenticator.authenticateAuthorizationHeader(
    request.headers.authorization,
  );
  if (!authentication.authenticated) {
    reply.header("www-authenticate", 'Bearer realm="mino-admin"');
    await reply.code(401).send({ error: "unauthorized" });
    return undefined;
  }

  const authorization = await dependencies.authorizer.authorize({
    issuer: authentication.issuer,
    subject: authentication.subject,
    organizationId,
    permission,
  });
  if (!authorization.allowed) {
    await reply.code(403).send({ error: "forbidden" });
    return undefined;
  }

  return {
    principalId: authorization.principalId,
    membershipId: authorization.membershipId,
    organizationId: authorization.organizationId,
    roles: authorization.roles,
  };
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
