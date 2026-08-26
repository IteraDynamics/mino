import type { AuthorizationDecision } from "../../domain/economic/authorization-decision.js";
import type { AgentSpendMandate } from "../../domain/mandates/mandate.types.js";
import { DecisionReason } from "../../domain/evaluation/decision-reasons.js";
import {
  DecisionVerdict,
  type PolicyDecision,
  type SpendState,
  type VelocityState,
} from "../../domain/evaluation/evaluation.types.js";
import type { PolicyEvaluator } from "../../domain/evaluation/policy-evaluator.interface.js";
import type { AgentRequestAuthenticator, AgentRequestProof } from "../agents/agent-request-verifier.js";
import {
  ApprovalRequestStatus,
  approvalCoversDecision,
  blockApprovalDecision,
  grantApprovedDecision,
  type HumanApprovalService,
} from "../approvals/durable-approval.service.js";
import type { ApprovalRequestRecord } from "../approvals/approval-request.store.js";
import type { AuditSink } from "../audit/audit-sink.js";
import type { AuthorizationGrantIssuer } from "../authorization/authorization-grant.service.js";
import type { EconomicProviderCredentialProvider } from "../execution/economic-reconciliation-adapter.js";
import type { MandateTokenService } from "../mandates/mandate-token.service.js";
import {
  BeginPaymentOutcomeKind,
  PaymentOutcomeStatus,
  type PaymentOutcomeRecord,
  type PaymentOutcomeStore,
  type StoredMerchantResponse,
} from "../payments/payment-outcome.store.js";
import {
  IdempotencyConflictError,
  PaymentOutcomePendingError,
  ProxyAuthenticationError,
  type MandateRepository,
} from "../proxy/checkout-proxy.service.js";
import {
  normalizeStripeAuthoritativeIntent,
  stripeExecutionRequestDigest,
  type StripeExecutionTarget,
} from "../providers/stripe/stripe-authoritative-intent.js";
import { StripeExecutionAdapter } from "../providers/stripe/stripe-execution-adapter.js";
import {
  parseStripePaymentIntent,
  stripeEvidence,
  StripeProtocolError,
} from "../providers/stripe/stripe-payment-intent.js";
import type {
  StripePaymentIntentClient,
  StripeProviderResponse,
} from "../providers/stripe/stripe-payment-intent-client.js";
import { StripeReconciliationAdapter } from "../providers/stripe/stripe-reconciliation-adapter.js";
import {
  ReservationStatus,
  type AuthorizationReservations,
} from "../spending/authorization-reservation.service.js";

export const PERSONAL_STRIPE_API_VERSION = "2026-08-26";

export interface PersonalStripeExecutionSecurity {
  readonly mandateToken: string;
  readonly agentProof: AgentRequestProof;
  readonly apiVersion: string;
}

export interface PersonalStripeConfirmInput {
  readonly paymentIntentId: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly path: string;
  readonly body: unknown;
  readonly security: PersonalStripeExecutionSecurity;
  readonly now: Date;
}

export interface PersonalStripeExecutionResult {
  readonly decision?: PolicyDecision;
  readonly paymentIntentId: string;
  readonly approvalRequestId?: string;
  readonly reservationId?: string;
  readonly paymentOutcomeId?: string;
  readonly upstream?: StoredMerchantResponse;
  readonly replayed?: boolean;
}

export interface PersonalStripeExecutionDependencies {
  readonly mandateTokens: Pick<MandateTokenService, "verify" | "assertBoundToMandate">;
  readonly mandates: MandateRepository;
  readonly agentRequests: AgentRequestAuthenticator;
  readonly evaluator: PolicyEvaluator;
  readonly reservations: AuthorizationReservations;
  readonly paymentOutcomes: PaymentOutcomeStore;
  readonly approvals: HumanApprovalService;
  readonly audit: AuditSink;
  readonly grants: AuthorizationGrantIssuer;
  readonly stripeClient: StripePaymentIntentClient;
  readonly stripeTarget: StripeExecutionTarget;
  readonly credentials: EconomicProviderCredentialProvider;
  readonly generateId: () => string;
}

export class PersonalStripeProviderError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PersonalStripeProviderError";
  }
}

/**
 * User #1 real-provider execution boundary.
 *
 * The agent supplies only a known Stripe PaymentIntent reference plus its Mino
 * authorization proof. The Stripe credential and target are server-side. Mino
 * retrieves authoritative provider state, derives EconomicIntent, evaluates policy,
 * binds owner approval and a short-lived ExecutionGrant to that exact intent, then
 * performs one final authoritative preflight before durable outcome/audit creation
 * and economic dispatch.
 */
