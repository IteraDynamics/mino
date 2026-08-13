import { canonicalJson, sha256Base64Url } from "../../infrastructure/crypto/canonical-json.js";
import type { FxQuote } from "../../domain/money.js";
import type { AgentSpendMandate } from "../../domain/mandates/mandate.types.js";
import {
  DecisionVerdict,
  type PolicyDecision,
  type SpendState,
  type VelocityState,
} from "../../domain/evaluation/evaluation.types.js";
import type { PolicyEvaluator } from "../../domain/evaluation/policy-evaluator.interface.js";
import type { AgentRequestProof } from "../agents/agent-request-verifier.js";
import type { AgentRequestAuthenticator } from "../agents/agent-request-verifier.js";
import type { HumanApprovalEmitter } from "../approvals/approval-emitter.js";
import type { AuditSink } from "../audit/audit-sink.js";
import { redactSensitivePayload } from "../audit/audit-sink.js";
import type { MandateTokenService } from "../mandates/mandate-token.service.js";
import {
  ReservationStatus,
  type AuthorizationReservations,
} from "../spending/authorization-reservation.service.js";
import {
  ACPAdapter,
  ACPProtocolError,
  ACP_STABLE_VERSION,
  parseCheckoutSession,
} from "./acp-adapter.js";
import type {
  ACPMerchantClient,
  MerchantEndpoint,
  MerchantRegistry,
  MerchantResponse,
} from "./merchant-client.js";
import type { DelegationAssertionIssuer } from "./delegation-assertion.service.js";

export interface MandateRepository {
  getById(mandateId: string): Promise<AgentSpendMandate | undefined>;
}

export interface FxQuoteProvider {
  getQuote(from: string, to: string, now: Date): Promise<FxQuote | undefined>;
}

export interface CheckoutProxyServiceDependencies {
  readonly mandateTokens: MandateTokenService;
  readonly mandates: MandateRepository;
  readonly agentRequests: AgentRequestAuthenticator;
  readonly merchants: MerchantRegistry;
  readonly merchantClient: ACPMerchantClient;
  readonly adapter: ACPAdapter;
  readonly evaluator: PolicyEvaluator;
  readonly reservations: AuthorizationReservations;
  readonly delegationAssertions: DelegationAssertionIssuer;
  readonly approvals: HumanApprovalEmitter;
  readonly audit: AuditSink;
  readonly fxQuotes?: FxQuoteProvider;
  readonly generateId: () => string;
}

export interface ProxySecurityContext {
  readonly mandateToken: string;
  readonly agentProof: AgentRequestProof;
  readonly authorization: string;
  readonly apiVersion: string;
}

interface BaseProxyInput {
  readonly merchantId: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly path: string;
  readonly body: unknown;
  readonly security: ProxySecurityContext;
  readonly now: Date;
}

export interface CreateCheckoutProxyInput extends BaseProxyInput {}

export interface CompleteCheckoutProxyInput extends BaseProxyInput {
  readonly checkoutSessionId: string;
}

export interface CheckoutProxyResult {
  readonly decision: PolicyDecision;
  readonly checkoutSessionId?: string;
  readonly upstream?: MerchantResponse;
  readonly reservationId?: string;
}

export class ProxyAuthenticationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProxyAuthenticationError";
  }
}

export class ProxyProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProxyProtocolError";
  }
}

export class ProxyUpstreamError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly upstreamBody?: unknown,
  ) {
    super(message);
    this.name = "ProxyUpstreamError";
  }
}

export class IdempotencyConflictError extends Error {
  public constructor() {
    super("Idempotency key was reused for a different request");
    this.name = "IdempotencyConflictError";
  }
}

export class CheckoutProxyService {
  public constructor(private readonly deps: CheckoutProxyServiceDependencies) {}

