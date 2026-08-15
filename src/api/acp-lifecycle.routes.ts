import type { FastifyInstance, FastifyRequest } from "fastify";
import { AgentRequestAuthenticationError } from "../modules/agents/agent-request-verifier.js";
import {
  CheckoutLifecycleProxyService,
  type MutatingCheckoutLifecycleInput,
  type RetrieveCheckoutLifecycleInput,
} from "../modules/proxy/checkout-lifecycle-proxy.service.js";
import {
  ProxyAuthenticationError,
  ProxyProtocolError,
  ProxyUpstreamError,
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
      const body = {};
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
  return {
    mandateToken: requiredHeader(request, "x-mino-mandate-token"),
    agentProof: {
      keyId: requiredHeader(request, "x-mino-agent-key-id"),
      timestamp: requiredHeader(request, "x-mino-agent-timestamp"),
      nonce: requiredHeader(request, "x-mino-agent-nonce"),
      signature: requiredHeader(request, "x-mino-agent-signature"),
    },
    authorization: requiredHeader(request, "authorization"),
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
  throw new ProxyAuthenticationError(`Missing required header ${name}`);
}

function serializeDecision(decision: {
  readonly decisionId: string;
  readonly mandateId: string;
  readonly policyVersion: number;
  readonly verdict: string;
  readonly reasons: readonly string[];
  readonly requestedAmount: { readonly currency: string; readonly minorUnits: bigint };
  readonly policyAmount: { readonly currency: string; readonly minorUnits: bigint };
  readonly approvedAmount?: { readonly currency: string; readonly minorUnits: bigint };
}) {
  return {
    decision_id: decision.decisionId,
    mandate_id: decision.mandateId,
    policy_version: decision.policyVersion,
    verdict: decision.verdict,
    reasons: decision.reasons,
    requested_amount: {
      currency: decision.requestedAmount.currency,
      minor_units: decision.requestedAmount.minorUnits.toString(10),
    },
    policy_amount: {
      currency: decision.policyAmount.currency,
      minor_units: decision.policyAmount.minorUnits.toString(10),
    },
    ...(decision.approvedAmount
      ? {
          approved_amount: {
            currency: decision.approvedAmount.currency,
            minor_units: decision.approvedAmount.minorUnits.toString(10),
          },
        }
      : {}),
  };
}

function sendLifecycleResult(
  reply: Parameters<FastifyInstance["get"]>[1] extends never ? never : any,
  result: Awaited<ReturnType<CheckoutLifecycleProxyService["retrieveCheckout"]>>,
) {
  const status = result.upstream?.status ?? 200;
  return reply.code(status).send({
    decision: serializeDecision(result.decision),
    checkout_session_id: result.checkoutSessionId,
    upstream: result.upstream?.body,
  });
}

function sendLifecycleError(reply: any, error: unknown) {
  if (error instanceof ProxyProtocolError) {
    return reply.code(400).send({ error: "protocol_error", message: error.message });
  }
  if (error instanceof ProxyAuthenticationError || error instanceof AgentRequestAuthenticationError) {
    return reply.code(401).send({ error: "authentication_error", message: error.message });
  }
  if (error instanceof ProxyUpstreamError) {
    return reply.code(error.status).send({
      error: "upstream_failure",
      message: error.message,
      upstream: error.upstreamBody,
    });
  }
  throw error;
}
