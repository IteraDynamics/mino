import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  ADMIN_GOVERNANCE_ACTIONS,
  ADMIN_GOVERNANCE_STATUSES,
  ADMIN_GOVERNANCE_VOTE_DECISIONS,
  AdminGovernancePermissionError,
  AdminGovernanceValidationError,
  type AdminGovernanceApplyResult,
  type AdminGovernanceFilter,
  type AdminGovernanceVoteRequest,
  type AdminGovernanceVoteResult,
  type PostgresAdminHighRiskGovernanceService,
} from "../modules/admin/admin-high-risk-governance.js";
import {
  requireAdminPermission,
  type AdminHttpAuthorizationDependencies,
} from "./admin-http-authorization.js";

const organizationParamsSchema = z.object({ organizationId: z.string().uuid() }).strict();
const governanceParamsSchema = z
  .object({
    organizationId: z.string().uuid(),
    governanceRequestId: z.string().uuid(),
  })
  .strict();
const governanceQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().min(1).max(512).optional(),
    status: z.enum(ADMIN_GOVERNANCE_STATUSES).optional(),
    action: z.enum(ADMIN_GOVERNANCE_ACTIONS).optional(),
  })
  .strict();
const voteBodySchema = z
  .object({
    decision: z.enum(ADMIN_GOVERNANCE_VOTE_DECISIONS),
    comment: z.string().max(1000).optional(),
  })
  .strict();

export interface AdminHighRiskGovernanceRouteDependencies
  extends AdminHttpAuthorizationDependencies {
  readonly governance: Pick<
    PostgresAdminHighRiskGovernanceService,
    "list" | "get" | "requiredPermission" | "vote" | "apply"
  >;
}

export async function registerAdminHighRiskGovernanceRoutes(
  app: FastifyInstance,
  dependencies: AdminHighRiskGovernanceRouteDependencies,
): Promise<void> {
  app.get("/v1/admin/organizations/:organizationId/governance", async (request, reply) => {
    const params = organizationParamsSchema.safeParse(request.params);
    const query = governanceQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return invalidRequest(reply);
    if (
      !(await requireAdminPermission(
        request,
        reply,
        dependencies,
        params.data.organizationId,
        "governance.read",
      ))
    ) {
      return;
    }
    try {
      return reply.code(200).send(
        await dependencies.governance.list(
          params.data.organizationId,
          governanceFilter(query.data),
        ),
      );
    } catch (error) {
      return sendGovernanceError(reply, error);
    }
  });

  app.get(
    "/v1/admin/organizations/:organizationId/governance/:governanceRequestId",
    async (request, reply) => {
      const params = governanceParamsSchema.safeParse(request.params);
      if (!params.success) return invalidRequest(reply);
      if (
        !(await requireAdminPermission(
          request,
          reply,
          dependencies,
          params.data.organizationId,
          "governance.read",
        ))
      ) {
        return;
      }
      try {
        const governanceRequest = await dependencies.governance.get(
          params.data.organizationId,
          params.data.governanceRequestId,
        );
        return governanceRequest
          ? reply.code(200).send({ governanceRequest })
          : reply.code(404).send({ error: "not_found" });
      } catch (error) {
        return sendGovernanceError(reply, error);
      }
    },
  );

  app.post(
    "/v1/admin/organizations/:organizationId/governance/:governanceRequestId/votes",
    async (request, reply) => {
      const params = governanceParamsSchema.safeParse(request.params);
      const body = voteBodySchema.safeParse(request.body);
      if (!params.success || !body.success) return invalidRequest(reply);
      const actor = await authorizeGovernedMutation(
        request,
        reply,
        dependencies,
        params.data.organizationId,
        params.data.governanceRequestId,
      );
      if (!actor) return;
      try {
        return sendVoteResult(
          reply,
          await dependencies.governance.vote(
            actor,
            params.data.governanceRequestId,
            governanceVoteRequest(body.data),
          ),
        );
      } catch (error) {
        return sendGovernanceError(reply, error);
      }
    },
  );

  app.post(
    "/v1/admin/organizations/:organizationId/governance/:governanceRequestId/apply",
    async (request, reply) => {
      const params = governanceParamsSchema.safeParse(request.params);
      if (!params.success) return invalidRequest(reply);
      const actor = await authorizeGovernedMutation(
        request,
        reply,
        dependencies,
        params.data.organizationId,
        params.data.governanceRequestId,
      );
      if (!actor) return;
      try {
        return sendApplyResult(
          reply,
          await dependencies.governance.apply(actor, params.data.governanceRequestId),
        );
      } catch (error) {
        return sendGovernanceError(reply, error);
      }
    },
  );
}

