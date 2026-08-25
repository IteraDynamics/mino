import type { AuthorizationDecision } from "../../../domain/economic/authorization-decision.js";
import type { SignedAuthorizationGrant } from "../../../domain/economic/authorization-grant.types.js";
import type { EconomicIntent } from "../../../domain/economic/economic-intent.types.js";
import type {
  EconomicExecutionAdapter,
  EconomicExecutionInput,
} from "../../execution/execution-adapter.js";
import {
  parseStripePaymentIntent,
  type NormalizedStripePaymentIntent,
} from "./stripe-payment-intent.js";
import type {
  StripePaymentIntentClient,
  StripeProviderResponse,
} from "./stripe-payment-intent-client.js";

export interface StripeExecutionContext {
  readonly authorization: string;
  readonly accountId: string;
  readonly paymentIntentId: string;
  readonly paymentMethod?: string;
  readonly returnUrl?: string;
}

/**
 * Second-provider proof for Mino's neutral execution boundary.
 * Stripe remains a compatibility provider in this PR: it consumes the same
 * intent-bound AuthorizationDecision/ExecutionGrant lifecycle, while full
 * authoritative Stripe-to-canonical-intent normalization is a later adapter test.
 */
export class StripeExecutionAdapter
  implements EconomicExecutionAdapter<StripeExecutionContext, StripeProviderResponse>
{
  public readonly protocol = "STRIPE" as const;

  public constructor(private readonly client: StripePaymentIntentClient) {}

  public async execute(
    input: EconomicExecutionInput<StripeExecutionContext>,
  ): Promise<StripeProviderResponse> {
    if (input.intent.protocol !== this.protocol) {
      throw new Error("Stripe execution adapter refuses non-Stripe economic intent");
    }
    this.assertGrantBinding(input.grant, input.intent, input.decision, input.context, input.now);

    const current = await this.client.retrievePaymentIntent({
      authorization: input.context.authorization,
      accountId: input.context.accountId,
      paymentIntentId: input.context.paymentIntentId,
    });
    if (current.status < 200 || current.status >= 300) {
      throw new Error(`Stripe PaymentIntent preflight failed with HTTP ${current.status}`);
    }

    const paymentIntent = parseStripePaymentIntent(current.body);
    this.assertProviderEconomicBinding(paymentIntent, input.grant, input.context);
    this.assertConfirmable(paymentIntent, input.context);

    const confirmed = await this.client.confirmPaymentIntent({
      authorization: input.context.authorization,
      accountId: input.context.accountId,
      paymentIntentId: input.context.paymentIntentId,
      idempotencyKey: input.intent.idempotencyKey,
      ...(input.context.paymentMethod ? { paymentMethod: input.context.paymentMethod } : {}),
      ...(input.context.returnUrl ? { returnUrl: input.context.returnUrl } : {}),
    });
    if (confirmed.status < 200 || confirmed.status >= 300) {
      return confirmed;
    }

    const confirmedIntent = parseStripePaymentIntent(confirmed.body);
    this.assertProviderEconomicBinding(confirmedIntent, input.grant, input.context);
    return confirmed;
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
      grant.claims.mandate_id !== decision.mandateId ||
      grant.claims.operation !== intent.operation ||
      grant.claims.agent_id !== intent.agentId ||
      grant.claims.intent_digest !== decision.intentDigest ||
      grant.claims.amount_minor !== decision.approvedAmount.minorUnits.toString(10) ||
      grant.claims.currency !== decision.approvedAmount.currency
    ) {
      throw new Error("Authorization grant does not bind to the requested Stripe execution");
    }
    if (grant.claims.exp <= Math.floor(now.getTime() / 1000)) {
      throw new Error("Stripe execution authorization grant is expired");
    }
    if (!grantBindsStripeAccount(grant, context.accountId)) {
      throw new Error("Authorization grant does not bind the Stripe connected account");
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

  private assertConfirmable(
    paymentIntent: NormalizedStripePaymentIntent,
    context: StripeExecutionContext,
  ): void {
    if (paymentIntent.status === "requires_confirmation") {
      return;
    }
    if (paymentIntent.status === "requires_payment_method" && context.paymentMethod) {
      return;
    }
    throw new Error(`Stripe PaymentIntent status ${paymentIntent.status} is not confirmable by this adapter`);
  }
}

function grantBindsStripeAccount(grant: SignedAuthorizationGrant, accountId: string): boolean {
  return grant.claims.counterparty.identifiers.some(
    (identifier) =>
      identifier.scheme === "PROVIDER_REFERENCE" &&
      identifier.namespace?.trim().toLowerCase() === "stripe-account" &&
      identifier.value === accountId,
  );
}