export class PersonalStripeExecutionService {
  private readonly execution: StripeExecutionAdapter;
  private readonly reconciliation: StripeReconciliationAdapter;

  public constructor(private readonly deps: PersonalStripeExecutionDependencies) {
    this.execution = new StripeExecutionAdapter(deps.stripeClient);
    this.reconciliation = new StripeReconciliationAdapter({
      targets: {
        getById: async (organizationId, providerTargetId) =>
          organizationId === deps.stripeTarget.organizationId &&
          providerTargetId === deps.stripeTarget.id
            ? deps.stripeTarget
            : undefined,
      },
      client: deps.stripeClient,
      credentials: deps.credentials,
    });
  }

  public async confirmPaymentIntent(
    input: PersonalStripeConfirmInput,
  ): Promise<PersonalStripeExecutionResult> {
    this.assertApiVersion(input.security.apiVersion);
    const auth = await this.authenticate(input);
    const target = this.resolveTarget(auth.mandate);
    const authorization = await this.resolveCredential(auth.mandate.organizationId, target.id);
    const requestDigest = stripeExecutionRequestDigest(target.id, input.paymentIntentId);

    const priorOutcome = await this.deps.paymentOutcomes.getByIdempotency(
      auth.mandate.organizationId,
      input.idempotencyKey,
    );
    if (priorOutcome) {
      if (priorOutcome.requestDigest !== requestDigest) {
        throw new IdempotencyConflictError();
      }
      return this.resolveExistingOutcome(priorOutcome, input, auth.mandate);
    }

    const authoritative = await this.retrieveAuthoritativePaymentIntent(
      authorization,
      target,
      input.paymentIntentId,
    );
    const intent = normalizeStripeAuthoritativeIntent({
      paymentIntent: authoritative,
      target,
      requestId: input.requestId,
      userId: auth.mandate.userId,
      agentId: auth.mandate.agentId,
      idempotencyKey: input.idempotencyKey,
    });

    const preflight = this.deps.evaluator.evaluate({
      now: input.now,
      mandate: auth.mandate,
      checkout: intent,
      spend: zeroSpend(auth.mandate.currency),
      velocity: zeroVelocity(auth.mandate.currency),
    });

    if (preflight.verdict === DecisionVerdict.BLOCK || !preflight.policyAmount) {
      await this.recordAudit(input, auth.mandate, target, preflight, intent.rawPayload, requestDigest);
      return { decision: preflight, paymentIntentId: input.paymentIntentId };
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

    const reservationAttempt = await this.deps.reservations.tryReserve({
      mandate: auth.mandate,
      amount: preflight.approvedAmount ?? preflight.policyAmount,
      merchantDomain: target.domain,
      requestId: input.requestId,
      reservationId: this.deps.generateId(),
      idempotencyKey: input.idempotencyKey,
      requestDigest,
      now: input.now,
      ...(allowDailyLimitOverride ? { allowDailyLimitOverride: true } : {}),
    });
    if (reservationAttempt.status === ReservationStatus.IDEMPOTENCY_CONFLICT) {
      throw new IdempotencyConflictError();
    }

    let finalDecision = this.deps.evaluator.evaluate({
      now: input.now,
      mandate: auth.mandate,
      checkout: intent,
      spend: reservationAttempt.spend,
      velocity: reservationAttempt.velocity,
    });
    let approvalRequestId = existingApproval?.id;
    const reservationId = reservationAttempt.reservationId;

    if (finalDecision.verdict === DecisionVerdict.PENDING_HUMAN_APPROVAL) {
      const resolved = await this.resolvePendingApproval({
        decision: finalDecision,
        existingApproval,
        mandate: auth.mandate,
        target,
        input,
        intentSnapshot: intent.rawPayload,
        requestDigest,
        spend: reservationAttempt.spend,
      });
      finalDecision = resolved.decision;
      approvalRequestId = resolved.approvalRequestId;
    }

    if (finalDecision.verdict !== DecisionVerdict.ALLOW) {
      if (reservationId) {
        if (finalDecision.verdict === DecisionVerdict.PENDING_HUMAN_APPROVAL) {
          await this.deps.reservations.releaseForApproval(
            auth.mandate.id,
            reservationId,
            input.idempotencyKey,
          );
        } else {
          await this.deps.reservations.release(auth.mandate.id, reservationId);
        }
      }
      await this.recordAudit(
        input,
        auth.mandate,
        target,
        finalDecision,
        intent.rawPayload,
        requestDigest,
        reservationId,
      );
      return {
        decision: finalDecision,
        paymentIntentId: input.paymentIntentId,
        ...(approvalRequestId ? { approvalRequestId } : {}),
        ...(reservationId ? { reservationId } : {}),
      };
    }

    if (!reservationId || !finalDecision.approvedAmount || !finalDecision.intentDigest) {
      throw new Error("Stripe authorization state is inconsistent: ALLOW without bound reservation");
    }
    const boundDecision = finalDecision as AuthorizationDecision;
    const grant = this.deps.grants.issue(intent, boundDecision, input.now);

    // Final provider-authoritative re-fetch/rebind happens before any durable
    // PaymentOutcome is created, so a stale intent cannot leave a forwarding record.
    let prepared;
    try {
      prepared = await this.execution.prepare({
        intent,
        decision: boundDecision,
        grant,
        now: input.now,
        context: {
          authorization,
          target,
          paymentIntentId: input.paymentIntentId,
        },
      });
    } catch (error) {
      await this.deps.reservations.release(auth.mandate.id, reservationId);
      await this.recordAudit(
        input,
        auth.mandate,
        target,
        finalDecision,
        intent.rawPayload,
        requestDigest,
        reservationId,
      );
      throw error;
    }

    const begun = await this.deps.paymentOutcomes.begin({
      id: this.deps.generateId(),
      organizationId: auth.mandate.organizationId,
      userId: auth.mandate.userId,
      agentId: auth.mandate.agentId,
      mandateId: auth.mandate.id,
      reservationId,
      idempotencyKey: input.idempotencyKey,
      requestDigest,
      merchantId: target.id,
      merchantDomain: target.domain,
      checkoutSessionId: input.paymentIntentId,
      amountMinor: finalDecision.approvedAmount.minorUnits,
      currency: finalDecision.approvedAmount.currency,
      now: input.now,
    });
    if (begun.kind === BeginPaymentOutcomeKind.CONFLICT) {
      throw new IdempotencyConflictError();
    }
    if (begun.kind === BeginPaymentOutcomeKind.EXISTING) {
      return this.resolveExistingOutcome(begun.outcome, input, auth.mandate);
    }

    const held = await this.deps.reservations.holdForReconciliation(
      auth.mandate.id,
      reservationId,
      input.now,
    );
    if (!held) {
      await this.deps.paymentOutcomes.markUnknown(begun.outcome.id, {
        errorCode: "STRIPE_RECONCILIATION_HOLD_MISSING",
        now: input.now,
      });
      throw new PaymentOutcomePendingError(begun.outcome.id);
    }

    // This is the durable pre-execution ALLOW evidence later joined into the receipt.
    await this.recordAudit(
      input,
      auth.mandate,
      target,
      finalDecision,
      intent.rawPayload,
      requestDigest,
      reservationId,
    );

    let upstream: StripeProviderResponse;
    try {
      upstream = await this.execution.dispatchPrepared(prepared);
    } catch {
      await this.deps.paymentOutcomes.markUnknown(begun.outcome.id, {
        errorCode: "STRIPE_CONFIRM_OUTCOME_UNKNOWN",
        now: input.now,
      });
      throw new PaymentOutcomePendingError(begun.outcome.id);
    }

    if (upstream.status < 200 || upstream.status >= 300) {
      await this.deps.paymentOutcomes.markUnknown(begun.outcome.id, {
        upstreamStatus: upstream.status,
        errorCode: `STRIPE_CONFIRM_HTTP_${upstream.status}`,
        now: input.now,
      });
      throw new PaymentOutcomePendingError(begun.outcome.id, upstream.status);
    }

    let confirmed;
    try {
      confirmed = parseStripePaymentIntent(upstream.body);
    } catch {
      await this.deps.paymentOutcomes.markUnknown(begun.outcome.id, {
        upstreamStatus: upstream.status,
        errorCode: "STRIPE_CONFIRM_INVALID_PAYMENT_INTENT",
        now: input.now,
      });
      throw new PaymentOutcomePendingError(begun.outcome.id, upstream.status);
    }
    const safeResponse = stripeEvidence(upstream, confirmed);

    if (confirmed.status === "succeeded") {
      await this.deps.paymentOutcomes.markSucceeded(begun.outcome.id, safeResponse, input.now);
      const committed = await this.deps.reservations.commit(
        auth.mandate.id,
        reservationId,
        input.now,
      );
      if (!committed) {
        throw new Error("Stripe succeeded but spend reservation could not be committed");
      }
      return {
        decision: finalDecision,
        paymentIntentId: input.paymentIntentId,
        ...(approvalRequestId ? { approvalRequestId } : {}),
        reservationId,
        paymentOutcomeId: begun.outcome.id,
        upstream: safeResponse,
      };
    }

    if (confirmed.status === "canceled") {
      await this.deps.paymentOutcomes.markDefinitiveFailure(
        begun.outcome.id,
        safeResponse,
        input.now,
      );
      await this.deps.reservations.release(auth.mandate.id, reservationId);
      return {
        decision: finalDecision,
        paymentIntentId: input.paymentIntentId,
        ...(approvalRequestId ? { approvalRequestId } : {}),
        reservationId,
        paymentOutcomeId: begun.outcome.id,
        upstream: safeResponse,
      };
    }

    await this.deps.paymentOutcomes.markUnknown(begun.outcome.id, {
      upstreamStatus: upstream.status,
      errorCode: "STRIPE_PAYMENT_INTENT_NOT_TERMINAL",
      now: input.now,
    });
    throw new PaymentOutcomePendingError(begun.outcome.id, upstream.status);
  }

  private async authenticate(
    input: PersonalStripeConfirmInput,
  ): Promise<{ readonly mandate: AgentSpendMandate }> {
    const verified = await this.deps.mandateTokens.verify(input.security.mandateToken, input.now);
    const mandate = await this.deps.mandates.getById(verified.claims.mandateId);
    if (!mandate) {
      throw new ProxyAuthenticationError("Mandate does not exist");
    }
    this.deps.mandateTokens.assertBoundToMandate(verified, mandate);

    await this.deps.agentRequests.verify({
      method: "POST",
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

  private resolveTarget(mandate: AgentSpendMandate): StripeExecutionTarget {
    const target = this.deps.stripeTarget;
    if (!target.active || target.organizationId !== mandate.organizationId) {
      throw new ProxyAuthenticationError("Stripe execution target is not available to this mandate");
    }
    return target;
  }

  private async resolveCredential(organizationId: string, targetId: string): Promise<string> {
    const authorization = await this.deps.credentials.getAuthorization(organizationId, targetId);
    if (!authorization || !/^Bearer\s+\S+$/i.test(authorization.trim())) {
      throw new PersonalStripeProviderError("Stripe server-side execution credential is unavailable");
    }
    return authorization.trim();
  }

  private async retrieveAuthoritativePaymentIntent(
    authorization: string,
    target: StripeExecutionTarget,
    paymentIntentId: string,
  ) {
    let response: StripeProviderResponse;
    try {
      response = await this.deps.stripeClient.retrievePaymentIntent({
        authorization,
        ...(target.accountId ? { accountId: target.accountId } : {}),
        paymentIntentId,
      });
    } catch {
      throw new PersonalStripeProviderError("Unable to retrieve authoritative Stripe PaymentIntent state");
    }
    if (response.status < 200 || response.status >= 300) {
      throw new PersonalStripeProviderError(
        `Unable to retrieve authoritative Stripe PaymentIntent state (HTTP ${response.status})`,
      );
    }
    try {
      return parseStripePaymentIntent(response.body);
    } catch (error) {
      if (error instanceof StripeProtocolError) {
        throw new PersonalStripeProviderError(error.message);
      }
      throw error;
    }
  }

  private async resolvePendingApproval(args: {
    readonly decision: PolicyDecision;
    readonly existingApproval?: ApprovalRequestRecord | undefined;
    readonly mandate: AgentSpendMandate;
    readonly target: StripeExecutionTarget;
    readonly input: PersonalStripeConfirmInput;
    readonly intentSnapshot: unknown;
    readonly requestDigest: string;
    readonly spend: SpendState;
  }): Promise<{ readonly decision: PolicyDecision; readonly approvalRequestId: string }> {
    const existing = args.existingApproval;
    if (existing) {
      if (existing.status === ApprovalRequestStatus.REJECTED) {
        return {
          decision: blockApprovalDecision(args.decision, DecisionReason.HUMAN_APPROVAL_REJECTED),
          approvalRequestId: existing.id,
        };
      }
      if (existing.status === ApprovalRequestStatus.EXPIRED || args.input.now >= existing.expiresAt) {
        return {
          decision: blockApprovalDecision(args.decision, DecisionReason.HUMAN_APPROVAL_EXPIRED),
          approvalRequestId: existing.id,
        };
      }
      if (existing.status === ApprovalRequestStatus.APPROVED) {
        return {
          decision: approvalCoversDecision(existing, args.decision, args.spend)
            ? grantApprovedDecision(args.decision)
            : blockApprovalDecision(args.decision, DecisionReason.HUMAN_APPROVAL_STALE),
          approvalRequestId: existing.id,
        };
      }
    }

    const request = await this.deps.approvals.requestApproval({
      decision: args.decision,
      mandate: args.mandate,
      merchantId: args.target.id,
      merchantDomain: args.target.domain,
      checkoutSessionId: args.input.paymentIntentId,
      idempotencyKey: args.input.idempotencyKey,
      requestDigest: args.requestDigest,
      requestedPayload: { paymentIntentId: args.input.paymentIntentId },
      sessionSnapshot: args.intentSnapshot,
      spend: args.spend,
      now: args.input.now,
    });
    return { decision: args.decision, approvalRequestId: request.id };
  }

  private async resolveExistingOutcome(
    outcome: PaymentOutcomeRecord,
    input: PersonalStripeConfirmInput,
    mandate: AgentSpendMandate,
  ): Promise<PersonalStripeExecutionResult> {
    if (outcome.status === PaymentOutcomeStatus.SUCCEEDED) {
      if (!outcome.response) throw new Error("Succeeded Stripe outcome is missing provider evidence");
      const committed = await this.deps.reservations.commit(mandate.id, outcome.reservationId, input.now);
      if (!committed) {
        throw new PaymentOutcomePendingError(outcome.id, outcome.upstreamStatus);
      }
      return replayResult(outcome);
    }
    if (outcome.status === PaymentOutcomeStatus.FAILED_DEFINITIVE) {
      if (!outcome.response) throw new Error("Failed Stripe outcome is missing provider evidence");
      await this.deps.reservations.release(mandate.id, outcome.reservationId);
      return replayResult(outcome);
    }

    const held = await this.deps.reservations.holdForReconciliation(
      mandate.id,
      outcome.reservationId,
      input.now,
    );
    if (!held) {
      throw new PaymentOutcomePendingError(outcome.id, outcome.upstreamStatus);
    }

    const observation = await this.reconciliation.reconcile(outcome);
    if (observation.disposition === "DEFERRED") {
      await this.deps.paymentOutcomes.markUnknown(outcome.id, {
        ...(observation.providerStatus !== undefined
          ? { upstreamStatus: observation.providerStatus }
          : {}),
        errorCode: observation.errorCode,
        now: input.now,
      });
      throw new PaymentOutcomePendingError(outcome.id, observation.providerStatus);
    }

    if (observation.disposition === "SUCCEEDED") {
      const committed = await this.deps.reservations.commit(mandate.id, outcome.reservationId, input.now);
      if (!committed) {
        throw new PaymentOutcomePendingError(outcome.id, observation.evidence.status);
      }
      const terminal = await this.deps.paymentOutcomes.markSucceeded(
        outcome.id,
        observation.evidence,
        input.now,
      );
      return replayResult(terminal);
    }

    const released = await this.deps.reservations.release(mandate.id, outcome.reservationId);
    if (!released) {
      throw new PaymentOutcomePendingError(outcome.id, observation.evidence.status);
    }
    const terminal = await this.deps.paymentOutcomes.markDefinitiveFailure(
      outcome.id,
      observation.evidence,
      input.now,
    );
    return replayResult(terminal);
  }

  private async recordAudit(
    input: PersonalStripeConfirmInput,
    mandate: AgentSpendMandate,
    target: StripeExecutionTarget,
    decision: PolicyDecision,
    approvedPayload: unknown,
    requestDigest: string,
    reservationId?: string,
  ): Promise<void> {
    await this.deps.audit.record({
      requestId: input.requestId,
      decisionId: decision.decisionId,
      organizationId: mandate.organizationId,
      userId: mandate.userId,
      agentId: mandate.agentId,
      mandateId: mandate.id,
      timestamp: input.now,
      protocol: "STRIPE",
      operation: "AUTHORIZE_PAYMENT",
      merchantDomain: target.domain,
      requestedPayload: { paymentIntentId: input.paymentIntentId },
      approvedPayload,
      decision,
      requestDigest,
      ...(reservationId ? { reservationId } : {}),
    });
  }

  private assertApiVersion(value: string): void {
    if (value !== PERSONAL_STRIPE_API_VERSION) {
      throw new PersonalStripeProviderError(
        `Unsupported Personal Stripe API-Version ${value}; expected ${PERSONAL_STRIPE_API_VERSION}`,
      );
    }
  }
}

function replayResult(outcome: PaymentOutcomeRecord): PersonalStripeExecutionResult {
  if (!outcome.response) {
    throw new Error("Terminal Stripe outcome is missing replayable provider evidence");
  }
  return {
    paymentIntentId: outcome.checkoutSessionId,
    reservationId: outcome.reservationId,
    paymentOutcomeId: outcome.id,
    upstream: outcome.response,
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
    distinctCounterpartiesInWindow: 0,
    counterpartyKeysInWindow: [],
  };
}
