import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AdminInventoryRepository } from "../modules/admin/admin-inventory.js";
import {
  requireAdminPermission,
  type AdminHttpAuthorizationDependencies,
} from "./admin-http-authorization.js";

const paramsSchema = z.object({
  organizationId: z.string().uuid(),
});

const querySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().uuid().optional(),
  })
  .strict();

export interface AdminInventoryRouteDependencies extends AdminHttpAuthorizationDependencies {
  readonly inventory: AdminInventoryRepository;
}

export async function registerAdminInventoryRoutes(
  app: FastifyInstance,
  dependencies: AdminInventoryRouteDependencies,
): Promise<void> {
  app.get("/v1/admin/organizations/:organizationId/agents", async (request, reply) => {
    const input = parseInventoryRequest(request.params, request.query);
    if (!input) {
      reply.header("cache-control", "no-store");
      return reply.code(400).send({ error: "invalid_request" });
    }
    const authorization = await requireAdminPermission(
      request,
      reply,
      dependencies,
      input.organizationId,
      "agent.read",
    );
    if (!authorization) {
      return;
    }
    return reply.code(200).send(await dependencies.inventory.listAgents(input));
  });

  app.get("/v1/admin/organizations/:organizationId/policies", async (request, reply) => {
    const input = parseInventoryRequest(request.params, request.query);
    if (!input) {
      reply.header("cache-control", "no-store");
      return reply.code(400).send({ error: "invalid_request" });
    }
    const authorization = await requireAdminPermission(
      request,
      reply,
      dependencies,
      input.organizationId,
      "policy.read",
    );
    if (!authorization) {
      return;
    }
    return reply.code(200).send(await dependencies.inventory.listPolicies(input));
  });

  app.get("/v1/admin/organizations/:organizationId/merchants", async (request, reply) => {
    const input = parseInventoryRequest(request.params, request.query);
    if (!input) {
      reply.header("cache-control", "no-store");
      return reply.code(400).send({ error: "invalid_request" });
    }
    const authorization = await requireAdminPermission(
      request,
      reply,
      dependencies,
      input.organizationId,
      "merchant.read",
    );
    if (!authorization) {
      return;
    }
    return reply.code(200).send(await dependencies.inventory.listMerchants(input));
  });

  app.get("/v1/admin/organizations/:organizationId/mandates", async (request, reply) => {
    const input = parseInventoryRequest(request.params, request.query);
    if (!input) {
      reply.header("cache-control", "no-store");
      return reply.code(400).send({ error: "invalid_request" });
    }
    const authorization = await requireAdminPermission(
      request,
      reply,
      dependencies,
      input.organizationId,
      "mandate.read",
    );
    if (!authorization) {
      return;
    }
    return reply.code(200).send(await dependencies.inventory.listMandates(input));
  });
}

function parseInventoryRequest(
  params: unknown,
  query: unknown,
): { organizationId: string; limit: number; cursor?: string } | undefined {
  const parsedParams = paramsSchema.safeParse(params);
  const parsedQuery = querySchema.safeParse(query);
  if (!parsedParams.success || !parsedQuery.success) {
    return undefined;
  }
  return {
    organizationId: parsedParams.data.organizationId,
    limit: parsedQuery.data.limit,
    ...(parsedQuery.data.cursor ? { cursor: parsedQuery.data.cursor } : {}),
  };
}
