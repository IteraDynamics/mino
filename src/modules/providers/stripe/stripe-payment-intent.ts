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

export type StripeCaptureMethod = "automatic" | "automatic_async" | "manual";
export type StripeConfirmationMethod = "automatic" | "manual";

export interface NormalizedStripePaymentIntent {
  readonly id: string;
  readonly amount: bigint;
  readonly currency: string;
  readonly status: StripePaymentIntentStatus;
  readonly captureMethod: StripeCaptureMethod;
  readonly confirmationMethod: StripeConfirmationMethod;
  readonly livemode: boolean;
  readonly paymentMethodId?: string;
  readonly onBehalfOf?: string;
  readonly transferDestination?: string;
  readonly applicationFeeAmount?: bigint;
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
  const captureMethod = value.capture_method;
  const confirmationMethod = value.confirmation_method;
  const livemode = value.livemode;

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
  if (!isStripeCaptureMethod(captureMethod)) {
    throw new StripeProtocolError("Stripe PaymentIntent capture method is unknown");
  }
  if (!isStripeConfirmationMethod(confirmationMethod)) {
    throw new StripeProtocolError("Stripe PaymentIntent confirmation method is unknown");
  }
  if (typeof livemode !== "boolean") {
    throw new StripeProtocolError("Stripe PaymentIntent livemode flag is invalid");
  }

  const paymentMethodId = optionalStripeId(value.payment_method, "pm_");
  const onBehalfOf = optionalStripeId(value.on_behalf_of, "acct_");
  const transferDestination = transferDestinationId(value.transfer_data);
  const applicationFeeAmount = optionalNonNegativeInteger(value.application_fee_amount);
  const cancellationReason = value.cancellation_reason;

  return {
    id,
    amount: BigInt(amount),
    currency: currency.toUpperCase(),
    status,
    captureMethod,
    confirmationMethod,
    livemode,
    ...(paymentMethodId ? { paymentMethodId } : {}),
    ...(onBehalfOf ? { onBehalfOf } : {}),
    ...(transferDestination ? { transferDestination } : {}),
    ...(applicationFeeAmount !== undefined ? { applicationFeeAmount } : {}),
    ...(typeof cancellationReason === "string" && cancellationReason
      ? { cancellationReason }
      : {}),
  };
}

/** Store only provider facts needed for audit/replay; never persist client_secret or payment details. */
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
      capture_method: paymentIntent.captureMethod,
      confirmation_method: paymentIntent.confirmationMethod,
      livemode: paymentIntent.livemode,
      ...(paymentIntent.onBehalfOf ? { on_behalf_of: paymentIntent.onBehalfOf } : {}),
      ...(paymentIntent.transferDestination
        ? { transfer_destination: paymentIntent.transferDestination }
        : {}),
      ...(paymentIntent.applicationFeeAmount !== undefined
        ? { application_fee_amount: paymentIntent.applicationFeeAmount.toString(10) }
        : {}),
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

function isStripeCaptureMethod(value: unknown): value is StripeCaptureMethod {
  return value === "automatic" || value === "automatic_async" || value === "manual";
}

function isStripeConfirmationMethod(value: unknown): value is StripeConfirmationMethod {
  return value === "automatic" || value === "manual";
}

function optionalStripeId(value: unknown, prefix: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string" || !value.startsWith(prefix) || value.length <= prefix.length) {
    throw new StripeProtocolError(`Stripe PaymentIntent contains an invalid ${prefix} reference`);
  }
  return value;
}

function transferDestinationId(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new StripeProtocolError("Stripe PaymentIntent transfer_data is invalid");
  }
  return optionalStripeId(value.destination, "acct_");
}

function optionalNonNegativeInteger(value: unknown): bigint | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new StripeProtocolError("Stripe PaymentIntent application fee amount is invalid");
  }
  return BigInt(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
