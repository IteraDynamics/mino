import type {
  CheckoutIntent,
  CheckoutOperation,
  MerchantIdentity,
} from "../../domain/checkout/checkout.types.js";

export const ACP_STABLE_VERSION = "2026-04-17";

export interface ACPCheckoutSession {
  readonly id: string;
  readonly status: string;
  readonly currency: string;
  readonly line_items: readonly ACPLineItem[];
  readonly totals: readonly ACPTotal[];
  readonly protocol?: { readonly version?: string };
  readonly [key: string]: unknown;
}

export interface ACPLineItem {
  readonly id: string;
  readonly item: {
    readonly id: string;
    readonly name?: string;
    readonly unit_amount?: number;
  };
  readonly quantity: number;
  readonly name?: string;
  readonly description?: string;
  readonly unit_amount?: number;
  readonly product_id?: string;
  readonly sku?: string;
  readonly category?: string;
  readonly totals?: readonly ACPTotal[];
  readonly [key: string]: unknown;
}

export interface ACPTotal {
  readonly type: string;
  readonly amount: number;
  readonly display_text?: string;
}

export interface NormalizeACPCheckoutInput {
  readonly session: unknown;
  readonly requestId: string;
  readonly operation: CheckoutOperation;
  readonly organizationId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly merchant: MerchantIdentity;
  readonly idempotencyKey: string;
}

export class ACPAdapter {
  public normalizeCheckoutSession(input: NormalizeACPCheckoutInput): CheckoutIntent {
    const session = parseCheckoutSession(input.session);
    const currency = session.currency.trim().toUpperCase();
    const total = requiredTotal(session.totals, "total");
    const subtotal = optionalTotal(session.totals, "subtotal") ?? sumLineSubtotals(session.line_items);
    const tax = optionalTotal(session.totals, "tax");
    const shipping = optionalTotal(session.totals, "fulfillment");

    return {
      requestId: input.requestId,
      protocol: "ACP",
      operation: input.operation,
      organizationId: input.organizationId,
      userId: input.userId,
      agentId: input.agentId,
      merchant: input.merchant,
      cart: session.line_items.map((line) => {
        const unitAmount = requireSafeMinorUnit(line.unit_amount ?? line.item.unit_amount, "line item unit_amount");
        const lineTotal = optionalTotal(line.totals ?? [], "subtotal") ?? unitAmount * line.quantity;
        return {
          lineId: line.id,
          productId: line.product_id ?? line.item.id,
          ...(line.sku ? { sku: line.sku } : {}),
          name: line.name ?? line.item.name ?? line.item.id,
          ...(line.category ? { category: line.category } : {}),
          quantity: line.quantity,
          unitPrice: { currency, minorUnits: BigInt(unitAmount) },
          totalPrice: { currency, minorUnits: BigInt(lineTotal) },
        };
      }),
      subtotal: { currency, minorUnits: BigInt(subtotal) },
      ...(tax !== undefined ? { tax: { currency, minorUnits: BigInt(tax) } } : {}),
      ...(shipping !== undefined
        ? { shipping: { currency, minorUnits: BigInt(shipping) } }
        : {}),
      total: { currency, minorUnits: BigInt(total) },
      idempotencyKey: input.idempotencyKey,
      rawPayload: session,
    };
  }
}

export function parseCheckoutSession(value: unknown): ACPCheckoutSession {
  if (!isRecord(value)) {
    throw new ACPProtocolError("ACP checkout session must be a JSON object");
  }

  const id = requireString(value.id, "id");
  const status = requireString(value.status, "status");
  const currency = requireString(value.currency, "currency");
  const lineItems = value.line_items;
  const totals = value.totals;

  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    throw new ACPProtocolError("ACP checkout session line_items must be a non-empty array");
  }
  if (!Array.isArray(totals)) {
    throw new ACPProtocolError("ACP checkout session totals must be an array");
  }

  return {
    ...value,
    id,
    status,
    currency,
    line_items: lineItems.map(parseLineItem),
    totals: totals.map(parseTotal),
  } as ACPCheckoutSession;
}

