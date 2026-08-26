import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { SignedAuthorizationReceipt } from "../domain/economic/authorization-receipt.js";
import { DecisionVerdict } from "../domain/evaluation/evaluation.types.js";
import { AgentRequestError } from "../modules/agents/agent-request-verifier.js";
import { ApprovalRequestConflictError } from "../modules/approvals/durable-approval.service.js";
import { MandateTokenError } from "../modules/mandates/mandate-token.service.js";
import {
  PERSONAL_STRIPE_API_VERSION,
  PersonalStripeExecutionService,
  PersonalStripeProviderError,
  type PersonalStripeExecutionResult,
} from "../modules/personal/personal-stripe-execution.service.js";
import {
  IdempotencyConflictError,
  PaymentOutcomePendingError,
  ProxyAuthenticationError,
} from "../modules/proxy/checkout-proxy.service.js";
import type { AuthorizationReceiptIssuer } from "../modules/receipts/authorization-receipt.service.js";
import {
  AuthorizationReceiptPendingError,
  issueTerminalAuthorizationReceipt,
} from "./authorization-receipt-response.js";

const paramsSchema = z.object({
  paymentIntentId: z.string().regex(/^pi_[A-Za-z0-9]+$/),
});
const bodySchema = z.object({}).strict();

export interface PersonalStripeExecutionRouteDependencies {
  readonly execution: Pick<PersonalStripeExecutionService, "confirmPaymentIntent">;
  readonly receipts?: AuthorizationReceiptIssuer;
  readonly now?: () => Date;
}

export async function registerPersonalStripeExecutionRoutes(
  app: FastifyInstance,
  dependencies: PersonalStripeExecutionRouteDependencies,
): Promise<void> {
  const now = dependencies.now ?? (() => new Date());

  app.post(
    "/v1/personal/stripe/payment_intents/:paymentIntentId/confirm",
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      try {
        const params = paramsSchema.safeParse(request.params);
        const body = bodySchema.safeParse(request.body ?? {});
        if (!params.success || !body.success) {
          return reply.code(400).send({ error: "INVALID_REQUEST" });
        }

        const requestNow = now();
        const result = await dependencies.execution.confirmPaymentIntent({
          paymentIntentId: params.data.paymentIntentId,
          requestId: randomUUID(),
          idempotencyKey: requiredHeader(request, "idempotency-key"),
          path: request.url,
          body: body.data,
          security: {
            mandateToken: requiredHeader(request, "x-mino-mandate-token"),
            apiVersion: requiredHeader(request, "api-version"),
            agentProof: {
              agentId: requiredHeader(request, "x-mino-agent-id"),
              keyId: requiredHeader(request, "x-mino-agent-key-id"),
              timestamp: requiredHeader(request, "x-mino-agent-timestamp"),
              nonce: requiredHeader(request, "x-mino-agent-nonce"),
              signature: requiredHeader(request, "x-mino-agent-signature"),
            },
          },
          now: requestNow,
        });
        const receipt = await issueTerminalAuthorizationReceipt(
          result,
          dependencies.receipts,
          requestNow,
        );
        return sendResult(reply, result, receipt);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
}

function requiredHeader(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  const normalized = Array.isArray(value) ? value[0] : value;
  if (typeof normalized !== "string" || !normalized.trim()) {
    throw new ProxyAuthenticationError(`Missing required header: ${name}`);
  }
  return normalized;
}

function sendResult(
  reply: FastifyReply,
  result: PersonalStripeExecutionResult,
  receipt?: SignedAuthorizationReceipt,
) {
  const status = result.decision
    ? result.decision.verdict === DecisionVerdict.ALLOW
      ? result.upstream?.status ?? 200
      : result.decision.verdict === DecisionVerdict.PENDING_HUMAN_APPROVAL
        ? 202
        : 403
    : result.upstream?.status ?? 200;

  return reply.code(status).send({
    ...(result.decision
      ? {
          decision: JSON.parse(
            JSON.stringify(result.decision, (_key, value) =>
              typeof value === "bigint" ? value.toString(10) : value,
            ),
          ),
        }
      : {}),
    payment_intent_id: result.paymentIntentId,
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

  if (error instanceof PersonalStripeProviderError) {
    const unavailable = error.message.includes("credential is unavailable");
    const unsupportedVersion = error.message.startsWith("Unsupported Personal Stripe API-Version");
    if (unsupportedVersion) {
      return reply.code(400).send({
        error: "UNSUPPORTED_API_VERSION",
        expected_api_version: PERSONAL_STRIPE_API_VERSION,
      });
    }
    return reply.code(unavailable ? 503 : 502).send({
      error: unavailable ? "EXECUTION_TARGET_UNAVAILABLE" : "STRIPE_PROVIDER_ERROR",
      reason: error.message,
    });
  }

  if (
    error instanceof Error &&
    (
      error.message.includes("Authoritative Stripe PaymentIntent state changed after authorization") ||
      error.message.includes("Stripe PaymentIntent live/test mode") ||
      error.message.includes("does not permit manual capture PaymentIntents") ||
      error.message.includes("not ready for server-side confirmation") ||
      error.message.includes("must already have a server-visible payment method attached")
    )
  ) {
    return reply.code(409).send({ error: "STRIPE_STATE_CONFLICT", reason: error.message });
  }

  console.error(error instanceof Error ? error.message : "Unknown Personal Stripe execution error");
  return reply.code(500).send({ error: "INTERNAL_ERROR" });
}