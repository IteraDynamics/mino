import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ApprovalAlreadyResolvedError,
  ApprovalVoteConflictError,
  ApprovalVoteDecision,
} from "../modules/approvals/approval-request.store.js";
import type { PersonalOwnerBearerAuthenticator } from "../modules/personal/personal-owner-authenticator.js";
import type { PersonalAuthenticatedIdentity } from "../modules/personal/personal-pairing.service.js";
import type { PostgresPersonalApprovalService } from "../modules/personal/personal-approval.service.js";

const approvalParamsSchema = z.object({ approvalRequestId: z.string().uuid() });
const decisionBodySchema = z
  .object({
    decision: z.enum(["APPROVE", "REJECT"]),
    comment: z.string().min(1).max(1_000).optional(),
  })
  .strict();

export interface PersonalApprovalRouteDependencies {
  readonly authenticator: PersonalOwnerBearerAuthenticator;
  readonly approvals: Pick<PostgresPersonalApprovalService, "getApproval" | "decide">;
}

export async function registerPersonalApprovalRoutes(
  app: FastifyInstance,
  dependencies: PersonalApprovalRouteDependencies,
): Promise<void> {
  app.get("/v1/personal/approvals/:approvalRequestId", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const identity = authenticateOwner(request, dependencies.authenticator);
    if (!identity) return reply.code(401).send({ error: "unauthorized" });
    const params = approvalParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request" });

    const approval = await dependencies.approvals.getApproval(
      identity,
      params.data.approvalRequestId,
    );
    if (!approval) return reply.code(404).send({ error: "approval_not_found" });
    return reply.send({ approval });
  });

  app.post("/v1/personal/approvals/:approvalRequestId/decision", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const identity = authenticateOwner(request, dependencies.authenticator);
    if (!identity) return reply.code(401).send({ error: "unauthorized" });
    const params = approvalParamsSchema.safeParse(request.params);
    const body = decisionBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }

    try {
      const result = await dependencies.approvals.decide(
        identity,
        params.data.approvalRequestId,
        body.data.decision === "APPROVE"
          ? ApprovalVoteDecision.APPROVE
          : ApprovalVoteDecision.REJECT,
        body.data.comment,
      );
      switch (result.outcome) {
        case "UPDATED":
        case "REPLAYED":
          return reply.code(200).send(result);
        case "OWNER_NOT_FOUND":
          return reply.code(403).send({ outcome: result.outcome, error: "personal_owner_required" });
        case "APPROVAL_NOT_FOUND":
          return reply.code(404).send({ outcome: result.outcome, error: "approval_not_found" });
        case "NOT_PERSONAL_APPROVAL":
          return reply.code(403).send({ outcome: result.outcome, error: "approval_not_owned" });
      }
    } catch (error) {
      if (error instanceof ApprovalAlreadyResolvedError) {
        return reply.code(409).send({ error: "approval_already_resolved" });
      }
      if (error instanceof ApprovalVoteConflictError) {
        return reply.code(409).send({ error: "approval_vote_conflict" });
      }
      throw error;
    }
  });
}

function authenticateOwner(
  request: FastifyRequest,
  authenticator: PersonalOwnerBearerAuthenticator,
): PersonalAuthenticatedIdentity | undefined {
  const authentication = authenticator.authenticateAuthorizationHeader(request.headers.authorization);
  if (!authentication.authenticated) return undefined;
  return { issuer: authentication.issuer, subject: authentication.subject };
}
