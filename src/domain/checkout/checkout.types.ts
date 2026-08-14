import type { Money } from "../money.js";
import type { UUID } from "../mandates/mandate.types.js";

export type CommerceProtocol = "ACP" | "STRIPE" | "CUSTOM";

export type CheckoutOperation =
  | "CREATE_CHECKOUT_SESSION"
  | "UPDATE_CHECKOUT_SESSION"
  | "COMPLETE_CHECKOUT"
  | "AUTHORIZE_PAYMENT";

export interface MerchantIdentity {
  readonly domain: string;
  readonly vendorId?: string;
}

export interface CartLine {
  readonly lineId: string;
  readonly sku?: string;
  readonly productId?: string;
  readonly name: string;
  readonly category?: string;
  readonly quantity: number;
  readonly unitPrice: Money;
  readonly totalPrice: Money;
}

export interface CheckoutIntent {
  readonly requestId: UUID;
  readonly protocol: CommerceProtocol;
  readonly operation: CheckoutOperation;
  readonly organizationId: UUID;
  readonly userId: UUID;
  readonly agentId: UUID;
  readonly merchant: MerchantIdentity;
  readonly cart: readonly CartLine[];
  readonly subtotal: Money;
  readonly tax?: Money;
  readonly shipping?: Money;
  readonly total: Money;
  readonly idempotencyKey: string;
  readonly rawPayload: unknown;
}
