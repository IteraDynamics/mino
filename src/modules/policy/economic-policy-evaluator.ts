import { ApprovalMode } from "../../domain/mandates/mandate.types.js";
import type { AgentSpendMandate, UUID } from "../../domain/mandates/mandate.types.js";
import type { FxQuote, Money } from "../../domain/money.js";
import { DecisionReason } from "../../domain/evaluation/decision-reasons.js";
import {
  DecisionVerdict,
  type EvaluationContext,
  type PolicyDecision,
} from "../../domain/evaluation/evaluation.types.js";
import type { PolicyEvaluator as PolicyEvaluatorContract } from "../../domain/evaluation/policy-evaluator.interface.js";
import { resolveMerchantPolicyProjection } from "../../domain/economic/counterparty-identity.js";

export interface PolicyEvaluatorDependencies {
  readonly generateId: () => UUID;
  readonly monotonicMicros: () => number;
  readonly humanApprovalTtlMs?: number;
}

const DEFAULT_HUMAN_APPROVAL_TTL_MS = 10 * 60 * 1000;

const CURRENCY_MINOR_DIGITS: Readonly<Record<string, number>> = {
  BHD: 3,
  EUR: 2,
  GBP: 2,
  JPY: 0,
  KWD: 3,
  USD: 2,
};

const HARD_BLOCK_REASONS = new Set<DecisionReason>([
  DecisionReason.MANDATE_EXPIRED,
  DecisionReason.MANDATE_REVOKED,
  DecisionReason.ORGANIZATION_MISMATCH,
  DecisionReason.AGENT_MISMATCH,
  DecisionReason.USER_MISMATCH,
  DecisionReason.MERCHANT_NOT_APPROVED,
  DecisionReason.CATEGORY_UNKNOWN,
  DecisionReason.CATEGORY_RESTRICTED,
  DecisionReason.RATE_LIMIT_EXCEEDED,
  DecisionReason.CROSS_MERCHANT_BURST,
  DecisionReason.CURRENCY_NOT_SUPPORTED,
  DecisionReason.FX_QUOTE_REQUIRED,
  DecisionReason.FX_QUOTE_MISMATCH,
  DecisionReason.FX_QUOTE_EXPIRED,
  DecisionReason.FX_QUOTE_INVALID,
]);

const APPROVABLE_LIMIT_REASONS = new Set<DecisionReason>([
  DecisionReason.TRANSACTION_LIMIT_EXCEEDED,
  DecisionReason.DAILY_LIMIT_EXCEEDED,
]);

export class PolicyEvaluator implements PolicyEvaluatorContract {
  private readonly generateId: () => UUID;
  private readonly monotonicMicros: () => number;
  private readonly humanApprovalTtlMs: number;

  public constructor(dependencies: PolicyEvaluatorDependencies) {
    this.generateId = dependencies.generateId;
    this.monotonicMicros = dependencies.monotonicMicros;
    this.humanApprovalTtlMs =
      dependencies.humanApprovalTtlMs ?? DEFAULT_HUMAN_APPROVAL_TTL_MS;
  }

  public evaluate(context: EvaluationContext): PolicyDecision {
    const startedAt = this.monotonicMicros();
    const reasons: DecisionReason[] = [];

    this.evaluateMandateState(context, reasons);
    this.evaluateIdentityBinding(context, reasons);
    this.evaluateMerchant(context, reasons);
    this.evaluateCategories(context, reasons);
    this.evaluateVelocity(context, reasons);

    const policyAmount = this.normalizeToMandateCurrency(context, reasons);

    if (policyAmount) {
      this.evaluateSpendLimits(context, policyAmount, reasons);
    }

    const verdict = this.resolveVerdict(context.mandate, reasons);

    if (verdict === DecisionVerdict.ALLOW) {
      reasons.push(DecisionReason.POLICY_ALLOW);
    } else if (verdict === DecisionVerdict.PENDING_HUMAN_APPROVAL) {
      reasons.push(DecisionReason.HUMAN_APPROVAL_REQUIRED);
    } else if (
      context.mandate.approvalMode === ApprovalMode.HARD_BLOCK &&
      reasons.some((reason) => APPROVABLE_LIMIT_REASONS.has(reason)) &&
      !reasons.some((reason) => HARD_BLOCK_REASONS.has(reason))
    ) {
      reasons.push(DecisionReason.POLICY_HARD_BLOCK);
    }

    const finishedAt = this.monotonicMicros();
    const latency = Math.max(0, Math.trunc(finishedAt - startedAt));

    const base: PolicyDecision = {
      decisionId: this.generateId(),
      requestId: context.checkout.requestId,
      verdict,
      reasons,
      requestedAmount: context.checkout.total,
      mandateId: context.mandate.id,
      policyId: context.mandate.policyId,
      policyVersion: context.mandate.policyVersion,
      eligibleForDelegationAssertion: verdict === DecisionVerdict.ALLOW,
      evaluationLatencyMicros: latency,
      evaluatedAt: context.now,
    };

    if (policyAmount) {
      Object.assign(base, { policyAmount });
    }

    if (verdict === DecisionVerdict.ALLOW && policyAmount) {
      Object.assign(base, { approvedAmount: policyAmount });
    }

    if (verdict === DecisionVerdict.PENDING_HUMAN_APPROVAL) {
      Object.assign(base, {
        approval: {
          required: true as const,
          approvalMode: context.mandate.approvalMode,
          expiresAt: new Date(context.now.getTime() + this.humanApprovalTtlMs),
        },
      });
    }

    return base;
  }

