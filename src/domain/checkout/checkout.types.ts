import type {
  EconomicCounterpartyIdentity,
  EconomicIntent,
  EconomicLineItem,
  EconomicMerchantIdentity,
  EconomicOperation,
  EconomicProviderProtocol,
} from "../economic/economic-intent.types.js";

/**
 * Compatibility aliases for the ACP/checkout-facing surface.
 *
 * Mino's authorization core speaks EconomicIntent. These aliases preserve the
 * existing checkout API and internal call sites while provider-specific adapters
 * migrate to provider-neutral economic and counterparty boundaries incrementally.
 */
export type CommerceProtocol = EconomicProviderProtocol;
export type CheckoutOperation = EconomicOperation;
export type CounterpartyIdentity = EconomicCounterpartyIdentity;
export type MerchantIdentity = EconomicMerchantIdentity;
export type CartLine = EconomicLineItem;
export type CheckoutIntent = EconomicIntent;
