import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  type KeyObject,
} from "node:crypto";
import type { Ed25519KeyInput } from "../infrastructure/crypto/ed25519.js";
import { signEd25519 } from "../infrastructure/crypto/ed25519.js";
import { sha256Hex } from "../infrastructure/crypto/canonical-json.js";
import {
  buildAgentSigningPayload,
  type AgentRequestProof,
} from "../modules/agents/agent-request-verifier.js";
import { ACP_STABLE_VERSION } from "../modules/proxy/acp-adapter.js";

export const MINO_ACP_API_VERSION = ACP_STABLE_VERSION;

export interface GeneratedAgentKeyPair {
  readonly keyId: string;
  readonly publicKeyPem: string;
  readonly privateKeyPem: string;
}

export function generateEd25519AgentKeyPair(keyId = `agent-k-${randomUUID()}`): GeneratedAgentKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    keyId,
    publicKeyPem: exportPublicKey(publicKey),
    privateKeyPem: exportPrivateKey(privateKey),
  };
}

export function createMinoIdempotencyKey(): string {
  return randomUUID();
}

export interface MinoAgentRequestSignerOptions {
  readonly agentId: string;
  readonly keyId: string;
  readonly privateKey: Ed25519KeyInput;
  readonly mandateToken: string;
  readonly now?: () => Date;
  readonly nonce?: () => string;
}

export interface SignMinoAgentRequestInput {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly idempotencyKey: string;
  readonly apiVersion: string;
}

export interface SignedMinoAgentRequest {
  readonly proof: AgentRequestProof;
  readonly signingPayload: string;
  readonly headers: Readonly<Record<string, string>>;
}

interface ClientMandateBinding {
  readonly mandateId: string;
  readonly agentId: string;
  readonly tokenJtiHash: string;
}

/**
 * Reference Node.js signer for Mino's existing agent-proof protocol.
 *
 * This helper does not verify the mandate token and is not an authorization authority.
 * Mino still verifies the token signature, issuer, audience, time window, durable mandate
 * snapshot, current beneficiary/agent/policy state, nonce replay, and policy on the server.
 */
export class MinoAgentRequestSigner {
  private readonly now: () => Date;
  private readonly nonce: () => string;
  private readonly binding: ClientMandateBinding;

  public constructor(private readonly options: MinoAgentRequestSignerOptions) {
    if (!options.agentId.trim()) throw new Error("agentId is required");
    if (!options.keyId.trim()) throw new Error("keyId is required");
    if (!options.mandateToken.trim()) throw new Error("mandateToken is required");

    this.binding = readMandateBinding(options.mandateToken);
    if (this.binding.agentId !== options.agentId) {
      throw new Error("Mandate token is bound to a different agent identity");
    }

    this.now = options.now ?? (() => new Date());
    this.nonce = options.nonce ?? (() => randomBytes(18).toString("base64url"));
  }

  public get mandateId(): string {
    return this.binding.mandateId;
  }

  public sign(input: SignMinoAgentRequestInput): SignedMinoAgentRequest {
    const timestamp = String(Math.floor(this.now().getTime() / 1000));
    const nonce = this.nonce();
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
      throw new Error("Generated agent nonce does not satisfy Mino's replay-proof format");
    }

    const signingPayload = buildAgentSigningPayload({
      method: input.method,
      path: input.path,
      timestamp,
      nonce,
      body: input.body,
      mandateTokenJtiHash: this.binding.tokenJtiHash,
      idempotencyKey: input.idempotencyKey,
      apiVersion: input.apiVersion,
    });
    const signature = signEd25519(signingPayload, this.options.privateKey).toString("base64url");
    const proof: AgentRequestProof = {
      agentId: this.options.agentId,
      keyId: this.options.keyId,
      timestamp,
      nonce,
      signature,
    };

    return {
      proof,
      signingPayload,
      headers: {
        "x-mino-mandate-token": this.options.mandateToken,
        "x-mino-agent-id": proof.agentId,
        "x-mino-agent-key-id": proof.keyId,
        "x-mino-agent-timestamp": proof.timestamp,
        "x-mino-agent-nonce": proof.nonce,
        "x-mino-agent-signature": proof.signature,
      },
    };
  }
}

export type MinoAgentOperation =
  | "CREATE_CHECKOUT"
  | "RETRIEVE_CHECKOUT"
  | "UPDATE_CHECKOUT"
  | "CANCEL_CHECKOUT"
  | "COMPLETE_CHECKOUT";

export type MinoAgentResponseKind =
  | "success"
  | "blocked"
  | "approval_required"
  | "payment_pending"
  | "idempotency_conflict"
  | "unauthorized"
  | "protocol_error"
  | "upstream_error"
  | "error";

