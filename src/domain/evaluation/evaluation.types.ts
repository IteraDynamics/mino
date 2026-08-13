import type { CheckoutIntent } from "../checkout/checkout.types.js";
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
  readonly checkout: CheckoutIntent;
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

  readonly eligibleForDelegationAssertion: boolean;

  readonly approval?: {
    readonly required: true;
    readonly approvalMode: string;
    readonly expiresAt: Date;
  };

  readonly evaluationLatencyMicros: number;
  readonly evaluatedAt: Date;
}
