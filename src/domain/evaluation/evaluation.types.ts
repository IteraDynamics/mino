import type { EconomicIntent } from "../economic/economic-intent.types.js";
import type { AgentSpendMandate, UUID } from "../mandates/mandate.types.js";
import type { FxQuote, Money } from "../money.js";
import type { DecisionReason } from "./decision-reasons.js";

export interface SpendState {
  readonly committedDailySpend: Money;
  readonly reservedDailySpend: Money;
}

export interface VelocityState {
  readonly transactionsLastMinute: number;
  readonly distinctMerchantsInWindow: number;
  readonly attemptedAmountLastMinute: Money;
  readonly merchantDomainsInWindow: readonly string[];
}

export interface EvaluationContext {
  readonly now: Date;
  readonly mandate: AgentSpendMandate;
  /**
   * Provider-neutral economic authorization input. The property name remains
   * `checkout` for compatibility with the existing transaction path.
   */
  readonly checkout: EconomicIntent;
  readonly spend: SpendState;
  readonly velocity: VelocityState;
  readonly fxQuote?: FxQuote;
}

export enum DecisionVerdict {
  ALLOW = "ALLOW",
  BLOCK = "BLOCK",
  PENDING_HUMAN_APPROVAL = "PENDING_HUMAN_APPROVAL",
}

export interface PolicyDecision {
  readonly decisionId: UUID;
  readonly requestId: UUID;
  readonly verdict: DecisionVerdict;
  readonly reasons: readonly DecisionReason[];

  readonly requestedAmount: Money;
  readonly policyAmount?: Money;
  readonly approvedAmount?: Money;

  readonly mandateId: UUID;
  readonly policyId: UUID;
  readonly policyVersion: number;

  /**
   * Present for decisions over provider-authoritative execution intents. Synthetic
   * evaluator-only fixtures may omit it, but execution/approval paths require it.
   */
  readonly intentDigest?: string;

  readonly eligibleForDelegationAssertion: boolean;

  readonly approval?: {
    readonly required: true;
    readonly approvalMode: string;
    readonly expiresAt: Date;
  };

  readonly evaluationLatencyMicros: number;
  readonly evaluatedAt: Date;
}
