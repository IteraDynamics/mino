import type { EconomicProviderEvidence } from "../../execution/economic-reconciliation-adapter.js";
import type { StripeProviderResponse } from "./stripe-payment-intent-client.js";

export type StripePaymentIntentStatus =
  | "requires_payment_method"
  | "requires_confirmation"
  | "requires_action"
  | "processing"
  | "requires_capture"
  | "canceled"
  | "succeeded";

export interface NormalizedStripePaymentIntent {
  readonly id: string;
  readonly amount: bigint;
  readonly currency: string;
  readonly status: StripePaymentIntentStatus;
  readonly cancellationReason?: string;
}

export class StripeProtocolError extends Error {}

export function parseStripePaymentIntent(value: unknown): NormalizedStripePaymentIntent {
  if (!isRecord(value)) {
    throw new StripeProtocolError("Stripe PaymentIntent response must be an object");
  }

  const id = value.id;
  const object = value.object;
  const amount = value.amount;
  const currency = value.currency;
  const status = value.status;

  if (typeof id !== "string" || !/^pi_[A-Za-z0-9]+$/.test(id)) {
    throw new StripeProtocolError("Stripe PaymentIntent response has an invalid id");
  }
  if (object !== "payment_intent") {
    throw new StripeProtocolError("Stripe response is not a PaymentIntent");
  }
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) {
    throw new StripeProtocolError("Stripe PaymentIntent amount is invalid");
  }
  if (typeof currency !== "string" || !/^[a-zA-Z]{3}$/.test(currency)) {
    throw new StripeProtocolError("Stripe PaymentIntent currency is invalid");
  }
  if (!isStripePaymentIntentStatus(status)) {
    throw new StripeProtocolError("Stripe PaymentIntent status is unknown");
  }

  const cancellationReason = value.cancellation_reason;
  return {
    id,
    amount: BigInt(amount),
    currency: currency.toUpperCase(),
    status,
    ...(typeof cancellationReason === "string" && cancellationReason
      ? { cancellationReason }
      : {}),
  };
}

/** Store only the provider facts needed for audit/replay; never persist client_secret or payment details. */
export function stripeEvidence(
  upstream: StripeProviderResponse,
  paymentIntent: NormalizedStripePaymentIntent,
): EconomicProviderEvidence {
  const headers = upstream.headers ? safeHeaders(upstream.headers) : undefined;
  return {
    status: upstream.status,
    body: {
      id: paymentIntent.id,
      object: "payment_intent",
      amount: paymentIntent.amount.toString(10),
      currency: paymentIntent.currency,
      status: paymentIntent.status,
      ...(paymentIntent.cancellationReason
        ? { cancellation_reason: paymentIntent.cancellationReason }
        : {}),
    },
    ...(headers ? { headers } : {}),
  };
}

function safeHeaders(
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> | undefined {
  const allowed = new Set(["request-id", "stripe-version"]);
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (allowed.has(key.toLowerCase())) {
      output[key.toLowerCase()] = value;
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function isStripePaymentIntentStatus(value: unknown): value is StripePaymentIntentStatus {
  return (
    value === "requires_payment_method" ||
    value === "requires_confirmation" ||
    value === "requires_action" ||
    value === "processing" ||
    value === "requires_capture" ||
    value === "canceled" ||
    value === "succeeded"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