  public async createCheckout(input: CreateCheckoutProxyInput): Promise<CheckoutProxyResult> {
    this.assertApiVersion(input.security.apiVersion);
    const auth = await this.authenticate(input, "POST");
    const merchant = await this.resolveMerchant(auth.mandate.organizationId, input.merchantId);
    const headers = this.upstreamHeaders(input);

    const upstream = await this.deps.merchantClient.createCheckout(
      merchant,
      input.body,
      headers,
    );
    if (upstream.status < 200 || upstream.status >= 300) {
      throw new ProxyUpstreamError(
        "Merchant rejected ACP checkout creation",
        upstream.status,
        upstream.body,
      );
    }

    const session = this.parseMerchantSession(upstream.body, upstream.status);
    const intent = this.deps.adapter.normalizeCheckoutSession({
      session,
      requestId: input.requestId,
      operation: "CREATE_CHECKOUT_SESSION",
      organizationId: auth.mandate.organizationId,
      userId: auth.mandate.userId,
      agentId: auth.mandate.agentId,
      merchant: {
        domain: merchant.domain,
        ...(merchant.vendorId ? { vendorId: merchant.vendorId } : {}),
      },
      idempotencyKey: input.idempotencyKey,
    });

    const fxQuote = await this.resolveFxQuote(intent.total.currency, auth.mandate.currency, input.now);
    const decision = this.deps.evaluator.evaluate({
      now: input.now,
      mandate: auth.mandate,
      checkout: intent,
      spend: zeroSpend(auth.mandate.currency),
      velocity: zeroVelocity(auth.mandate.currency),
      ...(fxQuote ? { fxQuote } : {}),
    });

    if (decision.verdict === DecisionVerdict.BLOCK) {
      // Best-effort cleanup only. Failure to cancel must not turn the blocked decision into allow.
      await this.deps.merchantClient
        .cancelCheckout(merchant, session.id, headers)
        .catch(() => undefined);
    } else if (decision.verdict === DecisionVerdict.PENDING_HUMAN_APPROVAL) {
      await this.emitApproval(decision, auth.mandate, merchant, session.id, input.now);
    }

    await this.recordAudit({
      input,
      mandate: auth.mandate,
      merchant,
      decision,
      approvedPayload: session,
      upstreamStatus: upstream.status,
    });

    return {
      decision,
      checkoutSessionId: session.id,
      upstream,
    };
  }

