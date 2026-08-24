import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parsePersonalJwtIssuerConfiguration } from "../../src/infrastructure/config/personal-jwt-config.js";

describe("Personal JWT issuer configuration", () => {
  it("loads an isolated trusted issuer configuration for the Personal surface", () => {
    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const value = JSON.stringify({
      "https://login.personal.test": {
        audience: "mino-personal",
        keys: { "personal-k1": Buffer.from(publicKey, "utf8").toString("base64") },
      },
    });

    const issuers = parsePersonalJwtIssuerConfiguration(value);
    expect(issuers).toHaveLength(1);
    expect(issuers[0]?.issuer).toBe("https://login.personal.test");
    expect(issuers[0]?.audience).toBe("mino-personal");
    expect(issuers[0]?.verificationKeys.get("personal-k1")).toBe(publicKey);
  });

  it("keeps the Personal surface disabled when no issuer is configured", () => {
    expect(parsePersonalJwtIssuerConfiguration(undefined)).toEqual([]);
  });

  it("rejects non-HTTPS issuers", () => {
    expect(() =>
      parsePersonalJwtIssuerConfiguration(
        JSON.stringify({
          "http://insecure.test": {
            audience: "mino-personal",
            keys: { k1: Buffer.from("not-a-key").toString("base64") },
          },
        }),
      ),
    ).toThrow(/HTTPS/);
  });
});
