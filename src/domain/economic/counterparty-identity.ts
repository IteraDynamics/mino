export type EconomicCounterpartyKind = "MERCHANT" | "ACCOUNT" | "WALLET" | "OTHER";

export type EconomicCounterpartyIdentifierScheme =
  | "DOMAIN"
  | "VENDOR_ID"
  | "PROVIDER_REFERENCE"
  | "ACCOUNT_REFERENCE"
  | "WALLET_ADDRESS";

export interface EconomicCounterpartyIdentifier {
  readonly scheme: EconomicCounterpartyIdentifierScheme;
  readonly value: string;
  readonly namespace?: string;
}

/**
 * Provider-neutral identity for the recipient/destination of economic value.
 *
 * Identifiers are normalized authorization facts, not routing instructions or
 * credentials. A provider may contribute provider-native references, but policy
 * meaning must derive from the normalized identity rather than provider payloads.
 */
export interface EconomicCounterpartyIdentity {
  readonly kind: EconomicCounterpartyKind;
  readonly identifiers: readonly EconomicCounterpartyIdentifier[];
}

/** Existing ACP/checkout merchant projection retained during the transition. */
export interface EconomicMerchantIdentity {
  readonly domain: string;
  readonly vendorId?: string;
}

export interface EconomicCounterpartyCarrier {
  readonly counterparty?: EconomicCounterpartyIdentity | undefined;
  readonly merchant?: EconomicMerchantIdentity | undefined;
}

/** Build the canonical counterparty identity for the existing merchant model. */
export function merchantCounterparty(
  merchant: EconomicMerchantIdentity,
): EconomicCounterpartyIdentity {
  return {
    kind: "MERCHANT",
    identifiers: [
      { scheme: "DOMAIN", value: merchant.domain },
      ...(merchant.vendorId
        ? [{ scheme: "VENDOR_ID" as const, value: merchant.vendorId }]
        : []),
    ],
  };
}

/**
 * Resolve the canonical identity while preserving a fail-closed compatibility
 * bridge for checkout callers that still supply only `merchant`.
 *
 * When both representations are present they must agree exactly on the legacy
 * merchant projection; contradictory identity state is rejected as ambiguous.
 */
export function resolveEconomicCounterparty(
  carrier: EconomicCounterpartyCarrier,
): EconomicCounterpartyIdentity | undefined {
  const canonical = carrier.counterparty;
  const legacy = carrier.merchant;

  if (canonical && !isUsableCounterparty(canonical)) {
    return undefined;
  }

  if (canonical && legacy) {
    const projection = merchantProjectionFromCounterparty(canonical);
    if (!projection || !sameMerchantProjection(projection, legacy)) {
      return undefined;
    }
    return canonical;
  }

  if (canonical) {
    return canonical;
  }

  if (legacy && isUsableMerchant(legacy)) {
    return merchantCounterparty(legacy);
  }

  return undefined;
}

/**
 * Project the currently supported merchant policy selectors from a generalized
 * counterparty. Non-merchant or ambiguous identities return undefined so current
 * merchant-scoped mandates fail closed instead of silently authorizing them.
 */
export function merchantProjectionFromCounterparty(
  counterparty: EconomicCounterpartyIdentity,
): EconomicMerchantIdentity | undefined {
  if (counterparty.kind !== "MERCHANT" || !isUsableCounterparty(counterparty)) {
    return undefined;
  }

  const domains = identifierValues(counterparty, "DOMAIN");
  const vendorIds = identifierValues(counterparty, "VENDOR_ID");
  if (domains.length !== 1 || vendorIds.length > 1) {
    return undefined;
  }

  const domain = domains[0];
  if (!domain) {
    return undefined;
  }

  const vendorId = vendorIds[0];
  return {
    domain,
    ...(vendorId ? { vendorId } : {}),
  };
}

export function resolveMerchantPolicyProjection(
  carrier: EconomicCounterpartyCarrier,
): EconomicMerchantIdentity | undefined {
  const counterparty = resolveEconomicCounterparty(carrier);
  return counterparty
    ? merchantProjectionFromCounterparty(counterparty)
    : undefined;
}

function identifierValues(
  counterparty: EconomicCounterpartyIdentity,
  scheme: EconomicCounterpartyIdentifierScheme,
): string[] {
  return counterparty.identifiers
    .filter((identifier) => identifier.scheme === scheme)
    .map((identifier) => identifier.value.trim())
    .filter(Boolean);
}

function isUsableCounterparty(counterparty: EconomicCounterpartyIdentity): boolean {
  return (
    counterparty.identifiers.length > 0 &&
    counterparty.identifiers.every(
      (identifier) =>
        identifier.value.trim().length > 0 &&
        (identifier.namespace === undefined || identifier.namespace.trim().length > 0),
    )
  );
}

function isUsableMerchant(merchant: EconomicMerchantIdentity): boolean {
  return (
    merchant.domain.trim().length > 0 &&
    (merchant.vendorId === undefined || merchant.vendorId.trim().length > 0)
  );
}

function sameMerchantProjection(
  left: EconomicMerchantIdentity,
  right: EconomicMerchantIdentity,
): boolean {
  return left.domain === right.domain && left.vendorId === right.vendorId;
}
