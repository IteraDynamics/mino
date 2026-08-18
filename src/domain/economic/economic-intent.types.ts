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
 * this field; adapters may preserve it for evidence and downstream protocol work.
 */
export type EconomicProviderProtocol = "ACP" | "STRIPE" | "CUSTOM";

/**
 * Provider-neutral economic operation understood by Mino's authorization core.
 * Names remain checkout-oriented while the transaction surface is migrated
 * incrementally; operation meaning is independent of the execution provider.
 */
export type EconomicOperation =
  | "CREATE_CHECKOUT_SESSION"
  | "UPDATE_CHECKOUT_SESSION"
  | "COMPLETE_CHECKOUT"
  | "AUTHORIZE_PAYMENT";

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

interface EconomicIntentBase {
  readonly requestId: UUID;
  readonly protocol: EconomicProviderProtocol;
  readonly operation: EconomicOperation;
  readonly organizationId: UUID;
  readonly userId: UUID;
  readonly agentId: UUID;
  readonly cart: readonly EconomicLineItem[];
  readonly subtotal: Money;
  readonly tax?: Money;
  readonly shipping?: Money;
  readonly total: Money;
  readonly idempotencyKey: string;
  readonly rawPayload: unknown;
}

/**
 * Canonical provider-neutral recipient identity plus a temporary compatibility
 * bridge for checkout callers that still construct only the legacy merchant shape.
 *
 * New provider adapters should supply `counterparty`. The existing ACP adapter emits
 * both representations from one source so downstream ACP-only evidence and request
 * binding remain byte-for-byte compatible while the authorization core moves to the
 * generalized identity. When both are present, policy evaluation requires them to
 * agree and fails closed on ambiguity.
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
 * Canonical provider-neutral input to Mino's economic authorization semantics.
 *
 * `protocol` and `rawPayload` are provenance only. The policy evaluator derives
 * authorization meaning from normalized identities, counterparty scope, categories,
 * amounts, spend/velocity state, and mandate controls. Equivalent normalized intents
 * must therefore evaluate equivalently regardless of execution provider.
 */
export type EconomicIntent = EconomicIntentBase & EconomicCounterpartyBinding;
