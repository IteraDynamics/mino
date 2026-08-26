export interface StripeProviderResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface StripeRequestContext {
  /** Server-side Stripe API authorization header. Never sourced from agent input. */
  readonly authorization: string;
  /** Optional connected account execution destination. Omit for a direct Stripe account. */
  readonly accountId?: string;
}

export interface StripeConfirmPaymentIntentInput extends StripeRequestContext {
  readonly paymentIntentId: string;
  readonly idempotencyKey: string;
}

export interface StripeRetrievePaymentIntentInput extends StripeRequestContext {
  readonly paymentIntentId: string;
}

/** Minimal provider client used by Mino's Stripe adapters. */
export interface StripePaymentIntentClient {
  confirmPaymentIntent(input: StripeConfirmPaymentIntentInput): Promise<StripeProviderResponse>;
  retrievePaymentIntent(input: StripeRetrievePaymentIntentInput): Promise<StripeProviderResponse>;
}

export interface FetchStripePaymentIntentClientOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Small REST client for Stripe PaymentIntents.
 *
 * Keeping the HTTP client local to the provider implementation avoids adding the
 * Stripe SDK to Mino's provider-neutral dependency graph. The caller owns secret
 * lookup; this class only receives a ready-to-send server-side authorization header.
 */
export class FetchStripePaymentIntentClient implements StripePaymentIntentClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: FetchStripePaymentIntentClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://api.stripe.com").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async confirmPaymentIntent(
    input: StripeConfirmPaymentIntentInput,
  ): Promise<StripeProviderResponse> {
    assertStripeRequestContext(input);
    if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 255) {
      throw new Error("Stripe confirmation requires an idempotency key of at most 255 characters");
    }

    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/payment_intents/${encodeURIComponent(input.paymentIntentId)}/confirm`,
      {
        method: "POST",
        headers: stripeHeaders(input, true),
        body: "",
      },
    );
    return providerResponse(response);
  }

  public async retrievePaymentIntent(
    input: StripeRetrievePaymentIntentInput,
  ): Promise<StripeProviderResponse> {
    assertStripeRequestContext(input);
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/payment_intents/${encodeURIComponent(input.paymentIntentId)}`,
      {
        method: "GET",
        headers: stripeHeaders(input, false),
      },
    );
    return providerResponse(response);
  }
}

function assertStripeRequestContext(input: StripeRequestContext & { readonly paymentIntentId: string }): void {
  if (!/^Bearer\s+\S+$/i.test(input.authorization.trim())) {
    throw new Error("Stripe server-side bearer authorization is required");
  }
  if (input.accountId && !/^acct_[A-Za-z0-9]+$/.test(input.accountId)) {
    throw new Error("Stripe connected account ID is invalid");
  }
  if (!/^pi_[A-Za-z0-9]+$/.test(input.paymentIntentId)) {
    throw new Error("Stripe PaymentIntent ID is invalid");
  }
}

function stripeHeaders(
  input: StripeRequestContext & { readonly idempotencyKey?: string },
  includeIdempotency: boolean,
): Record<string, string> {
  return {
    authorization: input.authorization.trim(),
    ...(input.accountId ? { "stripe-account": input.accountId } : {}),
    ...(includeIdempotency && input.idempotencyKey
      ? { "idempotency-key": input.idempotencyKey }
      : {}),
    "content-type": "application/x-www-form-urlencoded",
  };
}

async function providerResponse(response: Response): Promise<StripeProviderResponse> {
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }

  const headers: Record<string, string> = {};
  for (const name of ["request-id", "stripe-version"] as const) {
    const value = response.headers.get(name);
    if (value) {
      headers[name] = value;
    }
  }

  return {
    status: response.status,
    body,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}
