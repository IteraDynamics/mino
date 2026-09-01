import type { AuthorizationDecision } from "../../../domain/economic/authorization-decision.js";
import type { SignedAuthorizationGrant } from "../../../domain/economic/authorization-grant.types.js";
import { bindEconomicIntent } from "../../../domain/economic/canonical-economic-intent.js";
import type { EconomicIntent } from "../../../domain/economic/economic-intent.types.js";
import { sha256Base64Url } from "../../../infrastructure/crypto/canonical-json.js";
import type {
  EconomicExecutionAdapter,
  EconomicExecutionInput,
} from "../../execution/execution-adapter.js";
import {
  normalizeStripeAuthoritativeIntent,
  stripeProviderBindingDigest,
  type StripeExecutionTarget,
} from "./stripe-authoritative-intent.js";
import {
  parseStripePaymentIntent,
  type NormalizedStripePaymentIntent,
} from "./stripe-payment-intent.js";
import type {
  StripePaymentIntentClient,
  StripeProviderResponse,
} from "./stripe-payment-intent-client.js";

export interface StripeExecutionContext {
  /** Server-side only. Never sourced from the agent request. */
  readonly authorization: string;
  readonly target: StripeExecutionTarget;
  readonly paymentIntentId: string;
}

export interface PreparedStripeExecution {
  readonly intent: EconomicIntent;
  readonly decision: AuthorizationDecision;
  readonly grant: SignedAuthorizationGrant;
  readonly context: StripeExecutionContext;
  readonly providerState: NormalizedStripePaymentIntent;
}

