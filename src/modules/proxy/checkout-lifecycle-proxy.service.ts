import { canonicalJson, sha256Base64Url } from "../../infrastructure/crypto/canonical-json.js";
import type { AgentSpendMandate } from "../../domain/mandates/mandate.types.js";
import {
  DecisionVerdict,
  type PolicyDecision,
} from "../../domain/evaluation/evaluation.types.js";
import type { AgentRequestAuthenticator } from "../agents/agent-request-verifier.js";
import type { AuditSink } from "../audit/audit-sink.js";
import { redactSensitivePayload } from "../audit/audit-sink.js";
import type { MandateTokenService } from "../mandates/mandate-token.service.js";
import { ACP_STABLE_VERSION } from "./acp-adapter.js";
import type {
  CheckoutProxyResult,
  MandateRepository,
  ProxySecurityContext,
} from "./checkout-proxy.service.js";
import {
  ProxyAuthenticationError,
  ProxyProtocolError,
  ProxyUpstreamError,
} from "./checkout-proxy.service.js";
import type {
  ACPMerchantClient,
  MerchantEndpoint,
  MerchantRegistry,
  MerchantRequestHeaders,
  MerchantResponse,
} from "./merchant-client.js";
import { assertRegisteredHttpsTarget } from "./merchant-client.js";

export type CheckoutLifecycleOperation =
  | "RETRIEVE_CHECKOUT_SESSION"
  | "UPDATE_CHECKOUT_SESSION"
  | "CANCEL_CHECKOUT_SESSION";

export interface CheckoutLifecycleMerchantClient
  extends Pick<ACPMerchantClient, "getCheckout" | "cancelCheckout"> {
  updateCheckout(
    merchant: MerchantEndpoint,
    checkoutSessionId: string,
    payload: unknown,
    headers: MerchantRequestHeaders,
  ): Promise<MerchantResponse>;
}

export interface CheckoutLifecycleProxyDependencies {
  readonly mandateTokens: MandateTokenService;
  readonly mandates: MandateRepository;
  readonly agentRequests: AgentRequestAuthenticator;
  readonly merchants: MerchantRegistry;
  readonly merchantClient: CheckoutLifecycleMerchantClient;
  readonly audit: AuditSink;
  readonly generateId: () => string;
}

interface LifecycleBaseInput {
  readonly merchantId: string;
  readonly checkoutSessionId: string;
  readonly requestId: string;
  readonly path: string;
  readonly body: unknown;
  readonly security: ProxySecurityContext;
  readonly now: Date;
}

export interface RetrieveCheckoutLifecycleInput extends LifecycleBaseInput {
  /**
   * ACP retrieval does not require merchant idempotency. Mino binds the signed
   * request to an empty idempotency value so the existing agent-proof format can
   * be reused without forwarding an Idempotency-Key upstream.
   */
  readonly idempotencyKey: "";
}

export interface MutatingCheckoutLifecycleInput extends LifecycleBaseInput {
  readonly idempotencyKey: string;
}

/**
 * Authenticated, audited ACP lifecycle operations that are explicitly outside the
 * spend-reservation/payment-completion boundary.
 *
 * This service can retrieve, update, or cancel a registered merchant checkout. It
 * has no dependency on Redis spend reservations, PaymentOutcome, approvals, or
 * delegation assertions. Payment authority therefore remains exclusively in the
 * existing completeCheckout path.
 */
export class CheckoutLifecycleProxyService {
  public constructor(private readonly deps: CheckoutLifecycleProxyDependencies) {}

  public async retrieveCheckout(
    input: RetrieveCheckoutLifecycleInput,
  ): Promise<CheckoutProxyResult> {
    return this.execute(input, "GET", "RETRIEVE_CHECKOUT_SESSION", async (merchant, headers) =>
      this.deps.merchantClient.getCheckout(merchant, input.checkoutSessionId, headers),
    );
  }

  public async updateCheckout(
    input: MutatingCheckoutLifecycleInput,
  ): Promise<CheckoutProxyResult> {
    return this.execute(input, "POST", "UPDATE_CHECKOUT_SESSION", async (merchant, headers) =>
      this.deps.merchantClient.updateCheckout(
        merchant,
        input.checkoutSessionId,
        input.body,
        headers,
      ),
    );
  }

  public async cancelCheckout(
    input: MutatingCheckoutLifecycleInput,
  ): Promise<CheckoutProxyResult> {
    return this.execute(input, "POST", "CANCEL_CHECKOUT_SESSION", async (merchant, headers) =>
      this.deps.merchantClient.cancelCheckout(
        merchant,
        input.checkoutSessionId,
        headers,
        input.body,
      ),
    );
  }

