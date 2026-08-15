import { createPublicKey, verify, type KeyObject } from "node:crypto";

const DEFAULT_CLOCK_SKEW_SECONDS = 60;
const DEFAULT_MAX_TOKEN_BYTES = 16 * 1024;

export interface AdminJwtIssuerConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly verificationKeys: ReadonlyMap<string, string>;
}

export type AdminJwtAuthenticationFailureReason =
  | "AUTHORIZATION_HEADER_INVALID"
  | "TOKEN_TOO_LARGE"
  | "TOKEN_MALFORMED"
  | "ISSUER_NOT_TRUSTED"
  | "KEY_NOT_TRUSTED"
  | "ALGORITHM_NOT_ALLOWED"
  | "SIGNATURE_INVALID"
  | "AUDIENCE_INVALID"
  | "SUBJECT_INVALID"
  | "TOKEN_EXPIRED"
  | "TOKEN_NOT_YET_VALID"
  | "TOKEN_ISSUED_IN_FUTURE";

export type AdminJwtAuthenticationResult =
  | {
      readonly authenticated: true;
      readonly issuer: string;
      readonly subject: string;
    }
  | {
      readonly authenticated: false;
      readonly reason: AdminJwtAuthenticationFailureReason;
    };

export interface AdminBearerAuthenticator {
  authenticateAuthorizationHeader(authorization: string | undefined): AdminJwtAuthenticationResult;
}

interface ParsedJwtHeader {
  readonly alg: string;
  readonly kid: string;
}

interface ParsedJwtPayload {
  readonly iss: string;
  readonly sub: string;
  readonly aud: string | readonly string[];
  readonly exp: number;
  readonly nbf?: number;
  readonly iat?: number;
}

interface TrustedVerificationKey {
  readonly key: KeyObject;
  readonly algorithm: "RS256" | "ES256" | "EdDSA";
}

interface TrustedIssuer {
  readonly audience: string;
  readonly keys: ReadonlyMap<string, TrustedVerificationKey>;
}

export class AdminJwtAuthenticator implements AdminBearerAuthenticator {
  private readonly issuers: ReadonlyMap<string, TrustedIssuer>;
  private readonly clockSkewSeconds: number;
  private readonly maxTokenBytes: number;

  public constructor(
    issuerConfigs: readonly AdminJwtIssuerConfig[],
    private readonly now: () => Date = () => new Date(),
    options: {
      readonly clockSkewSeconds?: number;
      readonly maxTokenBytes?: number;
    } = {},
  ) {
    this.clockSkewSeconds = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
    this.maxTokenBytes = options.maxTokenBytes ?? DEFAULT_MAX_TOKEN_BYTES;
    if (!Number.isSafeInteger(this.clockSkewSeconds) || this.clockSkewSeconds < 0) {
      throw new Error("Admin JWT clock skew must be a non-negative integer number of seconds");
    }
    if (!Number.isSafeInteger(this.maxTokenBytes) || this.maxTokenBytes < 256) {
      throw new Error("Admin JWT maximum token size must be at least 256 bytes");
    }

    const issuers = new Map<string, TrustedIssuer>();
    for (const config of issuerConfigs) {
      if (issuers.has(config.issuer)) {
        throw new Error(`Duplicate admin JWT issuer: ${config.issuer}`);
      }
      if (!config.issuer || !config.audience || config.verificationKeys.size === 0) {
        throw new Error("Admin JWT issuer configuration is incomplete");
      }
      const keys = new Map<string, TrustedVerificationKey>();
      for (const [keyId, pem] of config.verificationKeys) {
        if (!keyId.trim() || keys.has(keyId)) {
          throw new Error("Admin JWT verification key IDs must be unique and non-empty");
        }
        keys.set(keyId, trustedKeyFromPem(pem));
      }
      issuers.set(config.issuer, { audience: config.audience, keys });
    }
    this.issuers = issuers;
  }

