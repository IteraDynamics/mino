export interface MerchantEndpoint {
  readonly id: string;
  readonly domain: string;
  readonly vendorId?: string;
  readonly baseUrl: string;
  readonly active: boolean;
}

export interface MerchantRegistry {
  getById(organizationId: string, merchantId: string): Promise<MerchantEndpoint | undefined>;
}

export interface MerchantRequestHeaders {
  readonly authorization: string;
  readonly apiVersion: string;
  readonly idempotencyKey?: string;
  readonly requestId: string;
  readonly delegationAssertion?: string;
}

export interface MerchantResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ACPMerchantClient {
  createCheckout(
    merchant: MerchantEndpoint,
    payload: unknown,
    headers: MerchantRequestHeaders,
  ): Promise<MerchantResponse>;

  getCheckout(
    merchant: MerchantEndpoint,
    checkoutSessionId: string,
    headers: MerchantRequestHeaders,
  ): Promise<MerchantResponse>;

  completeCheckout(
    merchant: MerchantEndpoint,
    checkoutSessionId: string,
    payload: unknown,
    headers: MerchantRequestHeaders,
  ): Promise<MerchantResponse>;

  cancelCheckout(
    merchant: MerchantEndpoint,
    checkoutSessionId: string,
    headers: MerchantRequestHeaders,
  ): Promise<MerchantResponse>;
}

export class FetchACPMerchantClient implements ACPMerchantClient {
  public async createCheckout(
    merchant: MerchantEndpoint,
    payload: unknown,
    headers: MerchantRequestHeaders,
  ): Promise<MerchantResponse> {
    return this.request(merchant, "/checkout_sessions", "POST", payload, headers);
  }

  public async getCheckout(
    merchant: MerchantEndpoint,
    checkoutSessionId: string,
    headers: MerchantRequestHeaders,
  ): Promise<MerchantResponse> {
    return this.request(
      merchant,
      `/checkout_sessions/${encodeURIComponent(checkoutSessionId)}`,
      "GET",
      undefined,
      headers,
    );
  }

  public async completeCheckout(
    merchant: MerchantEndpoint,
    checkoutSessionId: string,
    payload: unknown,
    headers: MerchantRequestHeaders,
  ): Promise<MerchantResponse> {
    return this.request(
      merchant,
      `/checkout_sessions/${encodeURIComponent(checkoutSessionId)}/complete`,
      "POST",
      payload,
      headers,
    );
  }

  public async cancelCheckout(
    merchant: MerchantEndpoint,
    checkoutSessionId: string,
    headers: MerchantRequestHeaders,
  ): Promise<MerchantResponse> {
    return this.request(
      merchant,
      `/checkout_sessions/${encodeURIComponent(checkoutSessionId)}/cancel`,
      "POST",
      {},
      headers,
    );
  }

  private async request(
    merchant: MerchantEndpoint,
    path: string,
    method: "GET" | "POST",
    payload: unknown,
    headers: MerchantRequestHeaders,
  ): Promise<MerchantResponse> {
    assertSafeMerchantEndpoint(merchant);
    const target = new URL(path.replace(/^\//, ""), ensureTrailingSlash(merchant.baseUrl));
    if (target.hostname.toLowerCase() !== merchant.domain.toLowerCase()) {
      throw new Error("Merchant registry base URL hostname does not match merchant domain");
    }

    const response = await fetch(target, {
      method,
      redirect: "error",
      headers: {
        Authorization: headers.authorization,
        "API-Version": headers.apiVersion,
        "Request-Id": headers.requestId,
        ...(headers.idempotencyKey ? { "Idempotency-Key": headers.idempotencyKey } : {}),
        ...(headers.delegationAssertion
          ? { "Mino-Delegation-Assertion": headers.delegationAssertion }
          : {}),
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(10_000),
    });

    const text = await response.text();
    let body: unknown = undefined;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }
    }

    return {
      status: response.status,
      body,
      headers: Object.fromEntries(response.headers.entries()),
    };
  }
}

function assertSafeMerchantEndpoint(merchant: MerchantEndpoint): void {
  const url = new URL(merchant.baseUrl);
  if (url.protocol !== "https:") {
    throw new Error("Merchant base URL must use HTTPS");
  }
  if (!merchant.active) {
    throw new Error("Merchant endpoint is disabled");
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
