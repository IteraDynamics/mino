import type { ApprovalMode } from "../mandates/mandate.types.js";

export type PersonalOverLimitBehavior = "ASK_OWNER" | "BLOCK";

export interface PersonalVelocityProfile {
  readonly maxTransactionsPerMinute?: number;
  readonly crossMerchantWindowSeconds?: number;
  readonly maxDistinctMerchantsInWindow?: number;
}

/**
 * Consumer-facing authority settings. Monetary limits are decimal major-unit strings
 * (for example "100.00" USD), never floating-point numbers.
 */
export interface PersonalAuthorityProfile {
  readonly currency: string;
  readonly perTransactionLimit: string;
  readonly dailyLimit: string;
  readonly allowedMerchantDomains: readonly string[];
  readonly restrictedCategories?: readonly string[];
  readonly overLimitBehavior?: PersonalOverLimitBehavior;
  readonly velocity?: PersonalVelocityProfile;
}

/**
 * Existing control-plane Policy shape produced from a Personal authority profile.
 * Personal is an adapter onto the core policy model, not a second policy engine.
 */
export interface CompiledPersonalAuthorityPolicy {
  readonly baseCurrency: string;
  readonly maxBudgetMinor: string;
  readonly rollingDailyLimitMinor: string;
  readonly approvedMerchantDomains: readonly string[];
  readonly approvedVendorIds: readonly string[];
  readonly restrictedCategories: readonly string[];
  readonly approvalMode: ApprovalMode;
  readonly maxTransactionsPerMinute: number;
  readonly crossMerchantWindowSecs: number;
  readonly maxDistinctMerchants: number;
}