  public authenticateAuthorizationHeader(
    authorization: string | undefined,
  ): AdminJwtAuthenticationResult {
    const token = bearerToken(authorization);
    if (!token) {
      return failure("AUTHORIZATION_HEADER_INVALID");
    }
    if (Buffer.byteLength(token, "utf8") > this.maxTokenBytes) {
      return failure("TOKEN_TOO_LARGE");
    }

    const segments = token.split(".");
    if (segments.length !== 3 || segments.some((segment) => !isBase64Url(segment))) {
      return failure("TOKEN_MALFORMED");
    }
    const [encodedHeader, encodedPayload, encodedSignature] = segments as [string, string, string];

    const header = parseHeader(encodedHeader);
    const payload = parsePayload(encodedPayload);
    if (!header || !payload) {
      return failure("TOKEN_MALFORMED");
    }

    const issuer = this.issuers.get(payload.iss);
    if (!issuer) {
      return failure("ISSUER_NOT_TRUSTED");
    }
    const trustedKey = issuer.keys.get(header.kid);
    if (!trustedKey) {
      return failure("KEY_NOT_TRUSTED");
    }
    if (header.alg !== trustedKey.algorithm) {
      return failure("ALGORITHM_NOT_ALLOWED");
    }

    const signingInput = Buffer.from(`${encodedHeader}.${encodedPayload}`, "ascii");
    const signature = Buffer.from(encodedSignature, "base64url");
    if (!verifyJwtSignature(header.alg, signingInput, trustedKey.key, signature)) {
      return failure("SIGNATURE_INVALID");
    }

    if (!audienceContains(payload.aud, issuer.audience)) {
      return failure("AUDIENCE_INVALID");
    }
    if (!payload.sub.trim()) {
      return failure("SUBJECT_INVALID");
    }

    const nowSeconds = Math.floor(this.now().getTime() / 1_000);
    if (payload.exp <= nowSeconds - this.clockSkewSeconds) {
      return failure("TOKEN_EXPIRED");
    }
    if (payload.nbf !== undefined && payload.nbf > nowSeconds + this.clockSkewSeconds) {
      return failure("TOKEN_NOT_YET_VALID");
    }
    if (payload.iat !== undefined && payload.iat > nowSeconds + this.clockSkewSeconds) {
      return failure("TOKEN_ISSUED_IN_FUTURE");
    }

    return {
      authenticated: true,
      issuer: payload.iss,
      subject: payload.sub,
    };
  }
}

function trustedKeyFromPem(pem: string): TrustedVerificationKey {
  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch {
    throw new Error("Admin JWT verification keys must contain valid public PEM keys");
  }

  switch (key.asymmetricKeyType) {
    case "rsa":
      return { key, algorithm: "RS256" };
    case "ec": {
      const details = key.asymmetricKeyDetails as { namedCurve?: string } | undefined;
      if (details?.namedCurve !== "prime256v1" && details?.namedCurve !== "P-256") {
        throw new Error("Admin JWT EC verification keys must use P-256");
      }
      return { key, algorithm: "ES256" };
    }
    case "ed25519":
      return { key, algorithm: "EdDSA" };
    default:
      throw new Error("Admin JWT verification keys must be RSA, P-256 EC, or Ed25519 public keys");
  }
}

function bearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) {
    return undefined;
  }
  const match = /^Bearer ([^\s,]+)$/i.exec(authorization);
  return match?.[1];
}

function parseHeader(encoded: string): ParsedJwtHeader | undefined {
  const value = parseJsonObject(encoded);
  if (!value || typeof value.alg !== "string" || typeof value.kid !== "string") {
    return undefined;
  }
  if (!value.alg.trim() || !value.kid.trim() || value.kid.length > 256) {
    return undefined;
  }
  return { alg: value.alg, kid: value.kid };
}

function parsePayload(encoded: string): ParsedJwtPayload | undefined {
  const value = parseJsonObject(encoded);
  if (
    !value ||
    typeof value.iss !== "string" ||
    typeof value.sub !== "string" ||
    !validAudience(value.aud) ||
    !validNumericDate(value.exp) ||
    (value.nbf !== undefined && !validNumericDate(value.nbf)) ||
    (value.iat !== undefined && !validNumericDate(value.iat))
  ) {
    return undefined;
  }

  return {
    iss: value.iss,
    sub: value.sub,
    aud: value.aud,
    exp: value.exp,
    ...(value.nbf !== undefined ? { nbf: value.nbf } : {}),
    ...(value.iat !== undefined ? { iat: value.iat } : {}),
  };
}

function parseJsonObject(encoded: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function verifyJwtSignature(
  algorithm: string,
  signingInput: Buffer,
  key: KeyObject,
  signature: Buffer,
): boolean {
  try {
    switch (algorithm) {
      case "RS256":
        return verify("RSA-SHA256", signingInput, key, signature);
      case "ES256":
        return verify(
          "sha256",
          signingInput,
          { key, dsaEncoding: "ieee-p1363" },
          signature,
        );
      case "EdDSA":
        return verify(null, signingInput, key, signature);
      default:
        return false;
    }
  } catch {
    return false;
  }
}

function audienceContains(audience: string | readonly string[], expected: string): boolean {
  return typeof audience === "string" ? audience === expected : audience.includes(expected);
}

function validAudience(value: unknown): value is string | readonly string[] {
  if (typeof value === "string") {
    return value.length > 0;
  }
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "string" && entry.length > 0)
  );
}

function validNumericDate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isSafeInteger(value);
}

function isBase64Url(value: string): boolean {
  return value.length > 0 && /^[A-Za-z0-9_-]+$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(reason: AdminJwtAuthenticationFailureReason): AdminJwtAuthenticationResult {
  return { authenticated: false, reason };
}
