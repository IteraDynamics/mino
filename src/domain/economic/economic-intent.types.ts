import type { Money } from "../money.js";
import type { UUID } from "../mandates/mandate.types.js";
import type {
  EconomicCounterpartyIdentity,
  EconomicMerchantIdentity,
} from "./counterparty-identity.js";

export type {
  EconomicCounterpartyIdentity,
  EconomicMerchantIdentity,
} from "./counterparty-identity.js";

/**
 * Execution/provider provenance for an intent. Policy meaning must not branch on
 * this field; adapters preserve it only for authoritative-state normalization,
 * evidence, and downstream protocol work.
 */
export type EconomicProviderProtocol = "ACP" | "STRIPE" | "CUSTOM";

/** Provider-neutral economic operations. Operation semantics may differ; provider semantics may not leak into Core. */
export type EconomicOperation =
  | "CREATE_CHECKOUT_SESSION"
  | "UPDATE_CHECKOUT_SESSION"
  | "COMPLETE_CHECKOUT"
  | "AUTHORIZE_PAYMENT"
  | "PAY_INVOICE";

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
 * Provider-neutral economic value. An action may transfer value without having a
 * shopping cart; line items therefore describe optional economic components rather
 * than defining the existence of an economic consequence.
 */
export interface EconomicValue {
  readonly amount: Money;
  readonly items?: readonly EconomicLineItem[];
}

interface EconomicIntentBase {
  /** Per-attempt transport/audit provenance. This must not define intent identity. */
  readonly requestId: UUID;
  readonly protocol: EconomicProviderProtocol;
  readonly operation: EconomicOperation;
  readonly organizationId: UUID;
  readonly userId: UUID;
  readonly agentId: UUID;
  readonly idempotencyKey: string;
  /**
   * Digest of the stable provider-authoritative state projection used by the adapter.
   * Production execution canonicalization requires this value. It remains optional
   * here temporarily so evaluator/unit fixtures that construct normalized intents
   * directly can migrate without conflating test provenance with trusted provider state.
   */
  readonly authoritativeStateDigest?: string;
  /** Provider payload retained only as provenance/evidence. Core authorization must not trust it directly. */
  readonly rawPayload: unknown;
}

/** Existing checkout economics retained as a compatibility representation. */
export type LegacyCheckoutEconomics = {
  readonly economicValue?: undefined;
  readonly cart: readonly EconomicLineItem[];
  readonly subtotal: Money;
  readonly tax?: Money;
  readonly shipping?: Money;
  readonly total: Money;
};

/** New rails should use this representation rather than inventing fake carts/subtotals. */
export type ProviderNeutralEconomics = {
  readonly economicValue: EconomicValue;
  readonly cart?: undefined;
  readonly subtotal?: undefined;
  readonly tax?: undefined;
  readonly shipping?: undefined;
  readonly total?: undefined;
};

export type EconomicValueBinding = LegacyCheckoutEconomics | ProviderNeutralEconomics;

/**
 * Canonical provider-neutral recipient identity plus a temporary compatibility
 * bridge for checkout callers that still construct only the legacy merchant shape.
 *
 * New provider adapters should supply `counterparty`. The existing ACP adapter emits
 * both representations from one source so downstream ACP-only evidence and request
 * binding remain compatible while the authorization core moves to generalized identity.
 * When both are present, policy evaluation requires them to agree and fails closed.
 */
export type EconomicCounterpartyBinding =
  | {
      readonly counterparty: EconomicCounterpartyIdentity;
      readonly merchant?: EconomicMerchantIdentity;
    }
  | {
      readonly counterparty?: undefined;
      readonly merchant: EconomicMerchantIdentity;
    };

/**
 * Provider-normalized economic state consumed by policy evaluation and then elevated
 * into the immutable canonical EconomicIntent binding before approval/execution.
 *
 * Safety invariant: Mino Core does not trust an agent's description of the economic
 * consequence. Production adapters derive these normalized facts from authoritative
 * provider state; canonical binding validates the authority reference and source digest.
 */
export type EconomicIntent = EconomicIntentBase & EconomicCounterpartyBinding & EconomicValueBinding;

/** Core policy/execution code reads value through these helpers rather than checkout aliases. */
export function economicAmount(intent: EconomicIntent): Money {
  return intent.economicValue ? intent.economicValue.amount : intent.total;
}

export function economicItems(intent: EconomicIntent): readonly EconomicLineItem[] {
  return intent.economicValue?.items ?? intent.cart ?? [];
}

export function checkoutEconomicBreakdown(
  intent: EconomicIntent,
):
  | {
      readonly subtotal: Money;
      readonly tax?: Money;
      readonly shipping?: Money;
    }
  | undefined {
  if (intent.economicValue) return undefined;
  return {
    subtotal: intent.subtotal,
    ...(intent.tax ? { tax: intent.tax } : {}),
    ...(intent.shipping ? { shipping: intent.shipping } : {}),
  };
}
