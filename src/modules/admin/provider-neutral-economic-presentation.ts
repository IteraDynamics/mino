import type { EconomicCounterpartyIdentity } from "../../domain/economic/counterparty-identity.js";

export interface AdminEconomicProviderPresentation {
  readonly protocol: string;
}

export interface AdminEconomicPresentation {
  readonly counterparty: EconomicCounterpartyIdentity;
  readonly executionReference?: string;
  readonly provider?: AdminEconomicProviderPresentation;
}

/**
 * Compatibility carrier for the merchant/checkout-shaped admin records that
 * predate Mino's provider-neutral economic model.
 *
 * Presentation code may project these fields into neutral vocabulary, but must
 * not reinterpret them as new authorization authority or mutate persistence.
 */
export interface LegacyAdminEconomicCarrier {
  readonly merchantDomain: string;
  readonly merchantVendorId?: string | undefined;
  readonly checkoutSessionId?: string | undefined;
  readonly protocol?: string | undefined;
}

export type AdminEconomicallyPresented<T extends LegacyAdminEconomicCarrier> = T & {
  readonly economic: AdminEconomicPresentation;
};

export function presentAdminEconomicRecord<T extends LegacyAdminEconomicCarrier>(
  record: T,
): AdminEconomicallyPresented<T> {
  const counterparty = merchantCounterpartyPresentation(record);
  const executionReference = normalizedOptional(record.checkoutSessionId);
  const protocol = normalizedOptional(record.protocol);

  return {
    ...record,
    economic: {
      counterparty,
      ...(executionReference ? { executionReference } : {}),
      ...(protocol ? { provider: { protocol } } : {}),
    },
  };
}

export function presentAdminEconomicPage<T extends LegacyAdminEconomicCarrier>(
  page: { readonly items: readonly T[]; readonly nextCursor?: string | undefined },
): {
  readonly items: readonly AdminEconomicallyPresented<T>[];
  readonly nextCursor?: string | undefined;
} {
  return {
    ...page,
    items: page.items.map((item) => presentAdminEconomicRecord(item)),
  };
}

function merchantCounterpartyPresentation(
  record: LegacyAdminEconomicCarrier,
): EconomicCounterpartyIdentity {
  const domain = record.merchantDomain.trim();
  if (!domain) {
    throw new Error("Admin economic presentation requires a merchant domain");
  }

  const vendorId = normalizedOptional(record.merchantVendorId);
  return {
    kind: "MERCHANT",
    identifiers: [
      { scheme: "DOMAIN", value: domain },
      ...(vendorId ? [{ scheme: "VENDOR_ID" as const, value: vendorId }] : []),
    ],
  };
}

function normalizedOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
