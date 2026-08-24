import { domainToASCII } from "node:url";
import { ApprovalMode } from "../../domain/mandates/mandate.types.js";
import type {
  CompiledPersonalAuthorityPolicy,
  PersonalAuthorityProfile,
} from "../../domain/personal/personal-authority.types.js";

const CURRENCY_MINOR_DIGITS: Readonly<Record<string, number>> = {
  BHD: 3,
  EUR: 2,
  GBP: 2,
  JPY: 0,
  KWD: 3,
  USD: 2,
};

const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
const DEFAULT_MAX_TRANSACTIONS_PER_MINUTE = 10;
const DEFAULT_CROSS_MERCHANT_WINDOW_SECONDS = 60;
const DEFAULT_MAX_DISTINCT_MERCHANTS = 5;

export class PersonalAuthorityValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PersonalAuthorityValidationError";
  }
}

/**
 * Compiles a small, consumer-readable authority profile into the existing Mino
 * policy representation. This function is intentionally deterministic and contains
 * no authorization state of its own.
 */
export function compilePersonalAuthorityProfile(
  profile: PersonalAuthorityProfile,
): CompiledPersonalAuthorityPolicy {
  const currency = normalizeCurrency(profile.currency);
  const minorDigits = CURRENCY_MINOR_DIGITS[currency];
  if (minorDigits === undefined) {
    throw new PersonalAuthorityValidationError("currency is not supported");
  }

  const maxBudgetMinor = parseMajorUnits(
    profile.perTransactionLimit,
    minorDigits,
    "perTransactionLimit",
  );
  const rollingDailyLimitMinor = parseMajorUnits(
    profile.dailyLimit,
    minorDigits,
    "dailyLimit",
  );

  if (maxBudgetMinor <= 0n || rollingDailyLimitMinor <= 0n) {
    throw new PersonalAuthorityValidationError("spending limits must be greater than zero");
  }
  if (rollingDailyLimitMinor < maxBudgetMinor) {
    throw new PersonalAuthorityValidationError(
      "dailyLimit must be greater than or equal to perTransactionLimit",
    );
  }

  const approvedMerchantDomains = unique(
    profile.allowedMerchantDomains.map(normalizeMerchantDomain),
  );
  if (approvedMerchantDomains.length === 0) {
    throw new PersonalAuthorityValidationError(
      "at least one allowed merchant domain is required",
    );
  }

  const restrictedCategories = unique(
    (profile.restrictedCategories ?? []).map(normalizeCategory),
  );

  const maxTransactionsPerMinute = boundedInteger(
    profile.velocity?.maxTransactionsPerMinute ?? DEFAULT_MAX_TRANSACTIONS_PER_MINUTE,
    "maxTransactionsPerMinute",
    1,
    1_000,
  );
  const crossMerchantWindowSecs = boundedInteger(
    profile.velocity?.crossMerchantWindowSeconds ??
      DEFAULT_CROSS_MERCHANT_WINDOW_SECONDS,
    "crossMerchantWindowSeconds",
    1,
    86_400,
  );
  const maxDistinctMerchants = boundedInteger(
    profile.velocity?.maxDistinctMerchantsInWindow ?? DEFAULT_MAX_DISTINCT_MERCHANTS,
    "maxDistinctMerchantsInWindow",
    1,
    1_000,
  );

  const overLimitBehavior = profile.overLimitBehavior ?? "ASK_OWNER";
  if (overLimitBehavior !== "ASK_OWNER" && overLimitBehavior !== "BLOCK") {
    throw new PersonalAuthorityValidationError("overLimitBehavior is invalid");
  }

  return {
    baseCurrency: currency,
    maxBudgetMinor: maxBudgetMinor.toString(10),
    rollingDailyLimitMinor: rollingDailyLimitMinor.toString(10),
    approvedMerchantDomains,
    approvedVendorIds: [],
    restrictedCategories,
    approvalMode:
      overLimitBehavior === "ASK_OWNER"
        ? ApprovalMode.OWNER_APPROVAL
        : ApprovalMode.HARD_BLOCK,
    maxTransactionsPerMinute,
    crossMerchantWindowSecs,
    maxDistinctMerchants,
  };
}

function normalizeCurrency(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new PersonalAuthorityValidationError("currency is invalid");
  }
  return normalized;
}

function parseMajorUnits(value: string, minorDigits: number, field: string): bigint {
  const normalized = value.trim();
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(normalized);
  if (!match) {
    throw new PersonalAuthorityValidationError(`${field} must be a decimal amount string`);
  }

  const fraction = match[2] ?? "";
  if (fraction.length > minorDigits) {
    throw new PersonalAuthorityValidationError(
      `${field} has too many fractional digits for the currency`,
    );
  }

  const whole = BigInt(match[1]);
  const paddedFraction = fraction.padEnd(minorDigits, "0");
  const fractionMinor = paddedFraction.length > 0 ? BigInt(paddedFraction) : 0n;
  const minor = whole * 10n ** BigInt(minorDigits) + fractionMinor;

  if (minor > MAX_POSTGRES_BIGINT) {
    throw new PersonalAuthorityValidationError(`${field} exceeds the supported amount range`);
  }
  return minor;
}

function normalizeMerchantDomain(value: string): string {
  const trimmed = value.trim().toLowerCase().replace(/\.$/, "");
  if (
    trimmed.length === 0 ||
    trimmed.includes("://") ||
    trimmed.includes("/") ||
    trimmed.includes("@") ||
    trimmed.includes(":")
  ) {
    throw new PersonalAuthorityValidationError("allowed merchant domain is invalid");
  }

  const ascii = domainToASCII(trimmed).toLowerCase();
  if (!ascii || ascii.length > 253 || !ascii.includes(".")) {
    throw new PersonalAuthorityValidationError("allowed merchant domain is invalid");
  }

  const labels = ascii.split(".");
  if (
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    throw new PersonalAuthorityValidationError("allowed merchant domain is invalid");
  }

  return ascii;
}

function normalizeCategory(value: string): string {
  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (
    normalized.length === 0 ||
    normalized.length > 128 ||
    !/^[A-Z0-9_]+$/.test(normalized)
  ) {
    throw new PersonalAuthorityValidationError("restricted category is invalid");
  }
  return normalized;
}

function boundedInteger(
  value: number,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new PersonalAuthorityValidationError(`${field} is out of range`);
  }
  return value;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
