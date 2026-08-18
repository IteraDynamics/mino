import type { EconomicCounterpartyIdentity } from "./counterparty-identity.js";
import type { EconomicOperation } from "./economic-intent.types.js";

export interface AuthorizationGrantClaims {
  readonly iss: string;
  readonly aud: "mino:economic-execution";
  readonly sub: string;
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
  readonly organization_id: string;
  readonly user_id: string;
  readonly agent_id: string;
  readonly mandate_id: string;
  readonly policy_id: string;
  readonly policy_version: number;
  readonly decision_id: string;
  readonly request_id: string;
  readonly operation: EconomicOperation;
  readonly counterparty: EconomicCounterpartyIdentity;
  readonly amount_minor: string;
  readonly currency: string;
  readonly idempotency_digest: string;
  readonly intent_digest: string;
}

export interface SignedAuthorizationGrant {
  readonly token: string;
  readonly claims: AuthorizationGrantClaims;
}
