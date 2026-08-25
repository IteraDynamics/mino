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
  /** Per-attempt transport/audit provenance. This must not define intent identity. */
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
export type EconomicIntent = EconomicIntentBase & EconomicCounterpartyBinding;
