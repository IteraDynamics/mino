import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SignedAuthorizationReceipt } from "../domain/economic/authorization-receipt.js";
import { DecisionVerdict } from "../domain/evaluation/evaluation.types.js";
import { AgentRequestError } from "../modules/agents/agent-request-verifier.js";
import { ApprovalRequestConflictError } from "../modules/approvals/durable-approval.service.js";
import { MandateTokenError } from "../modules/mandates/mandate-token.service.js";
import {
  PersonalACPExecutionService,
  PersonalExecutionCredentialUnavailableError,
} from "../modules/personal/personal-execution.service.js";
import {
  IdempotencyConflictError,
  PaymentOutcomePendingError,
  ProxyAuthenticationError,
  ProxyProtocolError,
  ProxyUpstreamError,
  type CheckoutProxyResult,
} from "../modules/proxy/checkout-proxy.service.js";
import type { AuthorizationReceiptIssuer } from "../modules/receipts/authorization-receipt.service.js";
import {
  AuthorizationReceiptPendingError,
  issueTerminalAuthorizationReceipt,
} from "./authorization-receipt-response.js";

interface CompleteParams {
  merchantId: string;
  checkoutSessionId: string;
}

export interface PersonalExecutionRouteDependencies {
  readonly execution: Pick<PersonalACPExecutionService, "completeCheckout">;
  readonly receipts?: AuthorizationReceiptIssuer;
  readonly now?: () => Date;
}

export async function registerPersonalExecutionRoutes(
  app: FastifyInstance,
  dependencies: PersonalExecutionRouteDependencies,
): Promise<void> {
  const now = dependencies.now ?? (() => new Date());

  app.post<{ Params: CompleteParams; Body: unknown }>(
    "/v1/personal/acp/:merchantId/checkout_sessions/:checkoutSessionId/complete",
    async (request, reply) => {
      try {
        const security = parseMinoSecurityHeaders(request);
        const requestNow = now();
        const result = await dependencies.execution.completeCheckout({
          merchantId: request.params.merchantId,
          checkoutSessionId: request.params.checkoutSessionId,
          requestId: randomUUID(),
          idempotencyKey: requiredHeader(request, "idempotency-key"),
          path: request.url,
          body: request.body,
          security,
          now: requestNow,
        });
        const receipt = await issueTerminalAuthorizationReceipt(
          result,
          dependencies.receipts,
          requestNow,
        );
        return sendDecision(reply, result, receipt);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
}

function parseMinoSecurityHeaders(request: FastifyRequest) {
  return {
    mandateToken: requiredHeader(request, "x-mino-mandate-token"),
    apiVersion: requiredHeader(request, "api-version"),
    agentProof: {
      agentId: requiredHeader(request, "x-mino-agent-id"),
      keyId: requiredHeader(request, "x-mino-agent-key-id"),
      timestamp: requiredHeader(request, "x-mino-agent-timestamp"),
      nonce: requiredHeader(request, "x-mino-agent-nonce"),
      signature: requiredHeader(request, "x-mino-agent-signature"),
    },
  };
}

function requiredHeader(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  const normalized = Array.isArray(value) ? value[0] : value;
  if (typeof normalized !== "string" || !normalized.trim()) {
    throw new ProxyAuthenticationError(`Missing required header: ${name}`);
  }
  return normalized;
}

function sendDecision(
  reply: FastifyReply,
  result: CheckoutProxyResult,
  receipt?: SignedAuthorizationReceipt,
) {
  const status =
    result.decision.verdict === DecisionVerdict.ALLOW
      ? result.upstream?.status ?? 200
      : result.decision.verdict === DecisionVerdict.PENDING_HUMAN_APPROVAL
        ? 202
        : 403;

  return reply.code(status).send({
    decision: JSON.parse(
      JSON.stringify(result.decision, (_key, value) =>
        typeof value === "bigint" ? value.toString(10) : value,
      ),
    ),
    ...(result.checkoutSessionId ? { checkout_session_id: result.checkoutSessionId } : {}),
    ...(result.approvalRequestId ? { approval_request_id: result.approvalRequestId } : {}),
    ...(result.paymentOutcomeId ? { payment_outcome_id: result.paymentOutcomeId } : {}),
    ...(receipt ? { authorization_receipt: receipt } : {}),
    ...(result.replayed ? { idempotent_replayed: true } : {}),
    ...(result.upstream ? { upstream: result.upstream.body } : {}),
  });
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthorizationReceiptPendingError) {
    reply.header("retry-after", "2");
    return reply.code(409).send({
      error: "AUTHORIZATION_RECEIPT_PENDING",
      reason: error.message,
      payment_outcome_id: error.paymentOutcomeId,
    });
  }

  if (error instanceof PersonalExecutionCredentialUnavailableError) {
    return reply.code(503).send({
      error: "EXECUTION_TARGET_UNAVAILABLE",
      reason: "The requested Personal execution target is not configured",
    });
  }

  if (
    error instanceof ProxyAuthenticationError ||
    error instanceof MandateTokenError ||
    error instanceof AgentRequestError
  ) {
    return reply.code(401).send({
      error: "UNAUTHORIZED",
      reason:
        error instanceof MandateTokenError || error instanceof AgentRequestError
          ? error.code
          : error.message,
    });
  }

  if (error instanceof ProxyProtocolError) {
    return reply.code(400).send({ error: "PROTOCOL_ERROR", reason: error.message });
  }

  if (error instanceof IdempotencyConflictError || error instanceof ApprovalRequestConflictError) {
    return reply.code(409).send({ error: "IDEMPOTENCY_CONFLICT", reason: error.message });
  }

  if (error instanceof PaymentOutcomePendingError) {
    reply.header("retry-after", "2");
    return reply.code(409).send({
      error: "PAYMENT_OUTCOME_PENDING",
      reason: error.message,
      payment_outcome_id: error.outcomeId,
      ...(error.upstreamStatus !== undefined ? { upstream_status: error.upstreamStatus } : {}),
    });
  }

  if (error instanceof ProxyUpstreamError) {
    return reply.code(502).send({ error: "UPSTREAM_ERROR", upstream_status: error.status });
  }

  console.error(error instanceof Error ? error.message : "Unknown Personal execution error");
  return reply.code(500).send({ error: "INTERNAL_ERROR" });
}
