import { ACP_STABLE_VERSION } from "./acp-adapter.js";
import {
  normalizeMerchantRoutingTarget,
  type NormalizedMerchantRoutingTarget,
} from "./merchant-routing.js";

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
  readonly requestId: string;
  readonly idempotencyKey?: string;
  readonly apiVersion: string;
  readonly authorization: string;
  readonly delegationAssertion?: string;
}

export interface MerchantResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: unknown;
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
  /**
   * ACP update-checkout support. Optional on older in-process test doubles; the
   * production FetchACPMerchantClient implements it and lifecycle composition
   * requires it.
   */
  updateCheckout?(
    merchant: MerchantEndpoint,
    checkoutSessionId: string,
    payload: unknown,
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
    payload?: unknown,
  ): Promise<MerchantResponse>;
}

export interface FetchACPMerchantClientOptions {
  readonly timeoutMs?: number;
}

export class FetchACPMerchantClient implements ACPMerchantClient {
  private readonly timeoutMs: number;

  public constructor(options: FetchACPMerchantClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

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

  public async updateCheckout(
    merchant: MerchantEndpoint,
    checkoutSessionId: string,
    payload: unknown,
    headers: MerchantRequestHeaders,
  ): Promise<MerchantResponse> {
    return this.request(
      merchant,
      `/checkout_sessions/${encodeURIComponent(checkoutSessionId)}`,
      "POST",
      payload,
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
    payload: unknown = {},
  ): Promise<MerchantResponse> {
    return this.request(
      merchant,
      `/checkout_sessions/${encodeURIComponent(checkoutSessionId)}/cancel`,
      "POST",
      payload,
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
    if (headers.apiVersion !== ACP_STABLE_VERSION) {
      throw new Error("Refusing to send an unsupported ACP API version");
    }
    const registered = assertRegisteredHttpsTarget(merchant);

    const target = new URL(path, ensureTrailingSlash(registered.baseUrl));
    if (target.hostname.toLowerCase() !== registered.domain) {
      throw new Error("Resolved merchant target does not match registered domain");
    }

    const requestHeaders: Record<string, string> = {
      "API-Version": headers.apiVersion,
      Authorization: headers.authorization,
      "Request-Id": headers.requestId,
    };
    if (headers.idempotencyKey) {
      requestHeaders["Idempotency-Key"] = headers.idempotencyKey;
    }
    if (headers.delegationAssertion) {
      requestHeaders["Mino-Delegation-Assertion"] = headers.delegationAssertion;
    }
    if (payload !== undefined) {
      requestHeaders["Content-Type"] = "application/json";
    }

    const response = await fetch(target, {
      method,
      headers: requestHeaders,
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });

    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json")
      ? await response.json()
      : await response.text();

    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    };
  }
}

export function assertRegisteredHttpsTarget(
  merchant: MerchantEndpoint,
): NormalizedMerchantRoutingTarget {
  if (!merchant.active) {
    throw new Error("Merchant is inactive");
  }
  return normalizeMerchantRoutingTarget(merchant.domain, merchant.baseUrl);
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