  private evaluateMandateState(
    context: EvaluationContext,
    reasons: DecisionReason[],
  ): void {
    if (context.mandate.revokedAt && context.mandate.revokedAt <= context.now) {
      reasons.push(DecisionReason.MANDATE_REVOKED);
    }

    if (context.now >= context.mandate.expiresAt) {
      reasons.push(DecisionReason.MANDATE_EXPIRED);
    }
  }

  private evaluateIdentityBinding(
    context: EvaluationContext,
    reasons: DecisionReason[],
  ): void {
    if (context.checkout.organizationId !== context.mandate.organizationId) {
      reasons.push(DecisionReason.ORGANIZATION_MISMATCH);
    }

    if (context.checkout.agentId !== context.mandate.agentId) {
      reasons.push(DecisionReason.AGENT_MISMATCH);
    }

    if (context.checkout.userId !== context.mandate.userId) {
      reasons.push(DecisionReason.USER_MISMATCH);
    }
  }

  private evaluateMerchant(
    context: EvaluationContext,
    reasons: DecisionReason[],
  ): void {
    const merchant = resolveMerchantPolicyProjection(context.checkout);
    if (!merchant) {
      reasons.push(DecisionReason.MERCHANT_NOT_APPROVED);
      return;
    }

    const domain = canonicalizeDomain(merchant.domain);
    const domainApproved = context.mandate.approvedMerchantDomains.some(
      (approved) => domainMatches(domain, canonicalizeDomain(approved)),
    );

    const vendorId = merchant.vendorId;
    const vendorApproved =
      vendorId !== undefined &&
      context.mandate.approvedVendorIds.includes(vendorId);

    if (!domainApproved && !vendorApproved) {
      reasons.push(DecisionReason.MERCHANT_NOT_APPROVED);
    }
  }

  private evaluateCategories(
    context: EvaluationContext,
    reasons: DecisionReason[],
  ): void {
    const restricted = new Set(
      context.mandate.restrictedCategories.map(normalizeCategory),
    );

    for (const line of context.checkout.cart) {
      if (!line.category?.trim()) {
        pushUnique(reasons, DecisionReason.CATEGORY_UNKNOWN);
        continue;
      }

      if (restricted.has(normalizeCategory(line.category))) {
        pushUnique(reasons, DecisionReason.CATEGORY_RESTRICTED);
      }
    }
  }

  private evaluateVelocity(
    context: EvaluationContext,
    reasons: DecisionReason[],
  ): void {
    if (
      context.velocity.transactionsLastMinute >=
      context.mandate.velocity.maxTransactionsPerMinute
    ) {
      reasons.push(DecisionReason.RATE_LIMIT_EXCEEDED);
    }

    const merchant = resolveMerchantPolicyProjection(context.checkout);
    if (!merchant) {
      return;
    }

    const currentDomain = canonicalizeDomain(merchant.domain);
    const seenDomains = new Set(
      context.velocity.merchantDomainsInWindow.map(canonicalizeDomain),
    );
    const addsDistinctMerchant = !seenDomains.has(currentDomain);

    const projectedDistinctMerchantCount =
      Math.max(context.velocity.distinctMerchantsInWindow, seenDomains.size) +
      (addsDistinctMerchant ? 1 : 0);

    if (
      projectedDistinctMerchantCount >
      context.mandate.velocity.maxDistinctMerchantsInWindow
    ) {
      reasons.push(DecisionReason.CROSS_MERCHANT_BURST);
    }
  }

  private normalizeToMandateCurrency(
    context: EvaluationContext,
    reasons: DecisionReason[],
  ): Money | undefined {
    const sourceCurrency = normalizeCurrency(context.checkout.total.currency);
    const mandateCurrency = normalizeCurrency(context.mandate.currency);

    if (!getMinorDigits(sourceCurrency) || !getMinorDigits(mandateCurrency)) {
      if (
        getMinorDigits(sourceCurrency) === undefined ||
        getMinorDigits(mandateCurrency) === undefined
      ) {
        reasons.push(DecisionReason.CURRENCY_NOT_SUPPORTED);
        return undefined;
      }
    }

    if (sourceCurrency === mandateCurrency) {
      return {
        currency: mandateCurrency,
        minorUnits: context.checkout.total.minorUnits,
      };
    }

    if (!context.fxQuote) {
      reasons.push(DecisionReason.FX_QUOTE_REQUIRED);
      return undefined;
    }

    const quote = context.fxQuote;
    if (
      normalizeCurrency(quote.from) !== sourceCurrency ||
      normalizeCurrency(quote.to) !== mandateCurrency
    ) {
      reasons.push(DecisionReason.FX_QUOTE_MISMATCH);
      return undefined;
    }

    if (context.now > quote.expiresAt || context.now < quote.quotedAt) {
      reasons.push(DecisionReason.FX_QUOTE_EXPIRED);
      return undefined;
    }

    try {
      return convertMoneyCeiling(context.checkout.total, mandateCurrency, quote);
    } catch {
      reasons.push(DecisionReason.FX_QUOTE_INVALID);
      return undefined;
    }
  }

