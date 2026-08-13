import type { Ed25519KeyInput } from "../../infrastructure/crypto/ed25519.js";
import { signEd25519 } from "../../infrastructure/crypto/ed25519.js";
import {
  canonicalJson,
  sha256Base64Url,
} from "../../infrastructure/crypto/canonical-json.js";
import type { CheckoutIntent } from "../../domain/checkout/checkout.types.js";
import type { PolicyDecision } from "../../domain/evaluation/evaluation.types.js";

export interface DelegationSigningKey {
  readonly keyId: string;
  readonly privateKey: Ed25519KeyInput;
}

export interface DelegationAssertionServiceOptions {
  readonly issuer: string;
  readonly ttlSeconds?: number;
}

interface DelegationHeader {
  readonly alg: "EdDSA";
  readonly typ: "mino+delegation+jwt";
  readonly kid: string;
  readonly v: 1;
}

export interface DelegationAssertionClaims {
  readonly iss: string;
  readonly aud: string;
  readonly sub: string;
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
  readonly organization_id: string;
  readonly user_id: string;
  readonly agent_id: string;
  readonly mandate_id: string;
  readonly decision_id: string;
  readonly request_id: string;
  readonly merchant_domain: string;
  readonly amount_minor: string;
  readonly currency: string;
  readonly idempotency_digest: string;
  readonly checkout_digest: string;
  readonly scope: "acp:complete_checkout";
}

export interface DelegationAssertionIssuer {
  issue(intent: CheckoutIntent, decision: PolicyDecision, now: Date): string;
}

export class DelegationAssertionService implements DelegationAssertionIssuer {
  private readonly ttlSeconds: number;

  public constructor(
    private readonly signingKey: DelegationSigningKey,
    private readonly generateId: () => string,
    private readonly options: DelegationAssertionServiceOptions,
  ) {
    this.ttlSeconds = options.ttlSeconds ?? 45;
  }

  public issue(intent: CheckoutIntent, decision: PolicyDecision, now: Date): string {
    if (!decision.eligibleForDelegationAssertion || !decision.approvedAmount) {
      throw new Error("Delegation assertions can only be issued for allowed decisions");
    }

    const issuedAt = Math.floor(now.getTime() / 1000);
    const header: DelegationHeader = {
      alg: "EdDSA",
      typ: "mino+delegation+jwt",
      kid: this.signingKey.keyId,
      v: 1,
    };
    const claims: DelegationAssertionClaims = {
      iss: this.options.issuer,
      aud: intent.merchant.domain,
      sub: intent.agentId,
      jti: this.generateId(),
      iat: issuedAt,
      exp: issuedAt + this.ttlSeconds,
      organization_id: intent.organizationId,
      user_id: intent.userId,
      agent_id: intent.agentId,
      mandate_id: decision.mandateId,
      decision_id: decision.decisionId,
      request_id: intent.requestId,
      merchant_domain: intent.merchant.domain,
      amount_minor: decision.approvedAmount.minorUnits.toString(10),
      currency: decision.approvedAmount.currency,
      idempotency_digest: sha256Base64Url(intent.idempotencyKey),
      checkout_digest: sha256Base64Url(canonicalJson(intent.rawPayload)),
      scope: "acp:complete_checkout",
    };

    const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
    const encodedClaims = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signingInput = `${encodedHeader}.${encodedClaims}`;
    const signature = signEd25519(signingInput, this.signingKey.privateKey);
    return `${signingInput}.${signature.toString("base64url")}`;
  }
}
