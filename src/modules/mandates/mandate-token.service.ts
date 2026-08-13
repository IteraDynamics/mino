import type { Ed25519KeyInput } from "../../infrastructure/crypto/ed25519.js";
import {
  constantTimeStringEquals,
  signEd25519,
  verifyEd25519,
} from "../../infrastructure/crypto/ed25519.js";
import { sha256Hex } from "../../infrastructure/crypto/canonical-json.js";
import type {
  AgentSpendMandate,
  MandateTokenClaims,
} from "../../domain/mandates/mandate.types.js";

export interface MandateSigningKey {
  readonly keyId: string;
  readonly privateKey: Ed25519KeyInput;
}

export interface MandateVerificationKeyResolver {
  resolvePublicKey(keyId: string): Promise<Ed25519KeyInput | undefined>;
}

export interface MandateTokenServiceOptions {
  readonly issuer: string;
  readonly audience?: string;
  readonly clockSkewSeconds?: number;
}

export enum MandateTokenErrorCode {
  MALFORMED = "MANDATE_TOKEN_MALFORMED",
  UNSUPPORTED_HEADER = "MANDATE_TOKEN_UNSUPPORTED_HEADER",
  UNKNOWN_KEY = "MANDATE_TOKEN_UNKNOWN_KEY",
  INVALID_SIGNATURE = "MANDATE_TOKEN_INVALID_SIGNATURE",
  INVALID_CLAIMS = "MANDATE_TOKEN_INVALID_CLAIMS",
  NOT_YET_VALID = "MANDATE_TOKEN_NOT_YET_VALID",
  EXPIRED = "MANDATE_TOKEN_EXPIRED",
  BINDING_MISMATCH = "MANDATE_TOKEN_BINDING_MISMATCH",
}

export class MandateTokenError extends Error {
  public constructor(
    public readonly code: MandateTokenErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MandateTokenError";
  }
}

interface CompactHeader {
  readonly alg: "EdDSA";
  readonly typ: "mino+mandate+jwt";
  readonly kid: string;
  readonly v: 1;
}

export class MandateTokenService {
  private readonly issuer: string;
  private readonly audience: string;
  private readonly clockSkewSeconds: number;

  public constructor(
    private readonly keyResolver: MandateVerificationKeyResolver,
    options: MandateTokenServiceOptions,
  ) {
    this.issuer = options.issuer;
    this.audience = options.audience ?? "mino";
    this.clockSkewSeconds = options.clockSkewSeconds ?? 5;
  }

  public issue(claims: MandateTokenClaims, signingKey: MandateSigningKey): string {
    validateClaimsShape(claims);

    const header: CompactHeader = {
      alg: "EdDSA",
      typ: "mino+mandate+jwt",
      kid: signingKey.keyId,
      v: 1,
    };

    const encodedHeader = encodeJson(header);
    const encodedClaims = encodeJson(claims);
    const signingInput = `${encodedHeader}.${encodedClaims}`;
    const signature = signEd25519(signingInput, signingKey.privateKey);

    return `${signingInput}.${signature.toString("base64url")}`;
  }

  public async verify(token: string, now: Date): Promise<VerifiedMandateToken> {
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
      throw new MandateTokenError(
        MandateTokenErrorCode.MALFORMED,
        "Mandate token must use compact three-part encoding",
      );
    }

    const [encodedHeader, encodedClaims, encodedSignature] = parts;
    if (!encodedHeader || !encodedClaims || !encodedSignature) {
      throw new MandateTokenError(MandateTokenErrorCode.MALFORMED, "Malformed mandate token");
    }

    const header = decodeHeader(encodedHeader);
    const claims = decodeClaims(encodedClaims);

    if (
      header.alg !== "EdDSA" ||
      header.typ !== "mino+mandate+jwt" ||
      header.v !== 1 ||
      !header.kid
    ) {
      throw new MandateTokenError(
        MandateTokenErrorCode.UNSUPPORTED_HEADER,
        "Mandate token header is not supported",
      );
    }

    const publicKey = await this.keyResolver.resolvePublicKey(header.kid);
    if (!publicKey) {
      throw new MandateTokenError(
        MandateTokenErrorCode.UNKNOWN_KEY,
        "Mandate token signing key is unknown",
      );
    }

