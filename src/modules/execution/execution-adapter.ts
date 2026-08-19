import type { SignedAuthorizationGrant } from "../../domain/economic/authorization-grant.types.js";
import type { EconomicIntent, EconomicProviderProtocol } from "../../domain/economic/economic-intent.types.js";
import type { PolicyDecision } from "../../domain/evaluation/evaluation.types.js";

/**
 * Provider-neutral input to an execution adapter.
 *
 * The signed AuthorizationGrant is Mino's authorization output. Provider-specific
 * execution details live only in the adapter context and must not redefine the
 * meaning of the intent, decision, or grant.
 */
export interface EconomicExecutionInput<TContext> {
  readonly intent: EconomicIntent;
  readonly decision: PolicyDecision;
  readonly grant: SignedAuthorizationGrant;
  readonly context: TContext;
  readonly now: Date;
}

/**
 * Boundary between Mino authorization and provider-specific money movement.
 *
 * Implementations may translate the neutral grant into provider-native headers,
 * credentials, or request shapes, but authorization semantics stay outside the
 * adapter.
 */
export interface EconomicExecutionAdapter<TContext, TResult> {
  readonly protocol: EconomicProviderProtocol;
  execute(input: EconomicExecutionInput<TContext>): Promise<TResult>;
}
