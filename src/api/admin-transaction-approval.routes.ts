import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  ADMIN_APPROVAL_STATUSES,
  ADMIN_PAYMENT_STATUSES,
  AdminTransactionApprovalValidationError,
  type AdminApprovalFilter,
  type AdminApprovalVoteRequest,
  type AdminApprovalVoteResult,
  type AdminPaymentFilter,
  type PostgresAdminTransactionApprovalOperations,
} from "../modules/admin/admin-transaction-approval-operations.js";
import {
  requireAdminPermission,
  type AdminHttpAuthorizationDependencies,
} from "./admin-http-authorization.js";

const organizationParamsSchema = z.object({ organizationId: z.string().uuid() });
const approvalParamsSchema = z.object({
  organizationId: z.string().uuid(),
  approvalRequestId: z.string().uuid(),
});
const paymentParamsSchema = z.object({
  organizationId: z.string().uuid(),
  paymentOutcomeId: z.string().uuid(),
});

const commonQueryFields = {
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(512).optional(),
  userId: z.string().uuid().optional(),
  agentId: z.string().uuid().optional(),
  mandateId: z.string().uuid().optional(),
  merchantId: z.string().min(1).max(256).optional(),
  createdAfter: z.string().datetime({ offset: true }).optional(),
  createdBefore: z.string().datetime({ offset: true }).optional(),
};

const approvalQuerySchema = z
  .object({
    ...commonQueryFields,
    status: z.enum(ADMIN_APPROVAL_STATUSES).optional(),
  })
  .strict();

const paymentQuerySchema = z
  .object({
    ...commonQueryFields,
    status: z.enum(ADMIN_PAYMENT_STATUSES).optional(),
    checkoutSessionId: z.string().min(1).max(256).optional(),
  })
  .strict();

const voteBodySchema = z
  .object({
    decision: z.enum(["APPROVE", "REJECT"]),
    comment: z.string().max(1000).optional(),
  })
  .strict();

export interface AdminTransactionApprovalRouteDependencies
  extends AdminHttpAuthorizationDependencies {
  readonly operations: Pick<
    PostgresAdminTransactionApprovalOperations,
    "listApprovals" | "getApproval" | "castApprovalVote" | "listPayments" | "getPayment"
  >;
}

export async function registerAdminTransactionApprovalRoutes(
  app: FastifyInstance,
  dependencies: AdminTransactionApprovalRouteDependencies,
): Promise<void> {
  app.get("/v1/admin/organizations/:organizationId/approvals", async (request, reply) => {
    const params = organizationParamsSchema.safeParse(request.params);
    const query = approvalQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      reply.header("cache-control", "no-store");
      return reply.code(400).send({ error: "invalid_request" });
    }
    const authorization = await requireAdminPermission(
      request,
      reply,
      dependencies,
      params.data.organizationId,
      "approval.read",
    );
    if (!authorization) {
      return;
    }
    try {
      return reply.code(200).send(
        await dependencies.operations.listApprovals(
          params.data.organizationId,
          approvalFilter(query.data),
        ),
      );
    } catch (error) {
      return sendValidationError(reply, error);
    }
  });

  app.get(
    "/v1/admin/organizations/:organizationId/approvals/:approvalRequestId",
    async (request, reply) => {
      const params = approvalParamsSchema.safeParse(request.params);
      if (!params.success) {
        reply.header("cache-control", "no-store");
        return reply.code(400).send({ error: "invalid_request" });
      }
      const authorization = await requireAdminPermission(
        request,
        reply,
        dependencies,
        params.data.organizationId,
        "approval.read",
      );
      if (!authorization) {
        return;
      }
      try {
        const approval = await dependencies.operations.getApproval(
          params.data.organizationId,
          params.data.approvalRequestId,
        );
        return approval
          ? reply.code(200).send({ approval })
          : reply.code(404).send({ error: "not_found" });
      } catch (error) {
        return sendValidationError(reply, error);
      }
    },
  );

  app.post(
    "/v1/admin/organizations/:organizationId/approvals/:approvalRequestId/votes",
    async (request, reply) => {
      const params = approvalParamsSchema.safeParse(request.params);
      const body = voteBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        reply.header("cache-control", "no-store");
        return reply.code(400).send({ error: "invalid_request" });
      }
      const authorization = await requireAdminPermission(
        request,
        reply,
        dependencies,
        params.data.organizationId,
        "approval.vote",
      );
      if (!authorization) {
        return;
      }
      try {
        return sendVoteResult(
          reply,
          await dependencies.operations.castApprovalVote(
            authorization,
            params.data.approvalRequestId,
            approvalVoteRequest(body.data),
          ),
        );
      } catch (error) {
        return sendValidationError(reply, error);
      }
    },
  );

  app.get("/v1/admin/organizations/:organizationId/payments", async (request, reply) => {
    const params = organizationParamsSchema.safeParse(request.params);
    const query = paymentQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      reply.header("cache-control", "no-store");
      return reply.code(400).send({ error: "invalid_request" });
    }
    const authorization = await requireAdminPermission(
      request,
      reply,
      dependencies,
      params.data.organizationId,
      "payment.read",
    );
    if (!authorization) {
      return;
    }
    try {
      return reply.code(200).send(
        await dependencies.operations.listPayments(
          params.data.organizationId,
          paymentFilter(query.data),
        ),
      );
    } catch (error) {
      return sendValidationError(reply, error);
    }
  });

  app.get(
    "/v1/admin/organizations/:organizationId/payments/:paymentOutcomeId",
    async (request, reply) => {
      const params = paymentParamsSchema.safeParse(request.params);
      if (!params.success) {
        reply.header("cache-control", "no-store");
        return reply.code(400).send({ error: "invalid_request" });
      }
      const authorization = await requireAdminPermission(
        request,
        reply,
        dependencies,
        params.data.organizationId,
        "payment.read",
      );
      if (!authorization) {
        return;
      }
      try {
        const payment = await dependencies.operations.getPayment(
          params.data.organizationId,
          params.data.paymentOutcomeId,
        );
        return payment
          ? reply.code(200).send({ payment })
          : reply.code(404).send({ error: "not_found" });
      } catch (error) {
        return sendValidationError(reply, error);
      }
    },
  );
}

