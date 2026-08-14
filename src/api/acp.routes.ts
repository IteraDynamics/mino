import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  CheckoutProxyService,
  IdempotencyConflictError,
  PaymentOutcomePendingError,
  ProxyAuthenticationError,
  ProxyProtocolError,
  ProxyUpstreamError,
} from "../modules/proxy/checkout-proxy.service.js";
import { DecisionVerdict } from "../domain/evaluation/evaluation.types.js";
import { MandateTokenError } from "../modules/mandates/mandate-token.service.js";
import { AgentRequestError } from "../modules/agents/agent-request-verifier.js";

export interface ACPRoutesOptions {
  readonly proxy: CheckoutProxyService;
  readonly now?: () => Date;
}

interface MerchantParams {
  merchantId: string;
}

interface CompleteParams extends MerchantParams {
  checkoutSessionId: string;
}

export async function registerACPRoutes(
  app: FastifyInstance,
  options: ACPRoutesOptions,
): Promise<void> {
  const now = options.now ?? (() => new Date());

  app.post<{ Params: MerchantParams; Body: unknown }>(
    "/v1/acp/:merchantId/checkout_sessions",
    async (request, reply) => {
      try {
        const security = parseSecurityHeaders(request);
        const idempotencyKey = requiredHeader(request, "idempotency-key");
        const requestId = randomUUID();
        const result = await options.proxy.createCheckout({
          merchantId: request.params.merchantId,
          requestId,
          idempotencyKey,
          path: request.url,
          body: request.body,
          security,
          now: now(),
        });
        return sendDecision(reply, result);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Params: CompleteParams; Body: unknown }>(
    "/v1/acp/:merchantId/checkout_sessions/:checkoutSessionId/complete",
    async (request, reply) => {
      try {
        const security = parseSecurityHeaders(request);
        const idempotencyKey = requiredHeader(request, "idempotency-key");
        const requestId = randomUUID();
        const result = await options.proxy.completeCheckout({
          merchantId: request.params.merchantId,
          checkoutSessionId: request.params.checkoutSessionId,
          requestId,
          idempotencyKey,
          path: request.url,
          body: request.body,
          security,
          now: now(),
        });
        return sendDecision(reply, result);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
}

function parseSecurityHeaders(request: FastifyRequest) {
  const authorization = requiredHeader(request, "authorization");
  if (!/^Bearer\s+\S+$/i.test(authorization)) {
    throw new ProxyAuthenticationError("ACP Authorization header must use Bearer authentication");
  }

  return {
    mandateToken: requiredHeader(request, "x-mino-mandate-token"),
    authorization,
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
  const value = optionalHeader(request, name);
  if (!value) {
    throw new ProxyAuthenticationError(`Missing required header: ${name}`);
  }
  return value;
}

function optionalHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }
  return typeof value === "string" ? value : undefined;
}

function sendDecision(reply: FastifyReply, result: Awaited<ReturnType<CheckoutProxyService["completeCheckout"]>>) {
  const status =
    result.decision.verdict === DecisionVerdict.ALLOW
      ? result.upstream?.status ?? 200
      : result.decision.verdict === DecisionVerdict.PENDING_HUMAN_APPROVAL
        ? 202
        : 403;

  return reply.code(status).send({
    decision: serializeDecision(result.decision),
    ...(result.checkoutSessionId ? { checkout_session_id: result.checkoutSessionId } : {}),
    ...(result.paymentOutcomeId ? { payment_outcome_id: result.paymentOutcomeId } : {}),
    ...(result.replayed ? { idempotent_replayed: true } : {}),
    ...(result.upstream ? { upstream: result.upstream.body } : {}),
  });
}

function serializeDecision(decision: Awaited<ReturnType<CheckoutProxyService["completeCheckout"]>>["decision"]) {
  return JSON.parse(
    JSON.stringify(decision, (_key, value) =>
      typeof value === "bigint" ? value.toString(10) : value,
    ),
  );
}

function sendError(reply: FastifyReply, error: unknown) {
  if (
    error instanceof ProxyAuthenticationError ||
    error instanceof MandateTokenError ||
    error instanceof AgentRequestError
  ) {
    return reply.code(401).send({
      error: "UNAUTHORIZED",
      reason: error instanceof MandateTokenError || error instanceof AgentRequestError ? error.code : error.message,
    });
  }

  if (error instanceof ProxyProtocolError) {
    return reply.code(400).send({
      error: "PROTOCOL_ERROR",
      reason: error.message,
    });
  }

  if (error instanceof IdempotencyConflictError) {
    return reply.code(409).send({
      error: "IDEMPOTENCY_CONFLICT",
      reason: error.message,
    });
  }

  if (error instanceof PaymentOutcomePendingError) {
    reply.header("Retry-After", "2");
    return reply.code(409).send({
      error: "PAYMENT_OUTCOME_PENDING",
      reason: error.message,
      payment_outcome_id: error.outcomeId,
      ...(error.upstreamStatus !== undefined ? { upstream_status: error.upstreamStatus } : {}),
    });
  }

  if (error instanceof ProxyUpstreamError) {
    return reply.code(502).send({
      error: "UPSTREAM_ERROR",
      upstream_status: error.status,
    });
  }

  requestSafeLog(error);
  return reply.code(500).send({ error: "INTERNAL_ERROR" });
}

function requestSafeLog(error: unknown): void {
  console.error(error instanceof Error ? error.message : "Unknown Mino proxy error");
}