export type MinoRetryMode =
  | "none"
  | "after_approval_same_request"
  | "after_delay_same_request";

export interface MinoRetryAdvice {
  readonly mode: MinoRetryMode;
  readonly reuseIdempotencyKey: boolean;
  readonly freshAgentProof: boolean;
  readonly retryAfterMs?: number;
}

export interface MinoAgentResponse<TBody = unknown> {
  readonly operation: MinoAgentOperation;
  readonly status: number;
  readonly kind: MinoAgentResponseKind;
  readonly body: TBody;
  readonly idempotencyKey: string;
  readonly retry: MinoRetryAdvice;
}

export interface MinoFetchLike {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

export interface MinoACPAgentClientOptions extends MinoAgentRequestSignerOptions {
  readonly baseUrl: string;
  /** Full merchant/upstream ACP Authorization value, e.g. `Bearer merchant-secret`. */
  readonly merchantAuthorization: string;
  readonly fetchImpl?: MinoFetchLike;
}

export class MinoAgentTransportError extends Error {
  public constructor(
    message: string,
    public readonly operation: MinoAgentOperation,
    public readonly idempotencyKey: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MinoAgentTransportError";
  }
}

/**
 * Minimal Node.js reference client for Mino's current ACP edge.
 *
 * The client deliberately does not auto-retry mutations. Callers keep semantic retry
 * control and must reuse the exact idempotency key/body/path when retrying an approved
 * or unresolved completion. Every call creates a fresh nonce/timestamp/signature.
 */
export class MinoACPAgentClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: MinoFetchLike;
  private readonly signer: MinoAgentRequestSigner;

