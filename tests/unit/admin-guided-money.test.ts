import { describe, expect, it } from "vitest";
import {
  majorCurrencyToMinor,
  minorCurrencyToMajor,
} from "../../src/console/admin-guided-setup-console-script.js";

describe("guided policy money conversion", () => {
  it("converts supported major-unit amounts to exact minor-unit strings without floating point", () => {
    expect(majorCurrencyToMinor("2500.00", "USD")).toBe("250000");
    expect(majorCurrencyToMinor("2,500.05", "USD")).toBe("250005");
    expect(majorCurrencyToMinor("2500", "JPY")).toBe("2500");
    expect(majorCurrencyToMinor("12.345", "BHD")).toBe("12345");
    expect(majorCurrencyToMinor("0.001", "KWD")).toBe("1");
    expect(majorCurrencyToMinor("1.2", "EUR")).toBe("120");
  });

  it("renders persisted minor-unit values back into exact major-unit form inputs", () => {
    expect(minorCurrencyToMajor("250005", "USD")).toBe("2500.05");
    expect(minorCurrencyToMajor("2500", "JPY")).toBe("2500");
    expect(minorCurrencyToMajor("1", "BHD")).toBe("0.001");
    expect(minorCurrencyToMajor("-125", "GBP")).toBe("-1.25");
  });

  it("rejects malformed, negative, over-precision, and unsupported major-unit input", () => {
    expect(() => majorCurrencyToMinor("-1.00", "USD")).toThrow();
    expect(() => majorCurrencyToMinor("1.001", "USD")).toThrow(/at most 2 decimal places/);
    expect(() => majorCurrencyToMinor("1.0", "JPY")).toThrow(/does not use fractional minor units/);
    expect(() => majorCurrencyToMinor("1,00.00", "USD")).toThrow();
    expect(() => majorCurrencyToMinor("1e3", "USD")).toThrow();
    expect(() => majorCurrencyToMinor("10.00", "XXX")).toThrow(/Unsupported policy currency/);
  });
});
