import { describe, expect, it } from "vitest";
import { ACPAdapter, ACPProtocolError } from "../../src/modules/proxy/acp-adapter.js";

const session = {
  id: "cs_1",
  status: "ready_for_payment",
  currency: "usd",
  line_items: [
    {
      id: "li_1",
      item: { id: "item_1", name: "Laptop Stand", unit_amount: 4000 },
      quantity: 2,
      category: "OFFICE_SUPPLIES",
      sku: "stand-1",
      totals: [{ type: "subtotal", amount: 8000 }],
    },
  ],
  totals: [
    { type: "subtotal", amount: 8000 },
    { type: "tax", amount: 700 },
    { type: "total", amount: 8700 },
  ],
};

describe("ACPAdapter", () => {
  it("normalizes authoritative merchant checkout state", () => {
    const intent = new ACPAdapter().normalizeCheckoutSession({
      session,
      requestId: "req-1",
      operation: "COMPLETE_CHECKOUT",
      organizationId: "org-1",
      userId: "user-1",
      agentId: "agent-1",
      merchant: { domain: "merchant.example" },
      idempotencyKey: "idem-1",
    });

    expect(intent.total).toEqual({ currency: "USD", minorUnits: 8700n });
    expect(intent.cart[0]?.category).toBe("OFFICE_SUPPLIES");
    expect(intent.cart[0]?.totalPrice.minorUnits).toBe(8000n);
  });

  it("rejects checkout state without an authoritative total", () => {
    const invalid = { ...session, totals: [{ type: "subtotal", amount: 8000 }] };
    expect(() =>
      new ACPAdapter().normalizeCheckoutSession({
        session: invalid,
        requestId: "req-1",
        operation: "COMPLETE_CHECKOUT",
        organizationId: "org-1",
        userId: "user-1",
        agentId: "agent-1",
        merchant: { domain: "merchant.example" },
        idempotencyKey: "idem-1",
      }),
    ).toThrowError(ACPProtocolError);
  });
});