    let signature: Buffer;
    try {
      signature = Buffer.from(encodedSignature, "base64url");
    } catch {
      throw new MandateTokenError(
        MandateTokenErrorCode.MALFORMED,
        "Mandate token signature is malformed",
      );
    }

    const signingInput = `${encodedHeader}.${encodedClaims}`;
    if (!verifyEd25519(signingInput, signature, publicKey)) {
      throw new MandateTokenError(
        MandateTokenErrorCode.INVALID_SIGNATURE,
        "Mandate token signature is invalid",
      );
    }

    this.validateTemporalAndAudienceClaims(claims, now);

    return {
      header,
      claims,
      tokenJtiHash: sha256Hex(claims.jti),
    };
  }

  public assertBoundToMandate(
    verified: VerifiedMandateToken,
    mandate: AgentSpendMandate,
  ): void {
    const { claims, header, tokenJtiHash } = verified;
    const matches =
      claims.mandateId === mandate.id &&
      claims.organizationId === mandate.organizationId &&
      claims.userId === mandate.userId &&
      claims.agentId === mandate.agentId &&
      claims.sub === mandate.agentId &&
      claims.policyVersion === mandate.policyVersion &&
      header.kid === mandate.signingKeyId &&
      constantTimeStringEquals(tokenJtiHash, mandate.tokenJtiHash) &&
      claims.exp * 1000 <= mandate.expiresAt.getTime();

    if (!matches) {
      throw new MandateTokenError(
        MandateTokenErrorCode.BINDING_MISMATCH,
        "Mandate token does not match the active mandate snapshot",
      );
    }
  }

  private validateTemporalAndAudienceClaims(
    claims: MandateTokenClaims,
    now: Date,
  ): void {
    validateClaimsShape(claims);

    if (claims.iss !== this.issuer || claims.aud !== this.audience) {
      throw new MandateTokenError(
        MandateTokenErrorCode.INVALID_CLAIMS,
        "Mandate token issuer or audience is invalid",
      );
    }

    const nowSeconds = Math.floor(now.getTime() / 1000);
    const skew = this.clockSkewSeconds;

    if (claims.nbf > nowSeconds + skew || claims.iat > nowSeconds + skew) {
      throw new MandateTokenError(
        MandateTokenErrorCode.NOT_YET_VALID,
        "Mandate token is not yet valid",
      );
    }

    if (claims.exp <= nowSeconds - skew) {
      throw new MandateTokenError(
        MandateTokenErrorCode.EXPIRED,
        "Mandate token has expired",
      );
    }

    if (claims.exp <= claims.nbf || claims.iat > claims.exp) {
      throw new MandateTokenError(
        MandateTokenErrorCode.INVALID_CLAIMS,
        "Mandate token temporal claims are inconsistent",
      );
    }
  }
}

export interface VerifiedMandateToken {
  readonly header: CompactHeader;
  readonly claims: MandateTokenClaims;
  readonly tokenJtiHash: string;
}

function validateClaimsShape(claims: MandateTokenClaims): void {
  const stringFields: Array<keyof MandateTokenClaims> = [
    "iss",
    "sub",
    "aud",
    "jti",
    "organizationId",
    "userId",
    "agentId",
    "mandateId",
  ];

  for (const field of stringFields) {
    const value = claims[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new MandateTokenError(
        MandateTokenErrorCode.INVALID_CLAIMS,
        `Mandate token claim ${field} is invalid`,
      );
    }
  }

  for (const field of ["policyVersion", "iat", "nbf", "exp"] as const) {
    const value = claims[field];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new MandateTokenError(
        MandateTokenErrorCode.INVALID_CLAIMS,
        `Mandate token claim ${field} is invalid`,
      );
    }
  }
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeHeader(encoded: string): CompactHeader {
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<CompactHeader>;
    return parsed as CompactHeader;
  } catch {
    throw new MandateTokenError(MandateTokenErrorCode.MALFORMED, "Mandate token header is malformed");
  }
}

function decodeClaims(encoded: string): MandateTokenClaims {
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as MandateTokenClaims;
    validateClaimsShape(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof MandateTokenError) {
      throw error;
    }
    throw new MandateTokenError(MandateTokenErrorCode.MALFORMED, "Mandate token claims are malformed");
  }
}
