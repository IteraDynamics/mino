import type { AuthorizationDecision } from "../../domain/economic/authorization-decision.js";
import type { CheckoutIntent } from "../../domain/checkout/checkout.types.js";
import type { PolicyDecision } from "../../domain/evaluation/evaluation.types.js";
import type { AuthorizationGrantIssuer } from "../authorization/authorization-grant.service.js";
import type { DelegationAssertionIssuer } from "./delegation-assertion.service.js";

/** Compatibility bridge for legacy ACP delegation output. */
export class ACPAuthorizationGrantAdapter implements DelegationAssertionIssuer {
  public constructor(
    private readonly grants: AuthorizationGrantIssuer,
    private readonly legacyDelegation: DelegationAssertionIssuer,
  ) {}

  public issue(intent: CheckoutIntent, decision: PolicyDecision, now: Date): string {
    if (!("intentDigest" in decision) || typeof decision.intentDigest !== "string") {
      throw new Error("ACP authorization grants require an EconomicIntent-bound decision");
    }
    this.grants.issue(intent, decision as AuthorizationDecision, now);
    return this.legacyDelegation.issue(intent, decision, now);
  }
}
