import { canonicalJson, sha256Base64Url } from "../../infrastructure/crypto/canonical-json.js";
import type { FxQuote } from "../../domain/money.js";
import type { AgentSpendMandate } from "../../domain/mandates/mandate.types.js";
import type { CheckoutIntent } from "../../domain/checkout/checkout.types.js";
import { DecisionReason } from "../../domain/evaluation/decision-reasons.js";
import {
  DecisionVerdict,
  type PolicyDecision,
  type SpendState,
  type VelocityState,
} from "../../domain/evaluation/evaluation.types.js";
import type { PolicyEvaluator } from "../../domain/evaluation/policy-evaluator.interface.js";
import type { AgentRequestProof } from "../agents/agent-request-verifier.js";
import type { AgentRequestAuthenticator } from "../agents/agent-request-verifier.js";
import {
  ApprovalRequestStatus,
  approvalCoversDecision,
  blockApprovalDecision,
  grantApprovedDecision,
  type HumanApprovalService,
} from "../approvals/durable-approval.service.js";
import type { ApprovalRequestRecord } from "../approvals/approval-request.store.js";
import type { AuditSink } from "../audit/audit-sink.js";
import { redactSensitivePayload } from "../audit/audit-sink.js";
import type { MandateTokenService } from "../mandates/mandate-token.service.js";
import {
  BeginPaymentOutcomeKind,
  PaymentOutcomeStatus,
  type PaymentOutcomeRecord,
  type PaymentOutcomeStore,
  type StoredMerchantResponse,
} from "../payments/payment-outcome.store.js";
import {
  ReservationStatus,
  type AuthorizationReservations,
} from "../spending/authorization-reservation.service.js";
import {
  ACPAdapter,
  ACPProtocolError,
  ACP_STABLE_VERSION,
  parseCheckoutSession,
  type ACPCheckoutSession,
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
  readonly paymentOutcomes: PaymentOutcomeStore;
  readonly delegationAssertions: DelegationAssertionIssuer;
  readonly approvals: HumanApprovalService;
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
  readonly approvalRequestId?: string;
  readonly upstream?: MerchantResponse;
  readonly reservationId?: string;
  readonly paymentOutcomeId?: string;
  readonly replayed?: boolean;
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

export class PaymentOutcomePendingError extends Error {
  public constructor(
    public readonly outcomeId: string,
    public readonly upstreamStatus?: number,
  ) {
    super("Payment outcome is unresolved; retry with the same idempotency key to reconcile");
    this.name = "PaymentOutcomePendingError";
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

    let approvalRequestId: string | undefined;
    if (decision.verdict === DecisionVerdict.BLOCK) {
      await this.deps.merchantClient
        .cancelCheckout(merchant, session.id, headers)
        .catch(() => undefined);
    } else if (decision.verdict === DecisionVerdict.PENDING_HUMAN_APPROVAL) {
      const approval = await this.deps.approvals.requestApproval({
        decision,
        mandate: auth.mandate,
        merchantId: input.merchantId,
        merchantDomain: merchant.domain,
        checkoutSessionId: session.id,
        idempotencyKey: input.idempotencyKey,
        requestDigest: createCheckoutRequestDigest(input, intent),
        requestedPayload: input.body,
        sessionSnapshot: session,
        spend: zeroSpend(auth.mandate.currency),
        now: input.now,
      });
      approvalRequestId = approval.id;
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
      ...(approvalRequestId ? { approvalRequestId } : {}),
      upstream,
    };
  }

  public async completeCheckout(input: CompleteCheckoutProxyInput): Promise<CheckoutProxyResult> {
    this.assertApiVersion(input.security.apiVersion);
    const auth = await this.authenticate(input, "POST");
    const merchant = await this.resolveMerchant(auth.mandate.organizationId, input.merchantId);
    const headers = this.upstreamHeaders(input);

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
    const preflight = this.deps.evaluator.evaluate({
      now: input.now,
      mandate: auth.mandate,
      checkout: intent,
      spend: zeroSpend(auth.mandate.currency),
      velocity: zeroVelocity(auth.mandate.currency),
      ...(fxQuote ? { fxQuote } : {}),
    });

    if (preflight.verdict === DecisionVerdict.BLOCK || !preflight.policyAmount) {
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

    const requestDigest = completionRequestDigest(input, intent);
    const priorOutcome = await this.deps.paymentOutcomes.getByIdempotency(
      auth.mandate.organizationId,
      input.idempotencyKey,
    );
    if (priorOutcome) {
      if (priorOutcome.requestDigest !== requestDigest) {
        throw new IdempotencyConflictError();
      }
      return this.resolveExistingOutcome({
        outcome: priorOutcome,
        decision:
          preflight.verdict === DecisionVerdict.PENDING_HUMAN_APPROVAL
            ? grantApprovedDecision(preflight)
            : preflight,
        input,
        mandate: auth.mandate,
        merchant,
        session,
      });
    }

    const existingApproval = await this.deps.approvals.getByIdempotency(
      auth.mandate.organizationId,
      input.idempotencyKey,
      requestDigest,
      input.now,
    );
    const allowDailyLimitOverride =
      existingApproval?.status === ApprovalRequestStatus.APPROVED &&
      input.now < existingApproval.expiresAt &&
      existingApproval.reasonCodes.includes(DecisionReason.DAILY_LIMIT_EXCEEDED);

    const reservationId = this.deps.generateId();
    const reservation = await this.deps.reservations.tryReserve({
      mandate: auth.mandate,
      amount: preflight.approvedAmount ?? preflight.policyAmount,
      merchantDomain: merchant.domain,
      requestId: input.requestId,
      reservationId,
      idempotencyKey: input.idempotencyKey,
      requestDigest,
      now: input.now,
      ...(allowDailyLimitOverride ? { allowDailyLimitOverride: true } : {}),
    });

    if (reservation.status === ReservationStatus.IDEMPOTENCY_CONFLICT) {
      throw new IdempotencyConflictError();
    }

    const evaluatedFinalDecision = this.deps.evaluator.evaluate({
      now: input.now,
      mandate: auth.mandate,
      checkout: intent,
      spend: reservation.spend,
      velocity: reservation.velocity,
      ...(fxQuote ? { fxQuote } : {}),
    });

    const activeReservationId = reservation.reservationId;
    let finalDecision = evaluatedFinalDecision;
    let approvalRequestId = existingApproval?.id;

    if (evaluatedFinalDecision.verdict === DecisionVerdict.PENDING_HUMAN_APPROVAL) {
      try {
        const resolved = await this.resolvePendingApproval({
          decision: evaluatedFinalDecision,
          existingApproval,
          mandate: auth.mandate,
          merchant,
          input,
          session,
          requestDigest,
          spend: reservation.spend,
        });
        finalDecision = resolved.decision;
        approvalRequestId = resolved.approvalRequestId;
      } catch (error) {
        if (activeReservationId) {
          await this.deps.reservations.releaseForApproval(
            auth.mandate.id,
            activeReservationId,
            input.idempotencyKey,
          );
        }
        throw error;
      }
    }

    if (finalDecision.verdict !== DecisionVerdict.ALLOW) {
      if (activeReservationId) {
        if (finalDecision.verdict === DecisionVerdict.PENDING_HUMAN_APPROVAL) {
          await this.deps.reservations.releaseForApproval(
            auth.mandate.id,
            activeReservationId,
            input.idempotencyKey,
          );
        } else {
          await this.deps.reservations.release(auth.mandate.id, activeReservationId);
        }
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
        ...(approvalRequestId ? { approvalRequestId } : {}),
        ...(activeReservationId ? { reservationId: activeReservationId } : {}),
      };
    }

    if (!activeReservationId || !finalDecision.approvedAmount) {
      throw new Error("Authorization state is inconsistent: ALLOW without spend reservation");
    }

    const begun = await this.deps.paymentOutcomes.begin({
      id: this.deps.generateId(),
      organizationId: auth.mandate.organizationId,
      userId: auth.mandate.userId,
      agentId: auth.mandate.agentId,
      mandateId: auth.mandate.id,
      reservationId: activeReservationId,
      idempotencyKey: input.idempotencyKey,
      requestDigest,
      merchantId: input.merchantId,
      merchantDomain: merchant.domain,
      checkoutSessionId: input.checkoutSessionId,
      amountMinor: finalDecision.approvedAmount.minorUnits,
      currency: finalDecision.approvedAmount.currency,
      now: input.now,
    });

    if (begun.kind === BeginPaymentOutcomeKind.CONFLICT) {
      throw new IdempotencyConflictError();
    }
    if (begun.kind === BeginPaymentOutcomeKind.EXISTING) {
      return this.resolveExistingOutcome({
        outcome: begun.outcome,
        decision: finalDecision,
        input,
        mandate: auth.mandate,
        merchant,
        session,
      });
    }

    const held = await this.deps.reservations.holdForReconciliation(
      auth.mandate.id,
      activeReservationId,
      input.now,
    );
    if (!held) {
      throw new Error("Unable to protect forwarded payment with a reconciliation hold");
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
      await this.deps.paymentOutcomes.markUnknown(begun.outcome.id, {
        errorCode: "MERCHANT_TRANSPORT_FAILURE",
        now: input.now,
      });
      await this.recordAudit({
        input,
        mandate: auth.mandate,
        merchant,
        decision: finalDecision,
        approvedPayload: session,
        reservationId: activeReservationId,
      });
      throw new PaymentOutcomePendingError(begun.outcome.id);
    }

    const storedResponse = sanitizeMerchantResponse(upstream);

    if (upstream.status >= 200 && upstream.status < 300) {
      await this.deps.paymentOutcomes.markSucceeded(begun.outcome.id, storedResponse, input.now);
      const committed = await this.deps.reservations.commit(
        auth.mandate.id,
        activeReservationId,
        input.now,
      );
      if (!committed) {
        throw new Error("Merchant succeeded but spend reservation could not be committed");
      }
    } else if (isDefinitiveMerchantFailure(upstream.status)) {
      await this.deps.paymentOutcomes.markDefinitiveFailure(
        begun.outcome.id,
        storedResponse,
        input.now,
      );
      await this.deps.reservations.release(auth.mandate.id, activeReservationId);
    } else {
      await this.deps.paymentOutcomes.markUnknown(begun.outcome.id, {
        upstreamStatus: upstream.status,
        errorCode: ambiguousOutcomeCode(upstream.status),
        now: input.now,
      });
      await this.recordAudit({
        input,
        mandate: auth.mandate,
        merchant,
        decision: finalDecision,
        approvedPayload: session,
        reservationId: activeReservationId,
        upstreamStatus: upstream.status,
      });
      throw new PaymentOutcomePendingError(begun.outcome.id, upstream.status);
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
      ...(approvalRequestId ? { approvalRequestId } : {}),
      upstream,
      reservationId: activeReservationId,
      paymentOutcomeId: begun.outcome.id,
    };
  }

  private async resolvePendingApproval(args: {
    readonly decision: PolicyDecision;
    readonly existingApproval?: ApprovalRequestRecord;
    readonly mandate: AgentSpendMandate;
    readonly merchant: MerchantEndpoint;
    readonly input: CompleteCheckoutProxyInput;
    readonly session: ACPCheckoutSession;
    readonly requestDigest: string;
    readonly spend: SpendState;
  }): Promise<{ readonly decision: PolicyDecision; readonly approvalRequestId: string }> {
    const { decision, mandate, merchant, input, session, requestDigest, spend } = args;
    const existing = args.existingApproval;

    if (existing) {
      if (existing.status === ApprovalRequestStatus.REJECTED) {
        return {
          decision: blockApprovalDecision(decision, DecisionReason.HUMAN_APPROVAL_REJECTED),
          approvalRequestId: existing.id,
        };
      }
      if (existing.status === ApprovalRequestStatus.EXPIRED || input.now >= existing.expiresAt) {
        return {
          decision: blockApprovalDecision(decision, DecisionReason.HUMAN_APPROVAL_EXPIRED),
          approvalRequestId: existing.id,
        };
      }
      if (existing.status === ApprovalRequestStatus.APPROVED) {
        return {
          decision: approvalCoversDecision(existing, decision, spend)
            ? grantApprovedDecision(decision)
            : blockApprovalDecision(decision, DecisionReason.HUMAN_APPROVAL_STALE),
          approvalRequestId: existing.id,
        };
      }
    }

    const request = await this.deps.approvals.requestApproval({
      decision,
      mandate,
      merchantId: input.merchantId,
      merchantDomain: merchant.domain,
      checkoutSessionId: input.checkoutSessionId,
      idempotencyKey: input.idempotencyKey,
      requestDigest,
      requestedPayload: input.body,
      sessionSnapshot: session,
      spend,
      now: input.now,
    });
    return { decision, approvalRequestId: request.id };
  }

  private async resolveExistingOutcome(args: {
    readonly outcome: PaymentOutcomeRecord;
    readonly decision: PolicyDecision;
    readonly input: CompleteCheckoutProxyInput;
    readonly mandate: AgentSpendMandate;
    readonly merchant: MerchantEndpoint;
    readonly session: ACPCheckoutSession;
  }): Promise<CheckoutProxyResult> {
    const { outcome, decision, input, mandate, merchant, session } = args;

    if (outcome.status === PaymentOutcomeStatus.SUCCEEDED) {
      if (!outcome.response) {
        throw new Error("Succeeded payment outcome is missing its stored response");
      }
      const committed = await this.deps.reservations.commit(
        mandate.id,
        outcome.reservationId,
        input.now,
      );
      if (!committed) {
        throw new Error("Succeeded payment outcome could not restore committed spend state");
      }
      return replayResult(decision, input.checkoutSessionId, outcome);
    }

    if (outcome.status === PaymentOutcomeStatus.FAILED_DEFINITIVE) {
      if (!outcome.response) {
        throw new Error("Failed payment outcome is missing its stored response");
      }
      await this.deps.reservations.release(mandate.id, outcome.reservationId);
      return replayResult(decision, input.checkoutSessionId, outcome);
    }

    const status = session.status.trim().toLowerCase();
    if (status === "completed") {
      const reconciledResponse: StoredMerchantResponse = {
        status: 200,
        body: redactSensitivePayload(session),
        headers: { "idempotent-replayed": "true" },
      };
      await this.deps.paymentOutcomes.markSucceeded(outcome.id, reconciledResponse, input.now);
      const committed = await this.deps.reservations.commit(
        mandate.id,
        outcome.reservationId,
        input.now,
      );
      if (!committed) {
        throw new Error("Reconciled merchant success could not commit spend state");
      }
      await this.deps.paymentOutcomes.markReconciled(outcome.id, input.now);
      await this.recordAudit({
        input,
        mandate,
        merchant,
        decision,
        approvedPayload: session,
        reservationId: outcome.reservationId,
        upstreamStatus: 200,
      });
      return {
        decision,
        checkoutSessionId: input.checkoutSessionId,
        upstream: reconciledResponse,
        reservationId: outcome.reservationId,
        paymentOutcomeId: outcome.id,
        replayed: true,
      };
    }

    if (status === "canceled" || status === "cancelled") {
      const reconciledResponse: StoredMerchantResponse = {
        status: 409,
        body: redactSensitivePayload(session),
        headers: { "idempotent-replayed": "true" },
      };
      await this.deps.paymentOutcomes.markDefinitiveFailure(
        outcome.id,
        reconciledResponse,
        input.now,
      );
      await this.deps.reservations.release(mandate.id, outcome.reservationId);
      await this.deps.paymentOutcomes.markReconciled(outcome.id, input.now);
      return {
        decision,
        checkoutSessionId: input.checkoutSessionId,
        upstream: reconciledResponse,
        reservationId: outcome.reservationId,
        paymentOutcomeId: outcome.id,
        replayed: true,
      };
    }

    const held = await this.deps.reservations.holdForReconciliation(
      mandate.id,
      outcome.reservationId,
      input.now,
    );
    if (!held) {
      throw new Error("Unresolved payment outcome lost its reconciliation reservation");
    }
    await this.deps.paymentOutcomes.markReconciled(outcome.id, input.now);
    throw new PaymentOutcomePendingError(outcome.id, outcome.upstreamStatus);
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

function completionRequestDigest(input: CompleteCheckoutProxyInput, intent: CheckoutIntent): string {
  return sha256Base64Url(
    canonicalJson({
      merchantId: input.merchantId,
      checkoutSessionId: input.checkoutSessionId,
      requestBodyDigest: sha256Base64Url(canonicalJson(input.body)),
      authorizationState: {
        merchant: intent.merchant,
        currency: intent.total.currency,
        totalMinor: intent.total.minorUnits,
        cart: intent.cart.map((line) => ({
          lineId: line.lineId,
          productId: line.productId,
          sku: line.sku,
          category: line.category,
          quantity: line.quantity,
          unitPriceMinor: line.unitPrice.minorUnits,
          totalPriceMinor: line.totalPrice.minorUnits,
        })),
      },
    }),
  );
}

function createCheckoutRequestDigest(input: CreateCheckoutProxyInput, intent: CheckoutIntent): string {
  return sha256Base64Url(
    canonicalJson({
      merchantId: input.merchantId,
      operation: "CREATE_CHECKOUT_SESSION",
      requestBodyDigest: sha256Base64Url(canonicalJson(input.body)),
      authorizationState: {
        merchant: intent.merchant,
        currency: intent.total.currency,
        totalMinor: intent.total.minorUnits,
        cart: intent.cart.map((line) => ({
          lineId: line.lineId,
          productId: line.productId,
          sku: line.sku,
          category: line.category,
          quantity: line.quantity,
          unitPriceMinor: line.unitPrice.minorUnits,
          totalPriceMinor: line.totalPrice.minorUnits,
        })),
      },
    }),
  );
}

function sanitizeMerchantResponse(response: MerchantResponse): StoredMerchantResponse {
  return {
    status: response.status,
    body: redactSensitivePayload(response.body),
    ...(response.headers ? { headers: response.headers } : {}),
  };
}

function isDefinitiveMerchantFailure(status: number): boolean {
  return status >= 400 && status < 500 && status !== 409 && status !== 422;
}

function ambiguousOutcomeCode(status: number): string {
  if (status === 409) {
    return "MERCHANT_IDEMPOTENCY_IN_FLIGHT";
  }
  if (status === 422) {
    return "MERCHANT_IDEMPOTENCY_CONFLICT";
  }
  if (status >= 500) {
    return "MERCHANT_SERVER_ERROR_AFTER_DISPATCH";
  }
  return "MERCHANT_NONDEFINITIVE_RESPONSE";
}

function replayResult(
  decision: PolicyDecision,
  checkoutSessionId: string,
  outcome: PaymentOutcomeRecord,
): CheckoutProxyResult {
  if (!outcome.response) {
    throw new Error("Terminal payment outcome is missing a replayable merchant response");
  }
  return {
    decision,
    checkoutSessionId,
    upstream: outcome.response,
    reservationId: outcome.reservationId,
    paymentOutcomeId: outcome.id,
    replayed: true,
  };
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