  private evaluateSpendLimits(
    context: EvaluationContext,
    policyAmount: Money,
    reasons: DecisionReason[],
  ): void {
    if (policyAmount.minorUnits > context.mandate.maxBudgetPerTransactionMinor) {
      reasons.push(DecisionReason.TRANSACTION_LIMIT_EXCEEDED);
    }

    const spendCurrency = normalizeCurrency(context.mandate.currency);

    if (
      normalizeCurrency(context.spend.committedDailySpend.currency) !== spendCurrency ||
      normalizeCurrency(context.spend.reservedDailySpend.currency) !== spendCurrency
    ) {
      pushUnique(reasons, DecisionReason.CURRENCY_NOT_SUPPORTED);
      return;
    }

    const projectedDailySpend =
      context.spend.committedDailySpend.minorUnits +
      context.spend.reservedDailySpend.minorUnits +
      policyAmount.minorUnits;

    if (projectedDailySpend > context.mandate.rollingDailyLimitMinor) {
      reasons.push(DecisionReason.DAILY_LIMIT_EXCEEDED);
    }
  }

  private resolveVerdict(
    mandate: AgentSpendMandate,
    reasons: readonly DecisionReason[],
  ): DecisionVerdict {
    if (reasons.some((reason) => HARD_BLOCK_REASONS.has(reason))) {
      return DecisionVerdict.BLOCK;
    }

    const hasApprovableLimitBreach = reasons.some((reason) =>
      APPROVABLE_LIMIT_REASONS.has(reason),
    );

    if (!hasApprovableLimitBreach) {
      return DecisionVerdict.ALLOW;
    }

    if (mandate.approvalMode === ApprovalMode.DUAL_SIGNATURE_SLACK) {
      return DecisionVerdict.PENDING_HUMAN_APPROVAL;
    }

    return DecisionVerdict.BLOCK;
  }
}

function normalizeCurrency(currency: string): string {
  return currency.trim().toUpperCase();
}

function normalizeCategory(category: string): string {
  return category.trim().toUpperCase().replace(/[\s-]+/g, "_");
}

function canonicalizeDomain(domain: string): string {
  const value = domain.trim().toLowerCase().replace(/\.$/, "");

  if (value.includes("://") || value.includes("/") || value.includes("@")) {
    return "";
  }

  return value;
}

function domainMatches(actual: string, approved: string): boolean {
  if (!actual || !approved) {
    return false;
  }

  return actual === approved || actual.endsWith(`.${approved}`);
}

function pushUnique<T>(array: T[], value: T): void {
  if (!array.includes(value)) {
    array.push(value);
  }
}

function getMinorDigits(currency: string): number | undefined {
  return CURRENCY_MINOR_DIGITS[currency];
}

function convertMoneyCeiling(
  money: Money,
  targetCurrency: string,
  quote: FxQuote,
): Money {
  if (money.minorUnits < 0n) {
    throw new Error("Negative checkout totals are not supported");
  }

  const sourceCurrency = normalizeCurrency(money.currency);
  const normalizedTargetCurrency = normalizeCurrency(targetCurrency);
  const sourceDigits = getMinorDigits(sourceCurrency);
  const targetDigits = getMinorDigits(normalizedTargetCurrency);

  if (sourceDigits === undefined || targetDigits === undefined) {
    throw new Error("Unsupported currency");
  }

  const { numerator, denominator } = parsePositiveDecimal(quote.rate);

  const scaledNumerator = money.minorUnits * numerator * pow10(targetDigits);
  const scaledDenominator = denominator * pow10(sourceDigits);

  return {
    currency: normalizedTargetCurrency,
    minorUnits: divideCeiling(scaledNumerator, scaledDenominator),
  };
}

function parsePositiveDecimal(value: string): {
  numerator: bigint;
  denominator: bigint;
} {
  const normalized = value.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(normalized);

  if (!match) {
    throw new Error("Invalid decimal rate");
  }

  const whole = match[1];
  const fraction = match[2] ?? "";
  const numerator = BigInt(`${whole}${fraction}`);
  const denominator = pow10(fraction.length);

  if (numerator <= 0n) {
    throw new Error("FX rate must be positive");
  }

  return { numerator, denominator };
}

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function divideCeiling(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new Error("Denominator must be positive");
  }

  return (numerator + denominator - 1n) / denominator;
}
