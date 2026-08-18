import type { CheckoutIntent } from "../../domain/checkout/checkout.types.js";
import type { PolicyDecision } from "../../domain/evaluation/evaluation.types.js";
import type { AuthorizationGrantIssuer } from "../authorization/authorization-grant.service.js";
import type { DelegationAssertionIssuer } from "./delegation-assertion.service.js";

/**
 * Compatibility bridge for the current ACP execution path.
 *
 * Every allowed ACP execution now produces the provider-neutral signed
 * AuthorizationGrant first, then emits the existing ACP delegation assertion
 * unchanged. PR #34 can replace this bridge with a general execution-adapter
 * boundary without making the grant format ACP-specific.
 */
export class ACPAuthorizationGrantAdapter implements DelegationAssertionIssuer {
  public constructor(
    private readonly grants: AuthorizationGrantIssuer,
    private readonly legacyDelegation: DelegationAssertionIssuer,
  ) {}

  public issue(intent: CheckoutIntent, decision: PolicyDecision, now: Date): string {
    this.grants.issue(intent, decision, now);
    return this.legacyDelegation.issue(intent, decision, now);
  }
}
