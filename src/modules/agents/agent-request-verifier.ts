import type { Ed25519KeyInput } from "../../infrastructure/crypto/ed25519.js";
import { verifyEd25519 } from "../../infrastructure/crypto/ed25519.js";
import {
  canonicalJson,
  sha256Base64Url,
} from "../../infrastructure/crypto/canonical-json.js";

export interface AgentRequestProof {
  readonly agentId: string;
  readonly keyId: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly signature: string;
}

export interface AgentVerificationKeyResolver {
  resolveAgentPublicKey(
    agentId: string,
    keyId: string,
  ): Promise<Ed25519KeyInput | undefined>;
}

export interface NonceReplayGuard {
  claim(agentId: string, nonce: string, ttlSeconds: number): Promise<boolean>;
}

export interface AgentRequestVerifierOptions {
  readonly maxClockSkewSeconds?: number;
  readonly nonceTtlSeconds?: number;
}

export enum AgentRequestErrorCode {
  IDENTITY_MISMATCH = "AGENT_IDENTITY_MISMATCH",
  UNKNOWN_KEY = "AGENT_KEY_UNKNOWN",
  TIMESTAMP_INVALID = "AGENT_TIMESTAMP_INVALID",
  NONCE_INVALID = "AGENT_NONCE_INVALID",
  SIGNATURE_INVALID = "AGENT_SIGNATURE_INVALID",
  REPLAY_DETECTED = "AGENT_REPLAY_DETECTED",
}

export class AgentRequestError extends Error {
  public constructor(
    public readonly code: AgentRequestErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentRequestError";
  }
}

export interface VerifyAgentRequestInput {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly mandateTokenJtiHash: string;
  readonly idempotencyKey: string;
  readonly apiVersion: string;
  readonly expectedAgentId: string;
  readonly proof: AgentRequestProof;
  readonly now: Date;
}

export interface AgentRequestAuthenticator {
  verify(input: VerifyAgentRequestInput): Promise<void>;
}

export class AgentRequestVerifier implements AgentRequestAuthenticator {
  private readonly maxClockSkewSeconds: number;
  private readonly nonceTtlSeconds: number;

  public constructor(
    private readonly keyResolver: AgentVerificationKeyResolver,
    private readonly replayGuard: NonceReplayGuard,
    options: AgentRequestVerifierOptions = {},
  ) {
    this.maxClockSkewSeconds = options.maxClockSkewSeconds ?? 60;
    this.nonceTtlSeconds = options.nonceTtlSeconds ?? 180;
  }

  public async verify(input: VerifyAgentRequestInput): Promise<void> {
    if (input.proof.agentId !== input.expectedAgentId) {
      throw new AgentRequestError(
        AgentRequestErrorCode.IDENTITY_MISMATCH,
        "Signed request agent does not match the mandate",
      );
    }

    const timestampSeconds = parseUnixTimestamp(input.proof.timestamp);
    const nowSeconds = Math.floor(input.now.getTime() / 1000);
    if (Math.abs(nowSeconds - timestampSeconds) > this.maxClockSkewSeconds) {
      throw new AgentRequestError(
        AgentRequestErrorCode.TIMESTAMP_INVALID,
        "Agent request timestamp is outside the permitted clock window",
      );
    }

    if (!/^[A-Za-z0-9_-]{16,128}$/.test(input.proof.nonce)) {
      throw new AgentRequestError(
        AgentRequestErrorCode.NONCE_INVALID,
        "Agent request nonce is invalid",
      );
    }

    const publicKey = await this.keyResolver.resolveAgentPublicKey(
      input.proof.agentId,
      input.proof.keyId,
    );
    if (!publicKey) {
      throw new AgentRequestError(
        AgentRequestErrorCode.UNKNOWN_KEY,
        "Agent signing key is unknown",
      );
    }

    let signature: Buffer;
    try {
      signature = Buffer.from(input.proof.signature, "base64url");
    } catch {
      throw new AgentRequestError(
        AgentRequestErrorCode.SIGNATURE_INVALID,
        "Agent request signature is malformed",
      );
    }

    const signingPayload = buildAgentSigningPayload({
      method: input.method,
      path: input.path,
      timestamp: input.proof.timestamp,
      nonce: input.proof.nonce,
      body: input.body,
      mandateTokenJtiHash: input.mandateTokenJtiHash,
      idempotencyKey: input.idempotencyKey,
      apiVersion: input.apiVersion,
    });

    if (!verifyEd25519(signingPayload, signature, publicKey)) {
      throw new AgentRequestError(
        AgentRequestErrorCode.SIGNATURE_INVALID,
        "Agent request signature is invalid",
      );
    }

    const claimed = await this.replayGuard.claim(
      input.proof.agentId,
      input.proof.nonce,
      this.nonceTtlSeconds,
    );
    if (!claimed) {
      throw new AgentRequestError(
        AgentRequestErrorCode.REPLAY_DETECTED,
        "Agent request nonce has already been used",
      );
    }
  }
}

export interface AgentSigningPayloadInput {
  readonly method: string;
  readonly path: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly body: unknown;
  readonly mandateTokenJtiHash: string;
  readonly idempotencyKey: string;
  readonly apiVersion: string;
}

export function buildAgentSigningPayload(input: AgentSigningPayloadInput): string {
  const bodyDigest = sha256Base64Url(canonicalJson(input.body));
  return [
    "MINO-AGENT-REQUEST-V1",
    input.method.trim().toUpperCase(),
    normalizePath(input.path),
    input.timestamp,
    input.nonce,
    input.mandateTokenJtiHash,
    input.apiVersion,
    input.idempotencyKey,
    bodyDigest,
  ].join("\n");
}

function parseUnixTimestamp(value: string): number {
  if (!/^\d{10}$/.test(value)) {
    throw new AgentRequestError(
      AgentRequestErrorCode.TIMESTAMP_INVALID,
      "Agent request timestamp must be Unix seconds",
    );
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new AgentRequestError(
      AgentRequestErrorCode.TIMESTAMP_INVALID,
      "Agent request timestamp is invalid",
    );
  }
  return parsed;
}

function normalizePath(path: string): string {
  const index = path.indexOf("?");
  return index === -1 ? path : path.slice(0, index);
}
