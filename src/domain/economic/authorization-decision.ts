import type { PolicyDecision } from "../evaluation/evaluation.types.js";
import type { BoundEconomicIntent } from "./canonical-economic-intent.js";

/** Authorization result bound to the exact immutable EconomicIntent consequence. */
export type AuthorizationDecision = PolicyDecision & {
  readonly intentDigest: string;
};

export function bindAuthorizationDecision(
  decision: PolicyDecision,
  intent: BoundEconomicIntent,
): AuthorizationDecision {
  return Object.freeze({ ...decision, intentDigest: intent.intentDigest });
}
