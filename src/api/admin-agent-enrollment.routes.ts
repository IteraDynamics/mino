import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  AdminAgentEnrollmentValidationError,
  type AdminAgentEnrollmentRequest,
  type PostgresAdminAgentEnrollmentService,
} from "../modules/admin/admin-agent-enrollment.js";
import {
  requireAdminPermission,
  type AdminHttpAuthorizationDependencies,
} from "./admin-http-authorization.js";

const paramsSchema = z.object({
  organizationId: z.string().uuid(),
});

const bodySchema = z
  .object({
    externalAgentId: z.string().min(1).max(256),
    displayName: z.string().min(1).max(256).optional(),
    keyId: z.string().min(1).max(256),
    publicKey: z.string().min(1).max(16 * 1024),
  })
  .strict();

export interface AdminAgentEnrollmentRouteDependencies extends AdminHttpAuthorizationDependencies {
  readonly agentEnrollment: Pick<PostgresAdminAgentEnrollmentService, "enroll">;
}

export async function registerAdminAgentEnrollmentRoutes(
  app: FastifyInstance,
  dependencies: AdminAgentEnrollmentRouteDependencies,
): Promise<void> {
  app.post("/v1/admin/organizations/:organizationId/agents", async (request, reply) => {
    const parsedParams = paramsSchema.safeParse(request.params);
    const parsedBody = bodySchema.safeParse(request.body);
    if (!parsedParams.success || !parsedBody.success) {
      reply.header("cache-control", "no-store");
      return reply.code(400).send({ error: "invalid_request" });
    }

    const authorization = await requireAdminPermission(
      request,
      reply,
      dependencies,
      parsedParams.data.organizationId,
      "agent.create",
    );
    if (!authorization) {
      return;
    }

    try {
      const result = await dependencies.agentEnrollment.enroll(authorization, parsedBody.data);
      switch (result.outcome) {
        case "CREATED":
          return reply.code(201).send({
            requestId: result.requestId,
            created: true,
            agent: result.agent,
            auditReceipt: result.audit,
          });
        case "REPLAYED":
          return reply.code(200).send({
            requestId: result.requestId,
            created: false,
            agent: result.agent,
          });
        case "CONFLICT":
          return reply.code(409).send({ error: "conflict", requestId: result.requestId });
      }
    } catch (error) {
      if (error instanceof AdminAgentEnrollmentValidationError) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      throw error;
    }
  });
}

export function adminAgentEnrollmentRequestForTest(
  value: AdminAgentEnrollmentRequest,
): AdminAgentEnrollmentRequest {
  return value;
}
