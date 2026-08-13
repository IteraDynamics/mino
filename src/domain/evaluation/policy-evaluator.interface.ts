import type { EvaluationContext, PolicyDecision } from "./evaluation.types.js";

export interface PolicyEvaluator {
  evaluate(context: EvaluationContext): PolicyDecision;
}