/** Provider adapter for a real Stripe PaymentIntent confirmation. */
export class StripeExecutionAdapter
  implements EconomicExecutionAdapter<StripeExecutionContext, StripeProviderResponse>
{
  public readonly protocol = "STRIPE" as const;

  public constructor(private readonly client: StripePaymentIntentClient) {}

  /**
   * Final provider-authoritative preflight. The caller may durably record the
   * execution attempt after this succeeds and before calling dispatchPrepared().
   */
  public async prepare(
    input: EconomicExecutionInput<StripeExecutionContext>,
  ): Promise<PreparedStripeExecution> {
    if (input.intent.protocol !== this.protocol) {
      throw new Error("Stripe execution adapter refuses non-Stripe economic intent");
    }
    this.assertGrantBinding(input.grant, input.intent, input.decision, input.context, input.now);

    const current = await this.client.retrievePaymentIntent({
      authorization: input.context.authorization,
      ...(input.context.target.accountId ? { accountId: input.context.target.accountId } : {}),
      paymentIntentId: input.context.paymentIntentId,
    });
    if (current.status < 200 || current.status >= 300) {
      throw new Error(`Stripe PaymentIntent preflight failed with HTTP ${current.status}`);
    }

    const paymentIntent = parseStripePaymentIntent(current.body);
    this.assertProviderEconomicBinding(paymentIntent, input.grant, input.context);
    this.assertAuthoritativeIntentStillMatches(paymentIntent, input);

    return Object.freeze({
      intent: input.intent,
      decision: input.decision,
      grant: input.grant,
      context: input.context,
      providerState: paymentIntent,
    });
  }

  /**
   * Economic dispatch. No mutable agent/provider fields are accepted here: the
   * PaymentIntent reference, target, credential, and idempotency key all come from
   * the already-authorized prepared execution.
   */
  public async dispatchPrepared(prepared: PreparedStripeExecution): Promise<StripeProviderResponse> {
    const confirmed = await this.client.confirmPaymentIntent({
      authorization: prepared.context.authorization,
      ...(prepared.context.target.accountId
        ? { accountId: prepared.context.target.accountId }
        : {}),
      paymentIntentId: prepared.context.paymentIntentId,
      idempotencyKey: prepared.intent.idempotencyKey,
    });
    if (confirmed.status < 200 || confirmed.status >= 300) {
      return confirmed;
    }

    const confirmedIntent = parseStripePaymentIntent(confirmed.body);
    this.assertProviderEconomicBinding(confirmedIntent, prepared.grant, prepared.context);
    this.assertProviderConsequenceBinding(confirmedIntent, prepared);
    return confirmed;
  }

  public async execute(
    input: EconomicExecutionInput<StripeExecutionContext>,
  ): Promise<StripeProviderResponse> {
    const prepared = await this.prepare(input);
    return this.dispatchPrepared(prepared);
  }

  private assertAuthoritativeIntentStillMatches(
    paymentIntent: NormalizedStripePaymentIntent,
    input: EconomicExecutionInput<StripeExecutionContext>,
  ): void {
    let currentIntent: EconomicIntent;
    try {
      currentIntent = normalizeStripeAuthoritativeIntent({
        paymentIntent,
        target: input.context.target,
        requestId: input.intent.requestId,
        userId: input.intent.userId,
        agentId: input.intent.agentId,
        idempotencyKey: input.intent.idempotencyKey,
      });
    } catch {
      throw new Error("Authoritative Stripe PaymentIntent state changed after authorization");
    }

    const rebound = bindEconomicIntent(currentIntent, {
      organizationId: input.intent.organizationId,
      userId: input.intent.userId,
      agentId: input.intent.agentId,
      mandateId: input.decision.mandateId,
      policyId: input.decision.policyId,
      policyVersion: input.decision.policyVersion,
    });
    if (rebound.intentDigest !== input.decision.intentDigest) {
      throw new Error("Authoritative Stripe PaymentIntent state changed after authorization");
    }
  }

  private assertProviderConsequenceBinding(
    paymentIntent: NormalizedStripePaymentIntent,
    prepared: PreparedStripeExecution,
  ): void {
    const expected = stripeProviderBindingDigest(prepared.providerState, prepared.context.target);
    const observed = stripeProviderBindingDigest(paymentIntent, prepared.context.target);
    if (observed !== expected) {
      throw new Error("Stripe provider consequence changed after authorization");
    }
  }

  private assertGrantBinding(
    grant: SignedAuthorizationGrant,
    intent: EconomicIntent,
    decision: AuthorizationDecision,
    context: StripeExecutionContext,
    now: Date,
  ): void {
    if (!decision.approvedAmount) {
      throw new Error("Stripe execution requires an approved amount");
    }
    if (
      grant.claims.request_id !== intent.requestId ||
      grant.claims.decision_id !== decision.decisionId ||
      grant.claims.organization_id !== intent.organizationId ||
      grant.claims.user_id !== intent.userId ||
      grant.claims.mandate_id !== decision.mandateId ||
      grant.claims.policy_id !== decision.policyId ||
      grant.claims.policy_version !== decision.policyVersion ||
      grant.claims.operation !== intent.operation ||
      grant.claims.agent_id !== intent.agentId ||
      grant.claims.intent_digest !== decision.intentDigest ||
      grant.claims.idempotency_digest !== sha256Base64Url(intent.idempotencyKey) ||
      grant.claims.amount_minor !== decision.approvedAmount.minorUnits.toString(10) ||
      grant.claims.currency !== decision.approvedAmount.currency
    ) {
      throw new Error("Authorization grant does not bind to the requested Stripe execution");
    }
    if (grant.claims.exp <= Math.floor(now.getTime() / 1000)) {
      throw new Error("Stripe execution authorization grant is expired");
    }
    if (!grantBindsStripeTarget(grant, context.target)) {
      throw new Error("Authorization grant does not bind the configured Stripe execution target");
    }
  }

  private assertProviderEconomicBinding(
    paymentIntent: NormalizedStripePaymentIntent,
    grant: SignedAuthorizationGrant,
    context: StripeExecutionContext,
  ): void {
    if (paymentIntent.id !== context.paymentIntentId) {
      throw new Error("Stripe PaymentIntent ID does not match the authorized execution target");
    }
    if (
      paymentIntent.amount.toString(10) !== grant.claims.amount_minor ||
      paymentIntent.currency !== grant.claims.currency.toUpperCase()
    ) {
      throw new Error("Stripe PaymentIntent economics do not match the AuthorizationGrant");
    }
  }
}

function grantBindsStripeTarget(
  grant: SignedAuthorizationGrant,
  target: StripeExecutionTarget,
): boolean {
  const domainBound = grant.claims.counterparty.identifiers.some(
    (identifier) =>
      identifier.scheme === "DOMAIN" &&
      canonicalDomain(identifier.value) === canonicalDomain(target.domain),
  );
  if (!domainBound) return false;

  if (!target.accountId) return true;
  return grant.claims.counterparty.identifiers.some(
    (identifier) =>
      identifier.scheme === "PROVIDER_REFERENCE" &&
      identifier.namespace?.trim().toLowerCase() === "stripe-account" &&
      identifier.value === target.accountId,
  );
}

function canonicalDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}
