export interface StripeProviderResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface StripeRequestContext {
  /** Server-side Stripe API authorization header. Never sourced from agent input. */
  readonly authorization: string;
  /** Connected account that is the execution destination for this request. */
  readonly accountId: string;
}

export interface StripeConfirmPaymentIntentInput extends StripeRequestContext {
  readonly paymentIntentId: string;
  readonly idempotencyKey: string;
  readonly paymentMethod?: string;
  readonly returnUrl?: string;
}

export interface StripeRetrievePaymentIntentInput extends StripeRequestContext {
  readonly paymentIntentId: string;
}

/** Minimal provider client used by Mino's Stripe proof adapters. */
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
    if (!input.idempotencyKey.trim()) {
      throw new Error("Stripe confirmation requires an idempotency key");
    }

    const body = new URLSearchParams();
    if (input.paymentMethod) {
      body.set("payment_method", input.paymentMethod);
    }
    if (input.returnUrl) {
      body.set("return_url", input.returnUrl);
    }

    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/payment_intents/${encodeURIComponent(input.paymentIntentId)}/confirm`,
      {
        method: "POST",
        headers: {
          authorization: input.authorization,
          "stripe-account": input.accountId,
          "idempotency-key": input.idempotencyKey,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
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
        headers: {
          authorization: input.authorization,
          "stripe-account": input.accountId,
        },
      },
    );
    return providerResponse(response);
  }
}

function assertStripeRequestContext(input: StripeRequestContext & { readonly paymentIntentId: string }): void {
  if (!/^\S+\s+\S+$/.test(input.authorization.trim())) {
    throw new Error("Stripe server-side authorization header is required");
  }
  if (!/^acct_[A-Za-z0-9]+$/.test(input.accountId)) {
    throw new Error("Stripe connected account ID is invalid");
  }
  if (!/^pi_[A-Za-z0-9]+$/.test(input.paymentIntentId)) {
    throw new Error("Stripe PaymentIntent ID is invalid");
  }
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