  public constructor(private readonly options: MinoACPAgentClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    if (!/^Bearer\s+\S+$/i.test(options.merchantAuthorization.trim())) {
      throw new Error("merchantAuthorization must use Bearer authentication");
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.signer = new MinoAgentRequestSigner(options);
  }

  public createCheckout<TBody = unknown>(
    merchantId: string,
    body: unknown,
    idempotencyKey: string,
  ): Promise<MinoAgentResponse<TBody>> {
    return this.request<TBody>({
      operation: "CREATE_CHECKOUT",
      method: "POST",
      path: `/v1/acp/${segment(merchantId)}/checkout_sessions`,
      body: body ?? {},
      idempotencyKey: requiredIdempotencyKey(idempotencyKey),
    });
  }

  public retrieveCheckout<TBody = unknown>(
    merchantId: string,
    checkoutSessionId: string,
  ): Promise<MinoAgentResponse<TBody>> {
    return this.request<TBody>({
      operation: "RETRIEVE_CHECKOUT",
      method: "GET",
      path: `/v1/acp/${segment(merchantId)}/checkout_sessions/${segment(checkoutSessionId)}`,
      body: null,
      idempotencyKey: "",
    });
  }

  public updateCheckout<TBody = unknown>(
    merchantId: string,
    checkoutSessionId: string,
    body: unknown,
    idempotencyKey: string,
  ): Promise<MinoAgentResponse<TBody>> {
    return this.request<TBody>({
      operation: "UPDATE_CHECKOUT",
      method: "POST",
      path: `/v1/acp/${segment(merchantId)}/checkout_sessions/${segment(checkoutSessionId)}`,
      body: body ?? {},
      idempotencyKey: requiredIdempotencyKey(idempotencyKey),
    });
  }

  public cancelCheckout<TBody = unknown>(
    merchantId: string,
    checkoutSessionId: string,
    body: unknown,
    idempotencyKey: string,
  ): Promise<MinoAgentResponse<TBody>> {
    return this.request<TBody>({
      operation: "CANCEL_CHECKOUT",
      method: "POST",
      path: `/v1/acp/${segment(merchantId)}/checkout_sessions/${segment(checkoutSessionId)}/cancel`,
      body: body ?? {},
      idempotencyKey: requiredIdempotencyKey(idempotencyKey),
    });
  }

  public completeCheckout<TBody = unknown>(
    merchantId: string,
    checkoutSessionId: string,
    body: unknown,
    idempotencyKey: string,
  ): Promise<MinoAgentResponse<TBody>> {
    return this.request<TBody>({
      operation: "COMPLETE_CHECKOUT",
      method: "POST",
      path: `/v1/acp/${segment(merchantId)}/checkout_sessions/${segment(checkoutSessionId)}/complete`,
      body: body ?? {},
      idempotencyKey: requiredIdempotencyKey(idempotencyKey),
    });
  }

  private async request<TBody>(input: {
    readonly operation: MinoAgentOperation;
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly body: unknown;
    readonly idempotencyKey: string;
  }): Promise<MinoAgentResponse<TBody>> {
    const signed = this.signer.sign({
      method: input.method,
      path: input.path,
      body: input.body,
      idempotencyKey: input.idempotencyKey,
      apiVersion: MINO_ACP_API_VERSION,
    });

    const headers = new Headers({
      accept: "application/json",
      authorization: this.options.merchantAuthorization.trim(),
      "api-version": MINO_ACP_API_VERSION,
      ...signed.headers,
    });
    let requestBody: string | undefined;
    if (input.method !== "GET") {
      headers.set("content-type", "application/json");
      headers.set("idempotency-key", input.idempotencyKey);
      requestBody = JSON.stringify(input.body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${input.path}`, {
        method: input.method,
        headers,
        ...(requestBody === undefined ? {} : { body: requestBody }),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
    } catch (cause) {
      throw new MinoAgentTransportError(
        "Mino request transport failed; outcome may be unknown, so do not mint a new idempotency key for the same semantic mutation",
        input.operation,
        input.idempotencyKey,
        { cause },
      );
    }

    const body = await readResponseBody(response) as TBody;
    return {
      operation: input.operation,
      status: response.status,
      kind: classifyResponse(input.operation, response.status, body),
      body,
      idempotencyKey: input.idempotencyKey,
      retry: retryAdvice(input.operation, response.status, body, response.headers),
    };
  }
}

function classifyResponse(
  operation: MinoAgentOperation,
  status: number,
  body: unknown,
): MinoAgentResponseKind {
  const record = asRecord(body);
  const decision = asRecord(record?.decision);
  const verdict = typeof decision?.verdict === "string" ? decision.verdict : undefined;
  const error = typeof record?.error === "string" ? record.error : undefined;

  if (verdict === "PENDING_HUMAN_APPROVAL" || status === 202) return "approval_required";
  if (verdict === "BLOCK" || status === 403) return "blocked";
  if (status === 409 && error === "PAYMENT_OUTCOME_PENDING" && operation === "COMPLETE_CHECKOUT") {
    return "payment_pending";
  }
  if (status === 409 && error === "IDEMPOTENCY_CONFLICT") return "idempotency_conflict";
  if (status === 401) return "unauthorized";
  if (status === 400) return "protocol_error";
  if (status === 502) return "upstream_error";
  if (status >= 200 && status < 300) return "success";
  return "error";
}

function retryAdvice(
  operation: MinoAgentOperation,
  status: number,
  body: unknown,
  headers: Headers,
): MinoRetryAdvice {
  const kind = classifyResponse(operation, status, body);
  if (operation === "COMPLETE_CHECKOUT" && kind === "approval_required") {
    return {
      mode: "after_approval_same_request",
      reuseIdempotencyKey: true,
      freshAgentProof: true,
    };
  }
  if (operation === "COMPLETE_CHECKOUT" && kind === "payment_pending") {
    const retryAfterMs = parseRetryAfterMs(headers.get("retry-after"));
    return {
      mode: "after_delay_same_request",
      reuseIdempotencyKey: true,
      freshAgentProof: true,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  }
  return {
    mode: "none",
    reuseIdempotencyKey: false,
    freshAgentProof: false,
  };
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

function readMandateBinding(token: string): ClientMandateBinding {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) {
    throw new Error("Mandate token must use compact three-part encoding");
  }

  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("Mandate token claims are malformed");
  }

  const jti = requiredStringClaim(claims, "jti");
  const agentId = requiredStringClaim(claims, "agentId");
  const subject = requiredStringClaim(claims, "sub");
  const mandateId = requiredStringClaim(claims, "mandateId");
  if (subject !== agentId) {
    throw new Error("Mandate token subject and agent binding disagree");
  }

  return {
    mandateId,
    agentId,
    tokenJtiHash: sha256Hex(jti),
  };
}

function requiredStringClaim(claims: Record<string, unknown>, name: string): string {
  const value = claims[name];
  if (typeof value !== "string" || !value) {
    throw new Error(`Mandate token claim ${name} is missing`);
  }
  return value;
}

function normalizeBaseUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Mino baseUrl must use HTTP or HTTPS");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Mino baseUrl must be a plain origin/base path without credentials, query, or fragment");
  }
  return parsed.toString().replace(/\/$/, "");
}

function requiredIdempotencyKey(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 255) {
    throw new Error("A stable idempotency key of 1-255 characters is required");
  }
  return normalized;
}

function segment(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("Route identifier is required");
  return encodeURIComponent(normalized);
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds)) return undefined;
  return seconds * 1000;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function exportPublicKey(key: KeyObject): string {
  return key.export({ type: "spki", format: "pem" }).toString();
}

function exportPrivateKey(key: KeyObject): string {
  return key.export({ type: "pkcs8", format: "pem" }).toString();
}
