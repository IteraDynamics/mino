import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadProductionConfig } from "../../src/infrastructure/config/production-config.js";

function keyPairPem(): { publicB64: string; privateB64: string; privatePem: string } {
  const pair = generateKeyPairSync("ed25519");
  const publicPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return {
    publicB64: Buffer.from(publicPem, "utf8").toString("base64"),
    privateB64: Buffer.from(privatePem, "utf8").toString("base64"),
    privatePem,
  };
}

function validEnvironment(): NodeJS.ProcessEnv {
  const mandate = keyPairPem();
  const delegation = keyPairPem();
  const audit = keyPairPem();
  return {
    DATABASE_URL: "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public",
    REDIS_URL: "redis://127.0.0.1:6379",
    MINO_ISSUER: "https://mino.example",
    MINO_MANDATE_PUBLIC_KEYS_B64_JSON: JSON.stringify({ "mino-k1": mandate.publicB64 }),
    MINO_DELEGATION_SIGNING_KEY_ID: "delegation-k1",
    MINO_DELEGATION_PRIVATE_KEY_B64: delegation.privateB64,
    MINO_AUDIT_SIGNING_KEY_ID: "audit-k1",
    MINO_AUDIT_PRIVATE_KEY_B64: audit.privateB64,
    MINO_AUDIT_PUBLIC_KEYS_B64_JSON: JSON.stringify({ "audit-k1": audit.publicB64 }),
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
    expect(() => loadProductionConfig(environment)).toThrow(/exactly one secret source/i);
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

  it("loads private keys, HMAC secrets, and merchant credentials from mounted secret files", () => {
    const environment = validEnvironment();
    const directory = mkdtempSync(join(tmpdir(), "mino-secrets-"));
    try {
      const delegation = Buffer.from(environment.MINO_DELEGATION_PRIVATE_KEY_B64 as string, "base64").toString("utf8");
      const audit = Buffer.from(environment.MINO_AUDIT_PRIVATE_KEY_B64 as string, "base64").toString("utf8");
      const delegationPath = join(directory, "delegation.pem");
      const auditPath = join(directory, "audit.pem");
      const resolutionPath = join(directory, "approval-resolution");
      const webhookPath = join(directory, "approval-webhook");
      const merchantsPath = join(directory, "merchant-credentials.json");
      writeFileSync(delegationPath, delegation);
      writeFileSync(auditPath, audit);
      writeFileSync(resolutionPath, "r".repeat(40));
      writeFileSync(webhookPath, "w".repeat(40));
      writeFileSync(merchantsPath, JSON.stringify({ "org-1:merchant-1": "Bearer rotated-secret" }));

      delete environment.MINO_DELEGATION_PRIVATE_KEY_B64;
      delete environment.MINO_AUDIT_PRIVATE_KEY_B64;
      delete environment.MINO_APPROVAL_RESOLUTION_SECRET;
      delete environment.MINO_APPROVAL_WEBHOOK_SECRET;
      delete environment.MINO_MERCHANT_CREDENTIALS_JSON;
      environment.MINO_DELEGATION_PRIVATE_KEY_FILE = delegationPath;
      environment.MINO_AUDIT_PRIVATE_KEY_FILE = auditPath;
      environment.MINO_APPROVAL_RESOLUTION_SECRET_FILE = resolutionPath;
      environment.MINO_APPROVAL_WEBHOOK_SECRET_FILE = webhookPath;
      environment.MINO_MERCHANT_CREDENTIALS_FILE = merchantsPath;

      const config = loadProductionConfig(environment);
      expect(config.delegationSigningKey.privateKey).toContain("BEGIN PRIVATE KEY");
      expect(config.approvalResolutionSecret).toBe("r".repeat(40));
      expect(config.approvalWebhook.secret).toBe("w".repeat(40));
      expect(config.merchantCredentials.get("org-1:merchant-1")).toBe("Bearer rotated-secret");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous inline plus file secret configuration", () => {
    const environment = validEnvironment();
    environment.MINO_APPROVAL_WEBHOOK_SECRET_FILE = "/tmp/also-a-secret";
    expect(() => loadProductionConfig(environment)).toThrow(/exactly one secret source/i);
  });

  it("rejects an audit private key that does not match the active public key ID", () => {
    const environment = validEnvironment();
    environment.MINO_AUDIT_PRIVATE_KEY_B64 = keyPairPem().privateB64;
    expect(() => loadProductionConfig(environment)).toThrow(/does not match/i);
  });

  it("allows historical audit verification keys to remain during active-key rotation", () => {
    const environment = validEnvironment();
    const oldKey = keyPairPem();
    const currentMap = JSON.parse(environment.MINO_AUDIT_PUBLIC_KEYS_B64_JSON as string) as Record<string, string>;
    environment.MINO_AUDIT_PUBLIC_KEYS_B64_JSON = JSON.stringify({
      "audit-old": oldKey.publicB64,
      ...currentMap,
    });
    const config = loadProductionConfig(environment);
    expect(config.auditVerificationKeys.has("audit-old")).toBe(true);
    expect(config.auditVerificationKeys.has("audit-k1")).toBe(true);
  });
});
