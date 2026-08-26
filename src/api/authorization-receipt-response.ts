import type { SignedAuthorizationReceipt } from "../domain/economic/authorization-receipt.js";
import type { AuthorizationReceiptIssuer } from "../modules/receipts/authorization-receipt.service.js";

export class AuthorizationReceiptPendingError extends Error {
  public constructor(public readonly paymentOutcomeId: string) {
    super("Economic execution is terminal but authorization proof generation is incomplete");
    this.name = "AuthorizationReceiptPendingError";
  }
}

export interface TerminalEconomicResult {
  readonly paymentOutcomeId?: string;
}

/**
 * Generate or replay the one immutable receipt for any terminal economic result.
 * If proof generation fails after the economic outcome is already terminal, surface
 * that state explicitly so callers retry idempotently rather than misreading it as
 * an execution failure.
 */
export async function issueTerminalAuthorizationReceipt(
  result: TerminalEconomicResult,
  receipts: AuthorizationReceiptIssuer | undefined,
  now: Date,
): Promise<SignedAuthorizationReceipt | undefined> {
  if (!receipts || !result.paymentOutcomeId) return undefined;
  try {
    return await receipts.issueForPaymentOutcome(result.paymentOutcomeId, now);
  } catch {
    throw new AuthorizationReceiptPendingError(result.paymentOutcomeId);
  }
}