import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  AdminGovernancePermissionError,
  AdminGovernanceValidationError,
  type AdminGovernanceProposalResult,
  type PostgresAdminHighRiskGovernanceService,
} from "../modules/admin/admin-high-risk-governance.js";
import {
  AdminMandateValidationError,
  type AdminMandateIssueResult,
  type AdminMandateRevokeResult,
  type PostgresAdminMandateManagementService,
} from "../modules/admin/admin-mandate-management.js";
import {
  requireAdminPermission,
  type AdminHttpAuthorizationDependencies,
} from "./admin-http-authorization.js";

const organizationParamsSchema = z.object({ organizationId: z.string().uuid() });
const mandateParamsSchema = z.object({
  organizationId: z.string().uuid(),
  mandateId: z.string().uuid(),
});

const issueBodySchema = z
  .object({
    userId: z.string().uuid(),
    agentId: z.string().uuid(),
    policyId: z.string().uuid(),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

const idempotencyKeySchema = z.string().min(1).max(256).refine(
  (value) => !/[\u0000-\u001f\u007f]/.test(value),
  "idempotency key must not contain control characters",
);

export interface AdminMandateManagementRouteDependencies
  extends AdminHttpAuthorizationDependencies {
  readonly mandateManagement: Pick<
    PostgresAdminMandateManagementService,
    "getMandate" | "issue" | "revoke"
  >;
  readonly highRiskGovernance?: Pick<
    PostgresAdminHighRiskGovernanceService,
    "proposeMandateIssue"
  >;
}

export async function registerAdminMandateManagementRoutes(
  app: FastifyInstance,
  dependencies: AdminMandateManagementRouteDependencies,
): Promise<void> {
  app.get(
    "/v1/admin/organizations/:organizationId/mandates/:mandateId",
    async (request, reply) => {
      const params = mandateParamsSchema.safeParse(request.params);
      if (!params.success) {
        reply.header("cache-control", "no-store");
        return reply.code(400).send({ error: "invalid_request" });
      }
      const authorization = await requireAdminPermission(
        request,
        reply,
        dependencies,
        params.data.organizationId,
        "mandate.read",
      );
      if (!authorization) return;
      const mandate = await dependencies.mandateManagement.getMandate(
        params.data.organizationId,
        params.data.mandateId,
      );
      if (!mandate) return reply.code(404).send({ error: "not_found" });
      return reply.code(200).send({ mandate });
    },
  );

  app.post("/v1/admin/organizations/:organizationId/mandates", async (request, reply) => {
    const params = organizationParamsSchema.safeParse(request.params);
    const body = issueBodySchema.safeParse(request.body);
    const idempotency = idempotencyKeySchema.safeParse(request.headers["idempotency-key"]);
    if (!params.success || !body.success || !idempotency.success) {
      reply.header("cache-control", "no-store");
      return reply.code(400).send({ error: "invalid_request" });
    }

    const authorization = await requireAdminPermission(
      request,
      reply,
      dependencies,
      params.data.organizationId,
      "mandate.issue",
    );
    if (!authorization) return;

    try {
      if (dependencies.highRiskGovernance) {
        return sendGovernanceProposalResult(
          reply,
          await dependencies.highRiskGovernance.proposeMandateIssue(authorization, {
            userId: body.data.userId,
            agentId: body.data.agentId,
            policyId: body.data.policyId,
            expiresAt: body.data.expiresAt,
            idempotencyKey: idempotency.data,
          }),
        );
      }
      return sendIssueResult(
        reply,
        await dependencies.mandateManagement.issue(authorization, {
          userId: body.data.userId,
          agentId: body.data.agentId,
          policyId: body.data.policyId,
          expiresAt: body.data.expiresAt,
          idempotencyKey: idempotency.data,
        }),
      );
    } catch (error) {
      if (
        error instanceof AdminMandateValidationError ||
        error instanceof AdminGovernanceValidationError
      ) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      if (error instanceof AdminGovernancePermissionError) {
        return reply.code(403).send({ error: "forbidden" });
      }
      throw error;
    }
  });

  app.post(
    "/v1/admin/organizations/:organizationId/mandates/:mandateId/revoke",
    async (request, reply) => {
      const params = mandateParamsSchema.safeParse(request.params);
      if (!params.success) {
        reply.header("cache-control", "no-store");
        return reply.code(400).send({ error: "invalid_request" });
      }
      const authorization = await requireAdminPermission(
        request,
        reply,
        dependencies,
        params.data.organizationId,
        "mandate.revoke",
      );
      if (!authorization) return;
      return sendRevokeResult(
        reply,
        await dependencies.mandateManagement.revoke(authorization, params.data.mandateId),
      );
    },
  );
}

function sendGovernanceProposalResult(
  reply: FastifyReply,
  result: AdminGovernanceProposalResult,
) {
  switch (result.outcome) {
    case "PENDING_GOVERNANCE":
      return reply.code(202).send({
        outcome: result.outcome,
        changed: false,
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
    case "ALREADY_APPLIED":
      return reply.code(200).send({
        outcome: result.outcome,
        changed: false,
        requestId: result.requestId,
        resourceType: result.resourceType,
        resourceId: result.resourceId,
      });
    case "CONFLICT":
      return reply.code(409).send({ error: "conflict", requestId: result.requestId });
    case "NOT_FOUND":
      return reply.code(404).send({ error: "not_found", requestId: result.requestId });
    case "INVALID_TARGET":
      return reply.code(409).send({ error: "invalid_target", requestId: result.requestId });
  }
}

function sendIssueResult(reply: FastifyReply, result: AdminMandateIssueResult) {
  switch (result.outcome) {
    case "CREATED":
      return reply.code(201).send({
        outcome: result.outcome,
        changed: true,
        requestId: result.requestId,
        mandate: result.mandate,
        mandateToken: result.mandateToken,
        auditReceipt: result.audit,
      });
    case "REPLAYED":
      return reply.code(200).send({
        outcome: result.outcome,
        changed: false,
        requestId: result.requestId,
        mandate: result.mandate,
      });
    case "CONFLICT":
      return reply.code(409).send({ error: "conflict", requestId: result.requestId });
    case "INVALID_TARGET":
      return reply.code(409).send({ error: "invalid_target", requestId: result.requestId });
  }
}

function sendRevokeResult(reply: FastifyReply, result: AdminMandateRevokeResult) {
  switch (result.outcome) {
    case "UPDATED":
      return reply.code(200).send({
        outcome: result.outcome,
        changed: true,
        requestId: result.requestId,
        mandate: result.mandate,
        auditReceipt: result.audit,
      });
    case "REPLAYED":
      return reply.code(200).send({
        outcome: result.outcome,
        changed: false,
        requestId: result.requestId,
        mandate: result.mandate,
      });
    case "NOT_FOUND":
      return reply.code(404).send({ error: "not_found", requestId: result.requestId });
  }
}
