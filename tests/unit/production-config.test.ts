import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadProductionConfig } from "../../src/infrastructure/config/production-config.js";

function b64Pem(type: "public" | "private"): string {
  const pair = generateKeyPairSync("ed25519");
  const key = type === "public" ? pair.publicKey : pair.privateKey;
  const pem = key.export({
    type: type === "public" ? "spki" : "pkcs8",
    format: "pem",
  }).toString();
  return Buffer.from(pem, "utf8").toString("base64");
}

function validEnvironment(): NodeJS.ProcessEnv {
  const mandatePublic = b64Pem("public");
  const auditPublic = b64Pem("public");
  return {
    DATABASE_URL: "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public",
    REDIS_URL: "redis://127.0.0.1:6379",
    MINO_ISSUER: "https://mino.example",
    MINO_MANDATE_PUBLIC_KEYS_B64_JSON: JSON.stringify({ "mino-k1": mandatePublic }),
    MINO_DELEGATION_SIGNING_KEY_ID: "delegation-k1",
    MINO_DELEGATION_PRIVATE_KEY_B64: b64Pem("private"),
    MINO_AUDIT_SIGNING_KEY_ID: "audit-k1",
    MINO_AUDIT_PRIVATE_KEY_B64: b64Pem("private"),
    MINO_AUDIT_PUBLIC_KEYS_B64_JSON: JSON.stringify({ "audit-k1": auditPublic }),
    MINO_APPROVAL_RESOLUTION_SECRET: "a".repeat(32),
    MINO_APPROVAL_WEBHOOK_URL: "https://approvals.example/webhook",
    MINO_APPROVAL_WEBHOOK_SECRET: "b".repeat(32),
    MINO_MERCHANT_CREDENTIALS_JSON: JSON.stringify({
      "org-1:merchant-1": "Bearer merchant-secret",
    }),
  };
}

describe("loadProductionConfig", () => {
  it("loads required production settings and secure credential maps", () => {
    const config = loadProductionConfig(validEnvironment());
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(3000);
    expect(config.mandateVerificationKeys.has("mino-k1")).toBe(true);
    expect(config.auditVerificationKeys.has("audit-k1")).toBe(true);
    expect(config.merchantCredentials.get("org-1:merchant-1")).toBe("Bearer merchant-secret");
  });

  it("fails closed when a critical secret is missing", () => {
    const environment = validEnvironment();
    delete environment.MINO_APPROVAL_RESOLUTION_SECRET;
    expect(() => loadProductionConfig(environment)).toThrow(/configuration is invalid or incomplete/i);
  });

  it("rejects non-HTTPS approval webhooks and malformed merchant credentials", () => {
    const insecure = validEnvironment();
    insecure.MINO_APPROVAL_WEBHOOK_URL = "http://approvals.example/webhook";
    expect(() => loadProductionConfig(insecure)).toThrow(/HTTPS/);

    const malformed = validEnvironment();
    malformed.MINO_MERCHANT_CREDENTIALS_JSON = JSON.stringify({
      "org-1:merchant-1": "plain-secret",
    });
    expect(() => loadProductionConfig(malformed)).toThrow(/invalid bearer credential/i);
  });
});
