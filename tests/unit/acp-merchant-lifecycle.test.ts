import { afterEach, describe, expect, it, vi } from "vitest";
import { FetchACPMerchantClient, type MerchantEndpoint } from "../../src/modules/proxy/merchant-client.js";

const merchant: MerchantEndpoint = {
  id: "merchant-1",
  domain: "merchant.example",
  baseUrl: "https://merchant.example/acp/",
  active: true,
};

const baseHeaders = {
  requestId: "request-1",
  apiVersion: "2026-04-17",
  authorization: "Bearer merchant-secret",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("FetchACPMerchantClient checkout lifecycle", () => {
  it("retrieves the stable ACP checkout path without body or Idempotency-Key", async () => {
    const fetchMock = mockJsonResponse({ id: "cs/with space", status: "not_ready" });
    const client = new FetchACPMerchantClient();

    await client.getCheckout(merchant, "cs/with space", baseHeaders);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [target, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(target.toString()).toBe("https://merchant.example/checkout_sessions/cs%2Fwith%20space");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.redirect).toBe("error");
    const headers = init.headers as Record<string, string>;
    expect(headers["API-Version"]).toBe("2026-04-17");
    expect(headers["Request-Id"]).toBe("request-1");
    expect(headers["Authorization"]).toBe("Bearer merchant-secret");
    expect(headers["Idempotency-Key"]).toBeUndefined();
    expect(headers["Content-Type"]).toBeUndefined();
  });

  it("updates the stable ACP checkout path with POST payload and Idempotency-Key", async () => {
    const fetchMock = mockJsonResponse({ id: "cs_1", status: "not_ready" });
    const client = new FetchACPMerchantClient();
    const payload = { line_items: [{ id: "line-1", quantity: 2 }] };

    await client.updateCheckout(merchant, "cs_1", payload, {
      ...baseHeaders,
      idempotencyKey: "idem-update",
    });

    const [target, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(target.toString()).toBe("https://merchant.example/checkout_sessions/cs_1");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify(payload));
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("idem-update");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("cancels the stable ACP checkout path with POST payload and Idempotency-Key", async () => {
    const fetchMock = mockJsonResponse({ id: "cs_1", status: "canceled" });
    const client = new FetchACPMerchantClient();
    const payload = { intent_trace: { reason: "agent_cancelled" } };

    await client.cancelCheckout(merchant, "cs_1", {
      ...baseHeaders,
      idempotencyKey: "idem-cancel",
    }, payload);

    const [target, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(target.toString()).toBe("https://merchant.example/checkout_sessions/cs_1/cancel");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify(payload));
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("idem-cancel");
  });

  it("refuses a lifecycle request when the ACP API version is not the pinned stable version", async () => {
    const fetchMock = mockJsonResponse({ id: "cs_1" });
    const client = new FetchACPMerchantClient();

    await expect(
      client.getCheckout(merchant, "cs_1", {
        ...baseHeaders,
        apiVersion: "2099-01-01",
      }),
    ).rejects.toThrow(/unsupported ACP API version/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function mockJsonResponse(body: unknown) {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}