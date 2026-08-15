import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  loadAdminJwtIssuerConfiguration,
  parseAdminJwtIssuerConfiguration,
} from "../../src/infrastructure/config/admin-jwt-config.js";

function publicKeyBase64(type: "rsa" | "ed25519" = "rsa"): string {
  const pair =
    type === "rsa"
      ? generateKeyPairSync("rsa", { modulusLength: 2048 })
      : generateKeyPairSync("ed25519");
  const pem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  return Buffer.from(pem, "utf8").toString("base64");
}

describe("admin JWT issuer configuration", () => {
  it("is disabled when no issuer configuration is supplied", () => {
    expect(loadAdminJwtIssuerConfiguration({})).toEqual([]);
    expect(parseAdminJwtIssuerConfiguration("   ")).toEqual([]);
  });

  it("loads exact HTTPS issuer strings, audience, and pinned public keys", () => {
    const value = JSON.stringify({
      "https://login.example.test": {
        audience: "mino-admin",
        keys: {
          "rsa-1": publicKeyBase64("rsa"),
          "ed-1": publicKeyBase64("ed25519"),
        },
      },
    });

    const config = parseAdminJwtIssuerConfiguration(value);
    expect(config).toHaveLength(1);
    expect(config[0]?.issuer).toBe("https://login.example.test");
    expect(config[0]?.audience).toBe("mino-admin");
    expect(config[0]?.verificationKeys.size).toBe(2);
    expect(config[0]?.verificationKeys.get("rsa-1")).toContain("BEGIN PUBLIC KEY");
  });

  it("rejects non-HTTPS, query/fragment-bearing, or credential-bearing issuer URLs", () => {
    const key = publicKeyBase64();
    for (const issuer of [
      "http://login.example.test/",
      "https://user:pass@login.example.test/",
      "https://login.example.test/?tenant=x",
      "https://login.example.test/#fragment",
    ]) {
      expect(() =>
        parseAdminJwtIssuerConfiguration(
          JSON.stringify({ [issuer]: { audience: "mino-admin", keys: { key } } }),
        ),
      ).toThrow(/HTTPS URL/i);
    }
  });

  it("rejects empty audiences, empty key sets, malformed base64 PEM, and unsupported curves", () => {
    const key = publicKeyBase64();
    expect(() =>
      parseAdminJwtIssuerConfiguration(
        JSON.stringify({
          "https://login.example.test/": { audience: "", keys: { key } },
        }),
      ),
    ).toThrow(/audience/i);

    expect(() =>
      parseAdminJwtIssuerConfiguration(
        JSON.stringify({
          "https://login.example.test/": { audience: "mino-admin", keys: {} },
        }),
      ),
    ).toThrow(/keys/i);

    expect(() =>
      parseAdminJwtIssuerConfiguration(
        JSON.stringify({
          "https://login.example.test/": {
            audience: "mino-admin",
            keys: { key: Buffer.from("not a key").toString("base64") },
          },
        }),
      ),
    ).toThrow(/public PEM/i);

    const unsupported = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
    const unsupportedPem = unsupported.publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    expect(() =>
      parseAdminJwtIssuerConfiguration(
        JSON.stringify({
          "https://login.example.test/": {
            audience: "mino-admin",
            keys: { key: Buffer.from(unsupportedPem).toString("base64") },
          },
        }),
      ),
    ).toThrow(/RSA, P-256 EC, or Ed25519/i);
  });
});