  public async completeCheckout(input: CompleteCheckoutProxyInput): Promise<CheckoutProxyResult> {
    this.assertApiVersion(input.security.apiVersion);
    const auth = await this.authenticate(input, "POST");
    const merchant = await this.resolveMerchant(auth.mandate.organizationId, input.merchantId);
    const headers = this.upstreamHeaders(input);

    // ACP merchant state is authoritative. Agent-provided prices are never used for authorization.
    const current = await this.deps.merchantClient.getCheckout(
      merchant,
      input.checkoutSessionId,
      headers,
    );
    if (current.status < 200 || current.status >= 300) {
      throw new ProxyUpstreamError(
        "Unable to retrieve authoritative ACP checkout state",
        current.status,
        current.body,
      );
    }

    const session = this.parseMerchantSession(current.body, current.status);
    const intent = this.deps.adapter.normalizeCheckoutSession({
      session,
      requestId: input.requestId,
      operation: "COMPLETE_CHECKOUT",
      organizationId: auth.mandate.organizationId,
      userId: auth.mandate.userId,
      agentId: auth.mandate.agentId,
      merchant: {
        domain: merchant.domain,
        ...(merchant.vendorId ? { vendorId: merchant.vendorId } : {}),
      },
      idempotencyKey: input.idempotencyKey,
    });

    const fxQuote = await this.resolveFxQuote(intent.total.currency, auth.mandate.currency, input.now);

    // First pass performs all static/integrity checks and computes the normalized policy amount.
    const preflight = this.deps.evaluator.evaluate({
      now: input.now,
      mandate: auth.mandate,
      checkout: intent,
      spend: zeroSpend(auth.mandate.currency),
      velocity: zeroVelocity(auth.mandate.currency),
      ...(fxQuote ? { fxQuote } : {}),
    });

    if (preflight.verdict !== DecisionVerdict.ALLOW || !preflight.approvedAmount) {
      if (preflight.verdict === DecisionVerdict.PENDING_HUMAN_APPROVAL) {
        await this.emitApproval(
          preflight,
          auth.mandate,
          merchant,
          input.checkoutSessionId,
          input.now,
        );
      }
      await this.recordAudit({
        input,
        mandate: auth.mandate,
        merchant,
        decision: preflight,
        approvedPayload: session,
        upstreamStatus: current.status,
      });
      return {
        decision: preflight,
        checkoutSessionId: input.checkoutSessionId,
      };
    }

    const reservationId = this.deps.generateId();
    const requestDigest = sha256Base64Url(
      canonicalJson({
        merchantId: input.merchantId,
        checkoutSessionId: input.checkoutSessionId,
        request: redactSensitivePayload(input.body),
        authoritativeCheckout: session,
      }),
    );

    const reservation = await this.deps.reservations.tryReserve({
      mandate: auth.mandate,
      amount: preflight.approvedAmount,
      merchantDomain: merchant.domain,
      requestId: input.requestId,
      reservationId,
      idempotencyKey: input.idempotencyKey,
      requestDigest,
      now: input.now,
    });

    if (reservation.status === ReservationStatus.IDEMPOTENCY_CONFLICT) {
      throw new IdempotencyConflictError();
    }

    const finalDecision = this.deps.evaluator.evaluate({
      now: input.now,
      mandate: auth.mandate,
      checkout: intent,
      spend: reservation.spend,
      velocity: reservation.velocity,
      ...(fxQuote ? { fxQuote } : {}),
    });

    const activeReservationId = reservation.reservationId;

    if (finalDecision.verdict !== DecisionVerdict.ALLOW) {
      if (activeReservationId) {
        await this.deps.reservations.release(auth.mandate.id, activeReservationId);
      }
      if (finalDecision.verdict === DecisionVerdict.PENDING_HUMAN_APPROVAL) {
        await this.emitApproval(
          finalDecision,
          auth.mandate,
          merchant,
          input.checkoutSessionId,
          input.now,
        );
      }
      await this.recordAudit({
        input,
        mandate: auth.mandate,
        merchant,
        decision: finalDecision,
        approvedPayload: session,
        ...(activeReservationId ? { reservationId: activeReservationId } : {}),
      });
      return {
        decision: finalDecision,
        checkoutSessionId: input.checkoutSessionId,
        ...(activeReservationId ? { reservationId: activeReservationId } : {}),
      };
    }

    if (!activeReservationId) {
      // If Redis says the operation was dynamically allowed but no reservation exists, fail closed.
      throw new Error("Authorization state is inconsistent: ALLOW without spend reservation");
    }

    const delegationAssertion = this.deps.delegationAssertions.issue(
      intent,
      finalDecision,
      input.now,
    );

    let upstream: MerchantResponse;
    try {
      upstream = await this.deps.merchantClient.completeCheckout(
        merchant,
        input.checkoutSessionId,
        input.body,
        {
          ...headers,
          delegationAssertion,
        },
      );
    } catch (error) {
      await this.deps.reservations.release(auth.mandate.id, activeReservationId);
      throw error;
    }

    if (upstream.status >= 200 && upstream.status < 300) {
      await this.deps.reservations.commit(auth.mandate.id, activeReservationId, input.now);
    } else {
      await this.deps.reservations.release(auth.mandate.id, activeReservationId);
    }

    await this.recordAudit({
      input,
      mandate: auth.mandate,
      merchant,
      decision: finalDecision,
      approvedPayload: session,
      reservationId: activeReservationId,
      upstreamStatus: upstream.status,
    });

    return {
      decision: finalDecision,
      checkoutSessionId: input.checkoutSessionId,
      upstream,
      reservationId: activeReservationId,
    };
  }

  private async authenticate(
    input: BaseProxyInput,
    method: string,
  ): Promise<{ readonly mandate: AgentSpendMandate }> {
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

    return { mandate };
  }

