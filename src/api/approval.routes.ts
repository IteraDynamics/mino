import type { FastifyInstance, FastifyRequest } from "fastify";
import type { HumanApprovalService } from "../modules/approvals/durable-approval.service.js";
import { ApprovalVoteDecision } from "../modules/approvals/durable-approval.service.js";
import {
  ApprovalAlreadyResolvedError,
  ApprovalRequestNotFoundError,
  ApprovalVoteConflictError,
  type ApprovalRequestRecord,
} from "../modules/approvals/approval-request.store.js";
import {
  ApprovalResolutionAuthError,
  type ApprovalResolutionAuthenticator,
} from "../modules/approvals/approval-resolution-authenticator.js";

export interface ApprovalRoutesOptions {
  readonly approvals: HumanApprovalService;
  readonly authenticator: ApprovalResolutionAuthenticator;
  readonly now?: () => Date;
}

interface ApprovalParams {
  approvalRequestId: string;
}

interface ApprovalVoteBody {
  decision: "APPROVE" | "REJECT";
  comment?: string;
}

export async function registerApprovalRoutes(
  app: FastifyInstance,
  options: ApprovalRoutesOptions,
): Promise<void> {
  const now = options.now ?? (() => new Date());

  app.get<{ Params: ApprovalParams }>(
    "/v1/approvals/:approvalRequestId",
    async (request, reply) => {
      try {
        await authenticateResolutionRequest(request, options.authenticator, null, now());
        const approval = await options.approvals.getById(request.params.approvalRequestId, now());
        if (!approval) {
          return reply.code(404).send({ error: "APPROVAL_NOT_FOUND" });
        }
        return reply.code(200).send(serializeApproval(approval));
      } catch (error) {
        return sendApprovalError(reply, error);
      }
    },
  );

  app.post<{ Params: ApprovalParams; Body: ApprovalVoteBody }>(
    "/v1/approvals/:approvalRequestId/votes",
    async (request, reply) => {
      try {
        const at = now();
        const proof = await authenticateResolutionRequest(
          request,
          options.authenticator,
          request.body,
          at,
        );
        const decision = parseVoteDecision(request.body);
        const approval = await options.approvals.castVote({
          approvalRequestId: request.params.approvalRequestId,
          approverId: proof.approverId,
          decision,
          ...(request.body.comment?.trim() ? { comment: request.body.comment.trim() } : {}),
          now: at,
        });
        return reply.code(200).send(serializeApproval(approval));
      } catch (error) {
        return sendApprovalError(reply, error);
      }
    },
  );
}

async function authenticateResolutionRequest(
  request: FastifyRequest,
  authenticator: ApprovalResolutionAuthenticator,
  body: unknown,
  now: Date,
) {
  const proof = {
    approverId: requiredHeader(request, "x-mino-approver-id"),
    timestamp: requiredHeader(request, "x-mino-approval-timestamp"),
    signature: requiredHeader(request, "x-mino-approval-signature"),
  };
  await authenticator.verify({
    method: request.method,
    path: request.url,
    body,
    proof,
    now,
  });
  return proof;
}

function parseVoteDecision(body: ApprovalVoteBody): ApprovalVoteDecision {
  if (!body || (body.decision !== "APPROVE" && body.decision !== "REJECT")) {
    throw new Error("Approval vote decision must be APPROVE or REJECT");
  }
  return body.decision === "APPROVE"
    ? ApprovalVoteDecision.APPROVE
    : ApprovalVoteDecision.REJECT;
}

function requiredHeader(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  if (Array.isArray(value)) {
    if (value[0]) {
      return value[0];
    }
  } else if (typeof value === "string" && value) {
    return value;
  }
  throw new ApprovalResolutionAuthError("INVALID_SIGNATURE");
}

function serializeApproval(approval: ApprovalRequestRecord) {
  return {
    approval_request_id: approval.id,
    status: approval.status,
    decision_id: approval.decisionId,
    request_id: approval.requestId,
    merchant_domain: approval.merchantDomain,
    ...(approval.checkoutSessionId
      ? { checkout_session_id: approval.checkoutSessionId }
      : {}),
    amount_minor: approval.amountMinor.toString(10),
    currency: approval.currency,
    required_signatures: approval.requiredSignatures,
    votes: approval.votes.map((vote) => ({
      approver_id: vote.approverId,
      decision: vote.decision,
      created_at: vote.createdAt.toISOString(),
      ...(vote.comment ? { comment: vote.comment } : {}),
    })),
    created_at: approval.createdAt.toISOString(),
    expires_at: approval.expiresAt.toISOString(),
    ...(approval.resolvedAt ? { resolved_at: approval.resolvedAt.toISOString() } : {}),
  };
}

function sendApprovalError(reply: { code(statusCode: number): { send(payload: unknown): unknown } }, error: unknown) {
  if (error instanceof ApprovalResolutionAuthError) {
    return reply.code(401).send({ error: "UNAUTHORIZED", reason: error.code });
  }
  if (error instanceof ApprovalRequestNotFoundError) {
    return reply.code(404).send({ error: "APPROVAL_NOT_FOUND" });
  }
  if (error instanceof ApprovalVoteConflictError) {
    return reply.code(409).send({ error: "APPROVAL_VOTE_CONFLICT", reason: error.message });
  }
  if (error instanceof ApprovalAlreadyResolvedError) {
    return reply.code(409).send({ error: "APPROVAL_ALREADY_RESOLVED", reason: error.message });
  }
  if (error instanceof Error && /APPROVE or REJECT/.test(error.message)) {
    return reply.code(400).send({ error: "INVALID_APPROVAL_VOTE", reason: error.message });
  }
  console.error(error instanceof Error ? error.message : "Unknown approval resolution error");
  return reply.code(500).send({ error: "INTERNAL_ERROR" });
}
