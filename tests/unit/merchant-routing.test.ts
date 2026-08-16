import { describe, expect, it } from "vitest";
import { assertRegisteredHttpsTarget } from "../../src/modules/proxy/merchant-client.js";
import {
  MerchantRoutingValidationError,
  normalizeMerchantRoutingTarget,
} from "../../src/modules/proxy/merchant-routing.js";

describe("merchant routing validation", () => {
  it("canonicalizes a registered HTTPS origin", () => {
    expect(
      normalizeMerchantRoutingTarget(
        "Shop.Example.com.",
        "https://shop.example.com:443/",
      ),
    ).toEqual({
      domain: "shop.example.com",
      baseUrl: "https://shop.example.com",
    });
  });

  it.each([
    ["shop.example.com", "http://shop.example.com", "HTTPS"],
    ["shop.example.com", "https://other.example.com", "exactly match"],
    ["127.0.0.1", "https://127.0.0.1", "domain is invalid"],
    ["merchant", "https://merchant", "domain is invalid"],
    ["merchant.local", "https://merchant.local", "routable public hostname"],
    ["shop.example.com", "https://user:secret@shop.example.com", "user information"],
    ["shop.example.com", "https://shop.example.com/api", "HTTPS origin"],
    ["shop.example.com", "https://shop.example.com/?token=secret", "query or fragment"],
  ])("rejects unsafe route %s -> %s", (domain, baseUrl, message) => {
    expect(() => normalizeMerchantRoutingTarget(domain, baseUrl)).toThrow(MerchantRoutingValidationError);
    expect(() => normalizeMerchantRoutingTarget(domain, baseUrl)).toThrow(message);
  });

  it("applies the same validation at the outbound runtime boundary", () => {
    expect(() =>
      assertRegisteredHttpsTarget({
        id: "merchant-alpha",
        domain: "127.0.0.1",
        baseUrl: "https://127.0.0.1",
        active: true,
      }),
    ).toThrow("Merchant domain is invalid");

    expect(() =>
      assertRegisteredHttpsTarget({
        id: "merchant-alpha",
        domain: "shop.example.com",
        baseUrl: "https://shop.example.com",
        active: false,
      }),
    ).toThrow("Merchant is inactive");
  });
});