async function authorizeGovernedMutation(
  request: Parameters<typeof requireAdminPermission>[0],
  reply: Parameters<typeof requireAdminPermission>[1],
  dependencies: AdminHighRiskGovernanceRouteDependencies,
  organizationId: string,
  governanceRequestId: string,
) {
  const reader = await requireAdminPermission(
    request,
    reply,
    dependencies,
    organizationId,
    "governance.read",
  );
  if (!reader) return undefined;
  const requiredPermission = await dependencies.governance.requiredPermission(
    organizationId,
    governanceRequestId,
  );
  if (!requiredPermission) {
    await reply.code(404).send({ error: "not_found" });
    return undefined;
  }
  return requireAdminPermission(
    request,
    reply,
    dependencies,
    organizationId,
    requiredPermission,
  );
}

function governanceFilter(query: z.infer<typeof governanceQuerySchema>): AdminGovernanceFilter {
  return {
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
    ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
    ...(query.status !== undefined ? { status: query.status } : {}),
    ...(query.action !== undefined ? { action: query.action } : {}),
  };
}

function governanceVoteRequest(body: z.infer<typeof voteBodySchema>): AdminGovernanceVoteRequest {
  return {
    decision: body.decision,
    ...(body.comment !== undefined ? { comment: body.comment } : {}),
  };
}

function sendVoteResult(reply: FastifyReply, result: AdminGovernanceVoteResult) {
  switch (result.outcome) {
    case "UPDATED":
      return reply.code(200).send({
        outcome: result.outcome,
        changed: true,
        requestId: result.requestId,
        governanceRequest: result.governanceRequest,
        auditReceipt: result.audit,
      });
    case "REPLAYED":
      return reply.code(200).send({
        outcome: result.outcome,
        changed: false,
        requestId: result.requestId,
        governanceRequest: result.governanceRequest,
      });
    case "NOT_FOUND":
      return reply.code(404).send({ error: "not_found", requestId: result.requestId });
    case "CONFLICT":
      return reply.code(409).send({ error: "governance_vote_conflict", requestId: result.requestId });
    case "ALREADY_RESOLVED":
      return reply.code(409).send({
        error: "governance_already_resolved",
        requestId: result.requestId,
        governanceRequest: result.governanceRequest,
      });
  }
}

function sendApplyResult(reply: FastifyReply, result: AdminGovernanceApplyResult) {
  switch (result.outcome) {
    case "APPLIED":
      return reply.code(200).send({
        outcome: result.outcome,
        changed: true,
        action: result.action,
        requestId: result.requestId,
        governanceRequest: result.governanceRequest,
        ...(result.action === "MANDATE_ISSUE"
          ? { mandate: result.mandate, mandateToken: result.mandateToken }
          : { policy: result.policy }),
        mutationAuditReceipt: result.mutationAudit,
        governanceAuditReceipt: result.governanceAudit,
      });
    case "REPLAYED":
      return reply.code(200).send({
        outcome: result.outcome,
        changed: false,
        requestId: result.requestId,
        governanceRequest: result.governanceRequest,
      });
    case "STALE":
      return reply.code(409).send({
        error: "governance_stale",
        requestId: result.requestId,
        governanceRequest: result.governanceRequest,
        auditReceipt: result.audit,
      });
    case "EXPIRED":
      return reply.code(409).send({
        error: "governance_expired",
        requestId: result.requestId,
        governanceRequest: result.governanceRequest,
        auditReceipt: result.audit,
      });
    case "NOT_FOUND":
      return reply.code(404).send({ error: "not_found", requestId: result.requestId });
    case "NOT_APPROVED":
      return reply.code(409).send({
        error: "governance_not_approved",
        requestId: result.requestId,
        governanceRequest: result.governanceRequest,
      });
  }
}

function invalidRequest(reply: FastifyReply) {
  reply.header("cache-control", "no-store");
  return reply.code(400).send({ error: "invalid_request" });
}

function sendGovernanceError(reply: FastifyReply, error: unknown) {
  if (error instanceof AdminGovernanceValidationError) {
    return reply.code(400).send({ error: "invalid_request" });
  }
  if (error instanceof AdminGovernancePermissionError) {
    return reply.code(403).send({ error: "forbidden" });
  }
  throw error;
}
