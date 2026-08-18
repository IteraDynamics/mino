import type { Ed25519KeyInput } from "../../infrastructure/crypto/ed25519.js";
import { signEd25519 } from "../../infrastructure/crypto/ed25519.js";
import { canonicalJson, sha256Base64Url } from "../../infrastructure/crypto/canonical-json.js";
import { resolveEconomicCounterparty } from "../../domain/economic/counterparty-identity.js";
import type { EconomicIntent } from "../../domain/economic/economic-intent.types.js";
import type { PolicyDecision } from "../../domain/evaluation/evaluation.types.js";
import type {
  AuthorizationGrantClaims,
  SignedAuthorizationGrant,
} from "../../domain/economic/authorization-grant.types.js";

export interface AuthorizationGrantSigningKey {
  readonly keyId: string;
  readonly privateKey: Ed25519KeyInput;
}

export interface AuthorizationGrantIssuerOptions {
  readonly issuer: string;
  readonly ttlSeconds?: number;
}

interface AuthorizationGrantHeader {
  readonly alg: "EdDSA";
  readonly typ: "mino+authorization-grant+jwt";
  readonly kid: string;
  readonly v: 1;
}

export interface AuthorizationGrantIssuer {
  issue(intent: EconomicIntent, decision: PolicyDecision, now: Date): SignedAuthorizationGrant;
}

export class AuthorizationGrantService implements AuthorizationGrantIssuer {
  private readonly ttlSeconds: number;

  public constructor(
    private readonly signingKey: AuthorizationGrantSigningKey,
    private readonly generateId: () => string,
    private readonly options: AuthorizationGrantIssuerOptions,
  ) {
    this.ttlSeconds = options.ttlSeconds ?? 45;
  }

  public issue(intent: EconomicIntent, decision: PolicyDecision, now: Date): SignedAuthorizationGrant {
    if (!decision.eligibleForDelegationAssertion || !decision.approvedAmount) {
      throw new Error("Authorization grants can only be issued for allowed decisions");
    }

    const counterparty = resolveEconomicCounterparty(intent);
    if (!counterparty) {
      throw new Error("Authorization grants require an unambiguous economic counterparty");
    }

    const issuedAt = Math.floor(now.getTime() / 1000);
    const claims: AuthorizationGrantClaims = {
      iss: this.options.issuer,
      aud: "mino:economic-execution",
      sub: intent.agentId,
      jti: this.generateId(),
      iat: issuedAt,
      exp: issuedAt + this.ttlSeconds,
      organization_id: intent.organizationId,
      user_id: intent.userId,
      agent_id: intent.agentId,
      mandate_id: decision.mandateId,
      policy_id: decision.policyId,
      policy_version: decision.policyVersion,
      decision_id: decision.decisionId,
      request_id: intent.requestId,
      operation: intent.operation,
      counterparty,
      amount_minor: decision.approvedAmount.minorUnits.toString(10),
      currency: decision.approvedAmount.currency,
      idempotency_digest: sha256Base64Url(intent.idempotencyKey),
      intent_digest: sha256Base64Url(canonicalJson(providerNeutralIntentBinding(intent, counterparty))),
    };

    const header: AuthorizationGrantHeader = {
      alg: "EdDSA",
      typ: "mino+authorization-grant+jwt",
      kid: this.signingKey.keyId,
      v: 1,
    };
    const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
    const encodedClaims = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signingInput = `${encodedHeader}.${encodedClaims}`;
    const signature = signEd25519(signingInput, this.signingKey.privateKey);

    return {
      token: `${signingInput}.${signature.toString("base64url")}`,
      claims,
    };
  }
}

function providerNeutralIntentBinding(intent: EconomicIntent, counterparty: NonNullable<ReturnType<typeof resolveEconomicCounterparty>>) {
  return {
    requestId: intent.requestId,
    operation: intent.operation,
    organizationId: intent.organizationId,
    userId: intent.userId,
    agentId: intent.agentId,
    counterparty,
    cart: intent.cart,
    subtotal: intent.subtotal,
    tax: intent.tax,
    shipping: intent.shipping,
    total: intent.total,
    idempotencyKey: intent.idempotencyKey,
  };
}
