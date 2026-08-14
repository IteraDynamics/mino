import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson, sha256Base64Url } from "../../infrastructure/crypto/canonical-json.js";

const DEFAULT_MAX_CLOCK_SKEW_SECONDS = 300;

export interface ApprovalResolutionProof {
  readonly approverId: string;
  readonly timestamp: string;
  readonly signature: string;
}

export interface VerifyApprovalResolutionInput {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly proof: ApprovalResolutionProof;
  readonly now: Date;
}

export interface ApprovalResolutionAuthenticator {
  verify(input: VerifyApprovalResolutionInput): Promise<void>;
}

export class ApprovalResolutionAuthError extends Error {
  public constructor(
    public readonly code:
      | "INVALID_APPROVER"
      | "INVALID_TIMESTAMP"
      | "TIMESTAMP_OUT_OF_RANGE"
      | "INVALID_SIGNATURE",
  ) {
    super(code);
    this.name = "ApprovalResolutionAuthError";
  }
}

export interface HmacApprovalResolutionAuthenticatorOptions {
  readonly secret: string;
  readonly maxClockSkewSeconds?: number;
}

export class HmacApprovalResolutionAuthenticator implements ApprovalResolutionAuthenticator {
  private readonly maxClockSkewSeconds: number;

  public constructor(private readonly options: HmacApprovalResolutionAuthenticatorOptions) {
    if (options.secret.length < 32) {
      throw new Error("Approval resolution secret must contain at least 32 characters");
    }
    this.maxClockSkewSeconds = options.maxClockSkewSeconds ?? DEFAULT_MAX_CLOCK_SKEW_SECONDS;
  }

  public async verify(input: VerifyApprovalResolutionInput): Promise<void> {
    const approverId = input.proof.approverId.trim();
    if (!approverId || approverId.length > 255) {
      throw new ApprovalResolutionAuthError("INVALID_APPROVER");
    }

    if (!/^\d{10}$/.test(input.proof.timestamp)) {
      throw new ApprovalResolutionAuthError("INVALID_TIMESTAMP");
    }
    const timestampSeconds = Number(input.proof.timestamp);
    const nowSeconds = Math.floor(input.now.getTime() / 1000);
    if (Math.abs(nowSeconds - timestampSeconds) > this.maxClockSkewSeconds) {
      throw new ApprovalResolutionAuthError("TIMESTAMP_OUT_OF_RANGE");
    }

    const bodyDigest = sha256Base64Url(canonicalJson(input.body ?? null));
    const signingInput = [
      input.proof.timestamp,
      input.method.toUpperCase(),
      input.path,
      approverId,
      bodyDigest,
    ].join("\n");
    const expected = createHmac("sha256", this.options.secret)
      .update(signingInput)
      .digest("hex");

    const actualBuffer = Buffer.from(input.proof.signature.trim().toLowerCase(), "utf8");
    const expectedBuffer = Buffer.from(expected, "utf8");
    if (
      actualBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(actualBuffer, expectedBuffer)
    ) {
      throw new ApprovalResolutionAuthError("INVALID_SIGNATURE");
    }
  }
}
