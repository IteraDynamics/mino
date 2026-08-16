import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  AdminAgentLifecycleValidationError,
  type AdminAgentLifecycleMutationResult,
  type PostgresAdminAgentLifecycleService,
} from "../modules/admin/admin-agent-lifecycle.js";
import {
  requireAdminPermission,
  type AdminHttpAuthorizationDependencies,
} from "./admin-http-authorization.js";

const paramsSchema = z.object({
  organizationId: z.string().uuid(),
  agentId: z.string().uuid(),
});

const rotateKeyBodySchema = z
  .object({
    keyId: z.string().min(1).max(256),
    publicKey: z.string().min(1).max(16 * 1024),
  })
  .strict();

export interface AdminAgentLifecycleRouteDependencies extends AdminHttpAuthorizationDependencies {
  readonly agentLifecycle: Pick<
    PostgresAdminAgentLifecycleService,
    "getAgent" | "suspend" | "reactivate" | "rotateKey"
  >;
}

export async function registerAdminAgentLifecycleRoutes(
  app: FastifyInstance,
  dependencies: AdminAgentLifecycleRouteDependencies,
): Promise<void> {
  app.get("/v1/admin/organizations/:organizationId/agents/:agentId", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      reply.header("cache-control", "no-store");
      return reply.code(400).send({ error: "invalid_request" });
    }
    const authorization = await requireAdminPermission(
      request,
      reply,
      dependencies,
      params.data.organizationId,
      "agent.read",
    );
    if (!authorization) {
      return;
    }
    const agent = await dependencies.agentLifecycle.getAgent(
      params.data.organizationId,
      params.data.agentId,
    );
    if (!agent) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.code(200).send({ agent });
  });

  app.post(
    "/v1/admin/organizations/:organizationId/agents/:agentId/suspend",
    async (request, reply) => {
      const input = await authorizeMutation(request, reply, dependencies, "agent.suspend");
      if (!input) {
        return;
      }
      return sendMutationResult(
        reply,
        await dependencies.agentLifecycle.suspend(input.authorization, input.agentId),
      );
    },
  );

  app.post(
    "/v1/admin/organizations/:organizationId/agents/:agentId/reactivate",
    async (request, reply) => {
      const input = await authorizeMutation(request, reply, dependencies, "agent.reactivate");
      if (!input) {
        return;
      }
      return sendMutationResult(
        reply,
        await dependencies.agentLifecycle.reactivate(input.authorization, input.agentId),
      );
    },
  );

  app.post(
    "/v1/admin/organizations/:organizationId/agents/:agentId/rotate-key",
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      const body = rotateKeyBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        reply.header("cache-control", "no-store");
        return reply.code(400).send({ error: "invalid_request" });
      }
      const authorization = await requireAdminPermission(
        request,
        reply,
        dependencies,
        params.data.organizationId,
        "agent.rotate_key",
      );
      if (!authorization) {
        return;
      }
      try {
        return sendMutationResult(
          reply,
          await dependencies.agentLifecycle.rotateKey(authorization, params.data.agentId, body.data),
        );
      } catch (error) {
        if (error instanceof AdminAgentLifecycleValidationError) {
          return reply.code(400).send({ error: "invalid_request" });
        }
        throw error;
      }
    },
  );
}

async function authorizeMutation(
  request: Parameters<typeof requireAdminPermission>[0],
  reply: Parameters<typeof requireAdminPermission>[1],
  dependencies: AdminAgentLifecycleRouteDependencies,
  permission: "agent.suspend" | "agent.reactivate",
): Promise<
  | {
      authorization: NonNullable<Awaited<ReturnType<typeof requireAdminPermission>>>;
      agentId: string;
    }
  | undefined
> {
  const params = paramsSchema.safeParse(request.params);
  if (!params.success) {
    reply.header("cache-control", "no-store");
    await reply.code(400).send({ error: "invalid_request" });
    return undefined;
  }
  const authorization = await requireAdminPermission(
    request,
    reply,
    dependencies,
    params.data.organizationId,
    permission,
  );
  if (!authorization) {
    return undefined;
  }
  return { authorization, agentId: params.data.agentId };
}

function sendMutationResult(
  reply: Parameters<typeof requireAdminPermission>[1],
  result: AdminAgentLifecycleMutationResult,
) {
  switch (result.outcome) {
    case "UPDATED":
      return reply.code(200).send({
        outcome: result.outcome,
        changed: true,
        requestId: result.requestId,
        agent: result.agent,
        auditReceipt: result.audit,
      });
    case "REPLAYED":
      return reply.code(200).send({
        outcome: result.outcome,
        changed: false,
        requestId: result.requestId,
        agent: result.agent,
      });
    case "NOT_FOUND":
      return reply.code(404).send({ error: "not_found", requestId: result.requestId });
    case "CONFLICT":
      return reply.code(409).send({ error: "conflict", requestId: result.requestId });
  }
}
