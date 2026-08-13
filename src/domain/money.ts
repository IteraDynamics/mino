export type CurrencyCode = string;

/** Integer units of the currency's smallest denomination. */
export interface Money {
  readonly currency: CurrencyCode;
  readonly minorUnits: bigint;
}

/**
 * Rate expresses how many units of `to` currency equal one unit of `from`.
 * Example: EUR -> USD at 1.10 means 1 EUR = 1.10 USD.
 */
export interface FxQuote {
  readonly from: CurrencyCode;
  readonly to: CurrencyCode;
  readonly rate: string;
  readonly quotedAt: Date;
  readonly expiresAt: Date;
  readonly provider: string;
}
