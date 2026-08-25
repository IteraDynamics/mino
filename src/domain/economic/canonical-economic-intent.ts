import { canonicalJson, sha256Base64Url } from "../../infrastructure/crypto/canonical-json.js";
import type { AgentSpendMandate } from "../mandates/mandate.types.js";
import type { Money } from "../money.js";
import { resolveEconomicCounterparty } from "./counterparty-identity.js";
import {
  checkoutEconomicBreakdown,
  economicAmount,
  economicItems,
  type EconomicCounterpartyIdentity,
  type EconomicIntent,
  type EconomicLineItem,
  type EconomicOperation,
  type EconomicProviderProtocol,
} from "./economic-intent.types.js";

export const ECONOMIC_INTENT_SCHEMA_VERSION = 2 as const;

/** Facts that may exist around an economic action. Only authoritative/derived facts belong in the canonical digest. */
export type EconomicFactSource = "PROVIDER_AUTHORITATIVE" | "MINO_DERIVED" | "AGENT_ASSERTED";

export interface EconomicAuthorityReference {
  readonly organizationId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly mandateId: string;
  readonly policyId: string;
  readonly policyVersion: number;
}

export interface CanonicalEconomicIntent {
  readonly schemaVersion: typeof ECONOMIC_INTENT_SCHEMA_VERSION;
  readonly authority: EconomicAuthorityReference;
  readonly operation: EconomicOperation;
  readonly provider: {
    readonly protocol: EconomicProviderProtocol;
    /** Digest of the adapter's stable projection of provider-authoritative state. */
    readonly authoritativeStateDigest: string;
  };
  readonly counterparty: EconomicCounterpartyIdentity;
  readonly economics: {
    /** Total economic value that Mino authorizes, independent of provider/rail shape. */
    readonly amount: Money;
    /** Optional normalized economic components. Empty for value transfers without line items. */
    readonly items: readonly EconomicLineItem[];
    /** Checkout-only decomposition retained as evidence, not required by Core semantics. */
    readonly checkoutBreakdown?: {
      readonly subtotal: Money;
      readonly tax?: Money;
      readonly shipping?: Money;
    };
  };
  /** Raw idempotency keys are transport identifiers; canonical intent binds only their digest. */
  readonly idempotencyDigest: string;
}

export interface BoundEconomicIntent {
  readonly canonicalIntent: CanonicalEconomicIntent;
  readonly intentDigest: string;
}

export function authorityReferenceFromMandate(
  mandate: AgentSpendMandate,
): EconomicAuthorityReference {
  return {
    organizationId: mandate.organizationId,
    userId: mandate.userId,
    agentId: mandate.agentId,
    mandateId: mandate.id,
    policyId: mandate.policyId,
    policyVersion: mandate.policyVersion,
  };
}

/**
 * Elevate provider-normalized authoritative state into Mino's immutable pre-execution object.
 *
 * `requestId` and `rawPayload` are intentionally excluded: retries of the same semantic
 * action must produce the same intent digest, and arbitrary provider/agent payload text must
 * not become authorization truth merely because it was present on the request.
 */
export function bindEconomicIntent(
  intent: EconomicIntent,
  authority: EconomicAuthorityReference,
): BoundEconomicIntent {
  assertAuthorityBinding(intent, authority);

  const counterparty = resolveEconomicCounterparty(intent);
  if (!counterparty) {
    throw new Error("EconomicIntent requires an unambiguous normalized counterparty");
  }

  const authoritativeStateDigest = intent.authoritativeStateDigest?.trim();
  if (!authoritativeStateDigest || !/^[A-Za-z0-9_-]{43}$/.test(authoritativeStateDigest)) {
    throw new Error("EconomicIntent requires a SHA-256 base64url authoritative-state digest");
  }

  const amount = economicAmount(intent);
  const items = economicItems(intent);
  const checkoutBreakdown = checkoutEconomicBreakdown(intent);

  const canonicalIntent: CanonicalEconomicIntent = deepFreeze({
    schemaVersion: ECONOMIC_INTENT_SCHEMA_VERSION,
    authority: { ...authority },
    operation: intent.operation,
    provider: {
      protocol: intent.protocol,
      authoritativeStateDigest,
    },
    counterparty: cloneCounterparty(counterparty),
    economics: {
      amount: cloneMoney(amount),
      items: items.map(cloneLineItem),
      ...(checkoutBreakdown
        ? {
            checkoutBreakdown: {
              subtotal: cloneMoney(checkoutBreakdown.subtotal),
              ...(checkoutBreakdown.tax ? { tax: cloneMoney(checkoutBreakdown.tax) } : {}),
              ...(checkoutBreakdown.shipping
                ? { shipping: cloneMoney(checkoutBreakdown.shipping) }
                : {}),
            },
          }
        : {}),
    },
    idempotencyDigest: sha256Base64Url(intent.idempotencyKey),
  });

  return Object.freeze({
    canonicalIntent,
    intentDigest: sha256Base64Url(canonicalJson(canonicalIntent)),
  });
}

function assertAuthorityBinding(
  intent: EconomicIntent,
  authority: EconomicAuthorityReference,
): void {
  if (
    intent.organizationId !== authority.organizationId ||
    intent.userId !== authority.userId ||
    intent.agentId !== authority.agentId
  ) {
    throw new Error("EconomicIntent identity does not match delegated authority");
  }
}

function cloneCounterparty(value: EconomicCounterpartyIdentity): EconomicCounterpartyIdentity {
  return {
    kind: value.kind,
    identifiers: value.identifiers.map((identifier) => ({
      scheme: identifier.scheme,
      value: identifier.value,
      ...(identifier.namespace ? { namespace: identifier.namespace } : {}),
    })),
  };
}

function cloneLineItem(value: EconomicLineItem): EconomicLineItem {
  return {
    lineId: value.lineId,
    ...(value.sku ? { sku: value.sku } : {}),
    ...(value.productId ? { productId: value.productId } : {}),
    name: value.name,
    ...(value.category ? { category: value.category } : {}),
    quantity: value.quantity,
    unitPrice: cloneMoney(value.unitPrice),
    totalPrice: cloneMoney(value.totalPrice),
  };
}

function cloneMoney(value: Money): Money {
  return { currency: value.currency, minorUnits: value.minorUnits };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value as Record<string, unknown>)) {
      deepFreeze(entry);
    }
  }
  return value;
}
