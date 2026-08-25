import type {
  EconomicCounterpartyIdentity,
  EconomicIntent,
  EconomicLineItem,
  EconomicMerchantIdentity,
  EconomicOperation,
  EconomicProviderProtocol,
  LegacyCheckoutEconomics,
} from "../economic/economic-intent.types.js";

/**
 * Compatibility aliases for the ACP/checkout-facing surface.
 *
 * Mino's authorization core speaks the generalized EconomicIntent union. ACP
 * callers explicitly use the legacy checkout economics member so checkout-only
 * code keeps strong `cart/subtotal/total` types without forcing those aliases
 * onto non-checkout economic rails.
 */
export type CommerceProtocol = EconomicProviderProtocol;
export type CheckoutOperation = EconomicOperation;
export type CounterpartyIdentity = EconomicCounterpartyIdentity;
export type MerchantIdentity = EconomicMerchantIdentity;
export type CartLine = EconomicLineItem;
export type CheckoutIntent = Extract<EconomicIntent, LegacyCheckoutEconomics>;