  private async execute(
    input: RetrieveCheckoutLifecycleInput | MutatingCheckoutLifecycleInput,
    method: "GET" | "POST",
    operation: CheckoutLifecycleOperation,
    forward: (
      merchant: MerchantEndpoint,
      headers: MerchantRequestHeaders,
    ) => Promise<MerchantResponse>,
  ): Promise<CheckoutProxyResult> {
    this.assertApiVersion(input.security.apiVersion);
    const mandate = await this.authenticate(input, method);
    const merchant = await this.resolveMerchant(mandate.organizationId, input.merchantId);
    const decision = lifecycleAccessDecision(mandate, this.deps.generateId);
    const upstream = await forward(merchant, this.upstreamHeaders(input));

    await this.recordAudit({
      input,
      mandate,
      merchant,
      decision,
      operation,
      approvedPayload: upstream.body,
      upstreamStatus: upstream.status,
    });

    if (upstream.status < 200 || upstream.status >= 300) {
      throw new ProxyUpstreamError(
        `Merchant rejected ACP ${operation.toLowerCase()}`,
        upstream.status,
        upstream.body,
      );
    }

    return {
      decision,
      checkoutSessionId: input.checkoutSessionId,
      upstream,
    };
  }

  private async authenticate(
    input: RetrieveCheckoutLifecycleInput | MutatingCheckoutLifecycleInput,
    method: "GET" | "POST",
  ): Promise<AgentSpendMandate> {
    const verified = await this.deps.mandateTokens.verify(input.security.mandateToken, input.now);
    const mandate = await this.deps.mandates.getById(verified.claims.mandateId);
    if (!mandate) {
      throw new ProxyAuthenticationError("Mandate does not exist");
    }
    this.deps.mandateTokens.assertBoundToMandate(verified, mandate);

    await this.deps.agentRequests.verify({
      method,
      path: input.path,
      body: input.body,
      mandateTokenJtiHash: verified.tokenJtiHash,
      idempotencyKey: input.idempotencyKey,
      apiVersion: input.security.apiVersion,
      expectedAgentId: mandate.agentId,
      proof: input.security.agentProof,
      now: input.now,
    });

    return mandate;
  }

  private async resolveMerchant(
    organizationId: string,
    merchantId: string,
  ): Promise<MerchantEndpoint> {
    const merchant = await this.deps.merchants.getById(organizationId, merchantId);
    if (!merchant || !merchant.active) {
      throw new ProxyAuthenticationError("Merchant endpoint is not registered or active");
    }
    try {
      assertRegisteredHttpsTarget(merchant);
    } catch {
      throw new ProxyAuthenticationError("Merchant endpoint failed registered HTTPS validation");
    }
    return merchant;
  }

  private upstreamHeaders(
    input: RetrieveCheckoutLifecycleInput | MutatingCheckoutLifecycleInput,
  ): MerchantRequestHeaders {
    return {
      authorization: input.security.authorization,
      apiVersion: input.security.apiVersion,
      requestId: input.requestId,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    };
  }

  private assertApiVersion(version: string): void {
    if (version !== ACP_STABLE_VERSION) {
      throw new ProxyProtocolError(
        `Unsupported ACP API-Version ${version}; Mino MVP is pinned to ${ACP_STABLE_VERSION}`,
      );
    }
  }

  private async recordAudit(args: {
    readonly input: RetrieveCheckoutLifecycleInput | MutatingCheckoutLifecycleInput;
    readonly mandate: AgentSpendMandate;
    readonly merchant: MerchantEndpoint;
    readonly decision: PolicyDecision;
    readonly operation: CheckoutLifecycleOperation;
    readonly approvedPayload?: unknown;
    readonly upstreamStatus?: number;
  }): Promise<void> {
    const requestedPayload = redactSensitivePayload(args.input.body);
    await this.deps.audit.record({
      requestId: args.input.requestId,
      decisionId: args.decision.decisionId,
      organizationId: args.mandate.organizationId,
      userId: args.mandate.userId,
      agentId: args.mandate.agentId,
      mandateId: args.mandate.id,
      timestamp: args.input.now,
      protocol: "ACP",
      operation: args.operation,
      merchantDomain: args.merchant.domain,
      ...(args.merchant.vendorId ? { merchantVendorId: args.merchant.vendorId } : {}),
      requestedPayload,
      ...(args.approvedPayload !== undefined
        ? { approvedPayload: redactSensitivePayload(args.approvedPayload) }
        : {}),
      decision: args.decision,
      requestDigest: sha256Base64Url(
        canonicalJson({
          method: args.operation === "RETRIEVE_CHECKOUT_SESSION" ? "GET" : "POST",
          path: args.input.path,
          idempotencyKey: args.input.idempotencyKey,
          body: requestedPayload,
        }),
      ),
      ...(args.upstreamStatus !== undefined ? { upstreamStatus: args.upstreamStatus } : {}),
    });
  }
}

function lifecycleAccessDecision(
  mandate: AgentSpendMandate,
  generateId: () => string,
): PolicyDecision {
  const zero = { currency: mandate.currency, minorUnits: 0n };
  return {
    decisionId: generateId(),
    mandateId: mandate.id,
    policyVersion: mandate.policyVersion,
    verdict: DecisionVerdict.ALLOW,
    reasons: [],
    requestedAmount: zero,
    policyAmount: zero,
    approvedAmount: zero,
    eligibleForDelegationAssertion: false,
    evaluationStartedAtMicros: 0,
    evaluationFinishedAtMicros: 0,
  };
}
