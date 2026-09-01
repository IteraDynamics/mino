import { canonicalJson, sha256Base64Url } from "../../../infrastructure/crypto/canonical-json.js";
import type { EconomicIntent } from "../../../domain/economic/economic-intent.types.js";
import type { NormalizedStripePaymentIntent } from "./stripe-payment-intent.js";

export interface StripeExecutionTarget {
  readonly id: string;
  readonly organizationId: string;
  readonly domain: string;
  readonly expectedLivemode: boolean;
  readonly accountId?: string;
  readonly active: boolean;
}

export interface StripeAuthoritativeIntentInput {
  readonly paymentIntent: NormalizedStripePaymentIntent;
  readonly target: StripeExecutionTarget;
  readonly requestId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly idempotencyKey: string;
}

/**
 * Build Mino's authorization input from Stripe-authoritative state.
 *
 * The agent contributes only the PaymentIntent reference and its Mino request proof.
 * Amount, currency, payment method binding, capture semantics, destination semantics,
 * live/test mode, and current confirmability are all derived from Stripe's server-side
 * PaymentIntent response plus the server-configured execution target.
 */
export function normalizeStripeAuthoritativeIntent(
  input: StripeAuthoritativeIntentInput,
): EconomicIntent {
  const { paymentIntent, target } = input;
  assertTarget(target);

  if (paymentIntent.livemode !== target.expectedLivemode) {
    throw new Error("Stripe PaymentIntent live/test mode does not match the configured execution target");
  }
  if (paymentIntent.captureMethod === "manual") {
    throw new Error("Mino Personal live Stripe execution does not permit manual capture PaymentIntents");
  }
  if (paymentIntent.status !== "requires_confirmation") {
    throw new Error(
      `Stripe PaymentIntent status ${paymentIntent.status} is not ready for server-side confirmation`,
    );
  }
  if (!paymentIntent.paymentMethodId) {
    throw new Error("Stripe PaymentIntent must already have a server-visible payment method attached");
  }

  const authoritativeProjection = {
    ...stripeProviderBindingProjection(paymentIntent, target),
    status: paymentIntent.status,
  };

  const counterpartyIdentifiers = [
    { scheme: "DOMAIN" as const, value: canonicalDomain(target.domain) },
    ...(target.accountId
      ? [
          {
            scheme: "PROVIDER_REFERENCE" as const,
            namespace: "stripe-account",
            value: target.accountId,
          },
        ]
      : []),
  ];

  return {
    requestId: input.requestId,
    protocol: "STRIPE",
    operation: "AUTHORIZE_PAYMENT",
    organizationId: target.organizationId,
    userId: input.userId,
    agentId: input.agentId,
    counterparty: {
      kind: "MERCHANT",
      identifiers: counterpartyIdentifiers,
    },
    merchant: {
      domain: canonicalDomain(target.domain),
    },
    economicValue: {
      amount: {
        currency: paymentIntent.currency,
        minorUnits: paymentIntent.amount,
      },
    },
    idempotencyKey: input.idempotencyKey,
    authoritativeStateDigest: sha256Base64Url(canonicalJson(authoritativeProjection)),
    rawPayload: authoritativeProjection,
  };
}

/**
 * Durable digest of the provider facts that define the economic consequence.
 * Status is intentionally excluded so the digest survives the legitimate
 * requires_confirmation -> processing/succeeded/canceled transition.
 */
export function stripeProviderBindingDigest(
  paymentIntent: NormalizedStripePaymentIntent,
  target: StripeExecutionTarget,
): string {
  assertTarget(target);
  return sha256Base64Url(canonicalJson(stripeProviderBindingProjection(paymentIntent, target)));
}

export function stripeExecutionRequestDigest(
  targetId: string,
  paymentIntentId: string,
): string {
  return sha256Base64Url(
    canonicalJson({
      protocol: "STRIPE",
      operation: "AUTHORIZE_PAYMENT",
      targetId: targetId.trim(),
      paymentIntentId: paymentIntentId.trim(),
    }),
  );
}

function stripeProviderBindingProjection(
  paymentIntent: NormalizedStripePaymentIntent,
  target: StripeExecutionTarget,
) {
  return {
    paymentIntentId: paymentIntent.id,
    amountMinor: paymentIntent.amount,
    currency: paymentIntent.currency,
    captureMethod: paymentIntent.captureMethod,
    confirmationMethod: paymentIntent.confirmationMethod,
    livemode: paymentIntent.livemode,
    paymentMethodId: paymentIntent.paymentMethodId ?? null,
    onBehalfOf: paymentIntent.onBehalfOf ?? null,
    transferDestination: paymentIntent.transferDestination ?? null,
    applicationFeeAmountMinor: paymentIntent.applicationFeeAmount ?? null,
    target: {
      id: target.id,
      domain: canonicalDomain(target.domain),
      accountId: target.accountId ?? null,
    },
  };
}

function assertTarget(target: StripeExecutionTarget): void {
  if (!target.active) {
    throw new Error("Stripe execution target is not active");
  }
  if (!target.id.trim()) {
    throw new Error("Stripe execution target ID is required");
  }
  if (!/^[0-9a-fA-F-]{36}$/.test(target.organizationId)) {
    throw new Error("Stripe execution target organization ID is invalid");
  }
  canonicalDomain(target.domain);
  if (target.accountId && !/^acct_[A-Za-z0-9]+$/.test(target.accountId)) {
    throw new Error("Stripe execution target connected account ID is invalid");
  }
}

function canonicalDomain(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (
    !normalized ||
    !normalized.includes(".") ||
    normalized.includes("://") ||
    normalized.includes("/") ||
    normalized.includes("@") ||
    normalized.includes(":")
  ) {
    throw new Error("Stripe execution target domain is invalid");
  }
  return normalized;
}
