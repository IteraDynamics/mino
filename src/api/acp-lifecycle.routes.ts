import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AgentRequestError } from "../modules/agents/agent-request-verifier.js";
import { MandateTokenError } from "../modules/mandates/mandate-token.service.js";
import {
  CheckoutLifecycleProxyService,
  type MutatingCheckoutLifecycleInput,
  type RetrieveCheckoutLifecycleInput,
} from "../modules/proxy/checkout-lifecycle-proxy.service.js";
import {
  ProxyAuthenticationError,
  ProxyProtocolError,
  ProxyUpstreamError,
  type CheckoutProxyResult,
  type ProxySecurityContext,
} from "../modules/proxy/checkout-proxy.service.js";

interface MerchantSessionParams {
  merchantId: string;
  checkoutSessionId: string;
}

export interface ACPLifecycleRouteDependencies {
  readonly lifecycleProxy: CheckoutLifecycleProxyService;
  readonly now?: () => Date;
}

export async function registerACPLifecycleRoutes(
  app: FastifyInstance,
  deps: ACPLifecycleRouteDependencies,
): Promise<void> {
  const now = deps.now ?? (() => new Date());

  app.get<{ Params: MerchantSessionParams }>(
    "/v1/acp/:merchantId/checkout_sessions/:checkoutSessionId",
    async (request, reply) => {
      const requestId = request.id;
      const path = request.url.split("?")[0] ?? request.url;
      const body = null;
      try {
        const result = await deps.lifecycleProxy.retrieveCheckout({
          merchantId: request.params.merchantId,
          checkoutSessionId: request.params.checkoutSessionId,
          requestId,
          idempotencyKey: "",
          path,
          body,
          security: securityContext(request),
          now: now(),
        } satisfies RetrieveCheckoutLifecycleInput);
        return sendLifecycleResult(reply, result);
      } catch (error) {
        return sendLifecycleError(reply, error);
      }
    },
  );

  app.post<{ Params: MerchantSessionParams; Body: unknown }>(
    "/v1/acp/:merchantId/checkout_sessions/:checkoutSessionId",
    async (request, reply) => {
      const requestId = request.id;
      const path = request.url.split("?")[0] ?? request.url;
      try {
        const result = await deps.lifecycleProxy.updateCheckout({
          merchantId: request.params.merchantId,
          checkoutSessionId: request.params.checkoutSessionId,
          requestId,
          idempotencyKey: requiredHeader(request, "idempotency-key"),
          path,
          body: request.body ?? {},
          security: securityContext(request),
          now: now(),
        } satisfies MutatingCheckoutLifecycleInput);
        return sendLifecycleResult(reply, result);
      } catch (error) {
        return sendLifecycleError(reply, error);
      }
    },
  );

  app.post<{ Params: MerchantSessionParams; Body: unknown }>(
    "/v1/acp/:merchantId/checkout_sessions/:checkoutSessionId/cancel",
    async (request, reply) => {
      const requestId = request.id;
      const path = request.url.split("?")[0] ?? request.url;
      try {
        const result = await deps.lifecycleProxy.cancelCheckout({
          merchantId: request.params.merchantId,
          checkoutSessionId: request.params.checkoutSessionId,
          requestId,
          idempotencyKey: requiredHeader(request, "idempotency-key"),
          path,
          body: request.body ?? {},
          security: securityContext(request),
          now: now(),
        } satisfies MutatingCheckoutLifecycleInput);
        return sendLifecycleResult(reply, result);
      } catch (error) {
        return sendLifecycleError(reply, error);
      }
    },
  );
}

function securityContext(request: FastifyRequest): ProxySecurityContext {
  const authorization = requiredHeader(request, "authorization");
  if (!/^Bearer\s+\S+$/i.test(authorization)) {
    throw new ProxyAuthenticationError("ACP Authorization header must use Bearer authentication");
  }

  return {
    mandateToken: requiredHeader(request, "x-mino-mandate-token"),
    agentProof: {
      agentId: requiredHeader(request, "x-mino-agent-id"),
      keyId: requiredHeader(request, "x-mino-agent-key-id"),
      timestamp: requiredHeader(request, "x-mino-agent-timestamp"),
      nonce: requiredHeader(request, "x-mino-agent-nonce"),
      signature: requiredHeader(request, "x-mino-agent-signature"),
    },
    authorization,
    apiVersion: requiredHeader(request, "api-version"),
  };
}

function requiredHeader(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (Array.isArray(value) && value[0]?.trim()) {
    return value[0].trim();
  }
  throw new ProxyAuthenticationError(`Missing required header: ${name}`);
}

function serializeDecision(decision: CheckoutProxyResult["decision"]) {
  return JSON.parse(
    JSON.stringify(decision, (_key, value) =>
      typeof value === "bigint" ? value.toString(10) : value,
    ),
  );
}

function sendLifecycleResult(reply: FastifyReply, result: CheckoutProxyResult) {
  const status = result.upstream?.status ?? 200;
  return reply.code(status).send({
    decision: serializeDecision(result.decision),
    checkout_session_id: result.checkoutSessionId,
    upstream: result.upstream?.body,
  });
}

function sendLifecycleError(reply: FastifyReply, error: unknown) {
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
    return reply.code(400).send({
      error: "PROTOCOL_ERROR",
      reason: error.message,
    });
  }
  if (error instanceof ProxyUpstreamError) {
    return reply.code(502).send({
      error: "UPSTREAM_ERROR",
      upstream_status: error.status,
    });
  }
  console.error(error instanceof Error ? error.message : "Unknown Mino lifecycle proxy error");
  return reply.code(500).send({ error: "INTERNAL_ERROR" });
}