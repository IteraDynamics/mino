import type { Money } from "../money.js";
import type { UUID } from "../mandates/mandate.types.js";

/**
 * Execution/provider provenance for an intent. Policy meaning must not branch on
 * this field; adapters may preserve it for evidence and downstream protocol work.
 */
export type EconomicProviderProtocol = "ACP" | "STRIPE" | "CUSTOM";

/**
 * Provider-neutral economic operation understood by Mino's authorization core.
 * Names remain checkout-oriented in PR #31 to preserve exact existing behavior;
 * later slices may broaden the operation vocabulary without changing policy meaning.
 */
export type EconomicOperation =
  | "CREATE_CHECKOUT_SESSION"
  | "UPDATE_CHECKOUT_SESSION"
  | "COMPLETE_CHECKOUT"
  | "AUTHORIZE_PAYMENT";

/**
 * Existing merchant identity carried by an economic intent. Counterparty identity
 * is deliberately not generalized in PR #31; that is a separate boundary.
 */
export interface EconomicMerchantIdentity {
  readonly domain: string;
  readonly vendorId?: string;
}

export interface EconomicLineItem {
  readonly lineId: string;
  readonly sku?: string;
  readonly productId?: string;
  readonly name: string;
  readonly category?: string;
  readonly quantity: number;
  readonly unitPrice: Money;
  readonly totalPrice: Money;
}

/**
 * Canonical provider-neutral input to Mino's economic authorization semantics.
 *
 * `protocol` and `rawPayload` are provenance only. The policy evaluator must derive
 * authorization meaning exclusively from normalized fields such as identities,
 * merchant scope, categories, amounts, and operation. Equivalent normalized
 * intents must therefore evaluate equivalently regardless of execution provider.
 */
export interface EconomicIntent {
  readonly requestId: UUID;
  readonly protocol: EconomicProviderProtocol;
  readonly operation: EconomicOperation;
  readonly organizationId: UUID;
  readonly userId: UUID;
  readonly agentId: UUID;
  readonly merchant: EconomicMerchantIdentity;
  readonly cart: readonly EconomicLineItem[];
  readonly subtotal: Money;
  readonly tax?: Money;
  readonly shipping?: Money;
  readonly total: Money;
  readonly idempotencyKey: string;
  readonly rawPayload: unknown;
}