  private async resolveMerchant(
    organizationId: string,
    merchantId: string,
  ): Promise<MerchantEndpoint> {
    const merchant = await this.deps.merchants.getById(organizationId, merchantId);
    if (!merchant || !merchant.active) {
      throw new ProxyAuthenticationError("Merchant endpoint is not registered or active");
    }
    return merchant;
  }

  private async resolveFxQuote(from: string, to: string, now: Date): Promise<FxQuote | undefined> {
    if (from.trim().toUpperCase() === to.trim().toUpperCase()) {
      return undefined;
    }
    return this.deps.fxQuotes?.getQuote(from, to, now);
  }

  private upstreamHeaders(input: BaseProxyInput) {
    return {
      authorization: input.security.authorization,
      apiVersion: input.security.apiVersion,
      idempotencyKey: input.idempotencyKey,
      requestId: input.requestId,
    };
  }

  private assertApiVersion(version: string): void {
    if (version !== ACP_STABLE_VERSION) {
      throw new ProxyProtocolError(
        `Unsupported ACP API-Version ${version}; Mino MVP is pinned to ${ACP_STABLE_VERSION}`,
      );
    }
  }

  private parseMerchantSession(body: unknown, status: number) {
    try {
      return parseCheckoutSession(body);
    } catch (error) {
      if (error instanceof ACPProtocolError) {
        throw new ProxyUpstreamError(
          "Merchant returned an invalid ACP CheckoutSession",
          status,
        );
      }
      throw error;
    }
  }

  private async emitApproval(
    decision: PolicyDecision,
    mandate: AgentSpendMandate,
    merchant: MerchantEndpoint,
    checkoutSessionId: string,
    now: Date,
  ): Promise<void> {
    if (!decision.approval || !decision.policyAmount) {
      throw new Error("Pending approval decision is missing approval metadata");
    }
    await this.deps.approvals.emit({
      eventId: this.deps.generateId(),
      type: "mino.approval.required",
      createdAt: now.toISOString(),
      decisionId: decision.decisionId,
      requestId: decision.requestId,
      organizationId: mandate.organizationId,
      userId: mandate.userId,
      agentId: mandate.agentId,
      mandateId: mandate.id,
      merchantDomain: merchant.domain,
      checkoutSessionId,
      amountMinor: decision.policyAmount.minorUnits.toString(10),
      currency: decision.policyAmount.currency,
      approvalMode: decision.approval.approvalMode,
      expiresAt: decision.approval.expiresAt.toISOString(),
    });
  }

  private async recordAudit(args: {
    readonly input: BaseProxyInput;
    readonly mandate: AgentSpendMandate;
    readonly merchant: MerchantEndpoint;
    readonly decision: PolicyDecision;
    readonly approvedPayload?: unknown;
    readonly reservationId?: string;
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
      operation:
        "checkoutSessionId" in args.input
          ? "COMPLETE_CHECKOUT"
          : "CREATE_CHECKOUT_SESSION",
      merchantDomain: args.merchant.domain,
      ...(args.merchant.vendorId ? { merchantVendorId: args.merchant.vendorId } : {}),
      requestedPayload,
      ...(args.approvedPayload !== undefined
        ? { approvedPayload: redactSensitivePayload(args.approvedPayload) }
        : {}),
      decision: args.decision,
      requestDigest: sha256Base64Url(canonicalJson(requestedPayload)),
      ...(args.reservationId ? { reservationId: args.reservationId } : {}),
      ...(args.upstreamStatus !== undefined ? { upstreamStatus: args.upstreamStatus } : {}),
    });
  }
}

function zeroSpend(currency: string): SpendState {
  return {
    committedDailySpend: { currency, minorUnits: 0n },
    reservedDailySpend: { currency, minorUnits: 0n },
  };
}

function zeroVelocity(currency: string): VelocityState {
  return {
    transactionsLastMinute: 0,
    distinctMerchantsInWindow: 0,
    attemptedAmountLastMinute: { currency, minorUnits: 0n },
    merchantDomainsInWindow: [],
  };
}