function approvalFilter(query: z.infer<typeof approvalQuerySchema>): AdminApprovalFilter {
  return {
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
    ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
    ...(query.status !== undefined ? { status: query.status } : {}),
    ...(query.userId !== undefined ? { userId: query.userId } : {}),
    ...(query.agentId !== undefined ? { agentId: query.agentId } : {}),
    ...(query.mandateId !== undefined ? { mandateId: query.mandateId } : {}),
    ...(query.merchantId !== undefined ? { merchantId: query.merchantId } : {}),
    ...(query.createdAfter !== undefined ? { createdAfter: query.createdAfter } : {}),
    ...(query.createdBefore !== undefined ? { createdBefore: query.createdBefore } : {}),
  };
}

function paymentFilter(query: z.infer<typeof paymentQuerySchema>): AdminPaymentFilter {
  return {
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
    ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
    ...(query.status !== undefined ? { status: query.status } : {}),
    ...(query.userId !== undefined ? { userId: query.userId } : {}),
    ...(query.agentId !== undefined ? { agentId: query.agentId } : {}),
    ...(query.mandateId !== undefined ? { mandateId: query.mandateId } : {}),
    ...(query.merchantId !== undefined ? { merchantId: query.merchantId } : {}),
    ...(query.checkoutSessionId !== undefined
      ? { checkoutSessionId: query.checkoutSessionId }
      : {}),
    ...(query.createdAfter !== undefined ? { createdAfter: query.createdAfter } : {}),
    ...(query.createdBefore !== undefined ? { createdBefore: query.createdBefore } : {}),
  };
}

function approvalVoteRequest(body: z.infer<typeof voteBodySchema>): AdminApprovalVoteRequest {
  return {
    decision: body.decision,
    ...(body.comment !== undefined ? { comment: body.comment } : {}),
  };
}

function sendVoteResult(reply: FastifyReply, result: AdminApprovalVoteResult) {
  switch (result.outcome) {
    case "UPDATED":
      return reply.code(200).send({
        outcome: result.outcome,
        changed: true,
        requestId: result.requestId,
        approval: result.approval,
        auditReceipt: result.audit,
      });
    case "REPLAYED":
      return reply.code(200).send({
        outcome: result.outcome,
        changed: false,
        requestId: result.requestId,
        approval: result.approval,
      });
    case "NOT_FOUND":
      return reply.code(404).send({ error: "not_found", requestId: result.requestId });
    case "CONFLICT":
      return reply.code(409).send({ error: "approval_vote_conflict", requestId: result.requestId });
    case "ALREADY_RESOLVED":
      return reply.code(409).send({
        error: "approval_already_resolved",
        requestId: result.requestId,
        approval: result.approval,
      });
  }
}

function sendValidationError(reply: FastifyReply, error: unknown) {
  if (error instanceof AdminTransactionApprovalValidationError) {
    return reply.code(400).send({ error: "invalid_request" });
  }
  throw error;
}
