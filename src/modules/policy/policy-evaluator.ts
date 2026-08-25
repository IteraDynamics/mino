import {
  authorityReferenceFromMandate,
  bindEconomicIntent,
} from "../../domain/economic/canonical-economic-intent.js";
import type { EvaluationContext, PolicyDecision } from "../../domain/evaluation/evaluation.types.js";
import type { PolicyEvaluator as PolicyEvaluatorContract } from "../../domain/evaluation/policy-evaluator.interface.js";
import {
  PolicyEvaluator as EconomicPolicyEvaluator,
  type PolicyEvaluatorDependencies,
} from "./economic-policy-evaluator.js";

export type { PolicyEvaluatorDependencies };

/**
 * Public policy evaluator adds the canonical EconomicIntent binding on top of the
 * deterministic economic policy engine. Synthetic evaluator-only fixtures without
 * provider-authoritative state remain supported, but those decisions cannot cross
 * an execution boundary that requires `intentDigest`.
 */
export class PolicyEvaluator implements PolicyEvaluatorContract {
  private readonly evaluator: EconomicPolicyEvaluator;

  public constructor(dependencies: PolicyEvaluatorDependencies) {
    this.evaluator = new EconomicPolicyEvaluator(dependencies);
  }

  public evaluate(context: EvaluationContext): PolicyDecision {
    const decision = this.evaluator.evaluate(context);
    if (!context.checkout.authoritativeStateDigest) {
      return decision;
    }

    const bound = bindEconomicIntent(
      context.checkout,
      authorityReferenceFromMandate(context.mandate),
    );
    return Object.freeze({ ...decision, intentDigest: bound.intentDigest });
  }
}