export class ACPProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ACPProtocolError";
  }
}

function parseLineItem(value: unknown): ACPLineItem {
  if (!isRecord(value)) {
    throw new ACPProtocolError("ACP line item must be an object");
  }
  if (!isRecord(value.item)) {
    throw new ACPProtocolError("ACP line item item must be an object");
  }

  const quantity = value.quantity;
  if (!Number.isSafeInteger(quantity) || (quantity as number) <= 0) {
    throw new ACPProtocolError("ACP line item quantity must be a positive integer");
  }

  const itemId = requireString(value.item.id, "line item item.id");
  const itemUnitAmount = optionalSafeMinorUnit(value.item.unit_amount, "item.unit_amount");
  const lineUnitAmount = optionalSafeMinorUnit(value.unit_amount, "line item unit_amount");
  if (itemUnitAmount === undefined && lineUnitAmount === undefined) {
    throw new ACPProtocolError("ACP line item must expose an authoritative unit_amount");
  }

  return {
    ...value,
    id: requireString(value.id, "line item id"),
    item: {
      ...value.item,
      id: itemId,
      ...(typeof value.item.name === "string" ? { name: value.item.name } : {}),
      ...(itemUnitAmount !== undefined ? { unit_amount: itemUnitAmount } : {}),
    },
    quantity: quantity as number,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(lineUnitAmount !== undefined ? { unit_amount: lineUnitAmount } : {}),
    ...(typeof value.product_id === "string" ? { product_id: value.product_id } : {}),
    ...(typeof value.sku === "string" ? { sku: value.sku } : {}),
    ...(typeof value.category === "string" ? { category: value.category } : {}),
    ...(Array.isArray(value.totals) ? { totals: value.totals.map(parseTotal) } : {}),
  } as ACPLineItem;
}

function parseTotal(value: unknown): ACPTotal {
  if (!isRecord(value)) {
    throw new ACPProtocolError("ACP total must be an object");
  }
  return {
    type: requireString(value.type, "total type"),
    amount: requireSafeMinorUnit(value.amount, "total amount"),
    ...(typeof value.display_text === "string" ? { display_text: value.display_text } : {}),
  };
}

function requiredTotal(totals: readonly ACPTotal[], type: string): number {
  const total = optionalTotal(totals, type);
  if (total === undefined) {
    throw new ACPProtocolError(`ACP checkout session is missing ${type} total`);
  }
  return total;
}

function optionalTotal(totals: readonly ACPTotal[], type: string): number | undefined {
  const normalized = type.toLowerCase();
  const matches = totals.filter((entry) => entry.type.trim().toLowerCase() === normalized);
  if (matches.length > 1) {
    throw new ACPProtocolError(`ACP checkout session contains duplicate ${type} totals`);
  }
  return matches[0]?.amount;
}

function sumLineSubtotals(lineItems: readonly ACPLineItem[]): number {
  let total = 0;
  for (const line of lineItems) {
    const unitAmount = requireSafeMinorUnit(line.unit_amount ?? line.item.unit_amount, "line item unit_amount");
    const lineSubtotal = optionalTotal(line.totals ?? [], "subtotal") ?? unitAmount * line.quantity;
    if (!Number.isSafeInteger(lineSubtotal) || lineSubtotal < 0) {
      throw new ACPProtocolError("ACP calculated line subtotal is outside safe integer range");
    }
    total += lineSubtotal;
    if (!Number.isSafeInteger(total)) {
      throw new ACPProtocolError("ACP calculated subtotal is outside safe integer range");
    }
  }
  return total;
}

function requireSafeMinorUnit(value: unknown, field: string): number {
  const parsed = optionalSafeMinorUnit(value, field);
  if (parsed === undefined) {
    throw new ACPProtocolError(`ACP ${field} is required`);
  }
  return parsed;
}

function optionalSafeMinorUnit(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ACPProtocolError(`ACP ${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ACPProtocolError(`ACP ${field} must be a non-empty string`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
