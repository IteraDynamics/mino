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
    MINO_MANDATE_SIGNING_KEY_ID: "mino-k1",
    MINO_MANDATE_PRIVATE_KEY_B64: mandate.privateB64,
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
  it("loads required production settings and distinct secure signing inputs", () => {
    const config = loadProductionConfig(validEnvironment());
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(3000);
    expect(config.mandateVerificationKeys.has("mino-k1")).toBe(true);
    expect(config.mandateSigningKey?.keyId).toBe("mino-k1");
    expect(config.mandateSigningKey?.privateKey).toContain("BEGIN PRIVATE KEY");
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

  it("loads database and Redis URLs from mounted secret files", () => {
    const environment = validEnvironment();
    const directory = mkdtempSync(join(tmpdir(), "mino-connection-secrets-"));
    try {
      const databasePath = join(directory, "database_url");
      const redisPath = join(directory, "redis_url");
      writeFileSync(databasePath, `${environment.DATABASE_URL}\n`);
      writeFileSync(redisPath, `${environment.REDIS_URL}\n`);

      delete environment.DATABASE_URL;
      delete environment.REDIS_URL;
      environment.DATABASE_URL_FILE = databasePath;
      environment.REDIS_URL_FILE = redisPath;

      const config = loadProductionConfig(environment);
      expect(config.databaseUrl).toBe("postgresql://mino:mino@127.0.0.1:5432/mino?schema=public");
      expect(config.redisUrl).toBe("redis://127.0.0.1:6379");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous or missing database and Redis connection secret sources", () => {
    const databaseAmbiguous = validEnvironment();
    databaseAmbiguous.DATABASE_URL_FILE = "/tmp/database_url";
    expect(() => loadProductionConfig(databaseAmbiguous)).toThrow(/DATABASE_URL.*exactly one secret source/i);

    const redisAmbiguous = validEnvironment();
    redisAmbiguous.REDIS_URL_FILE = "/tmp/redis_url";
    expect(() => loadProductionConfig(redisAmbiguous)).toThrow(/REDIS_URL.*exactly one secret source/i);

    const databaseMissing = validEnvironment();
    delete databaseMissing.DATABASE_URL;
    expect(() => loadProductionConfig(databaseMissing)).toThrow(/DATABASE_URL.*exactly one secret source/i);

    const redisMissing = validEnvironment();
    delete redisMissing.REDIS_URL;
    expect(() => loadProductionConfig(redisMissing)).toThrow(/REDIS_URL.*exactly one secret source/i);
  });

  it("loads private keys, HMAC secrets, and merchant credentials from mounted secret files", () => {
    const environment = validEnvironment();
    const directory = mkdtempSync(join(tmpdir(), "mino-secrets-"));
    try {
      const mandate = Buffer.from(environment.MINO_MANDATE_PRIVATE_KEY_B64 as string, "base64").toString("utf8");
      const delegation = Buffer.from(environment.MINO_DELEGATION_PRIVATE_KEY_B64 as string, "base64").toString("utf8");
      const audit = Buffer.from(environment.MINO_AUDIT_PRIVATE_KEY_B64 as string, "base64").toString("utf8");
      const mandatePath = join(directory, "mandate.pem");
      const delegationPath = join(directory, "delegation.pem");
      const auditPath = join(directory, "audit.pem");
      const resolutionPath = join(directory, "approval-resolution");
      const webhookPath = join(directory, "approval-webhook");
      const merchantsPath = join(directory, "merchant-credentials.json");
      writeFileSync(mandatePath, mandate);
      writeFileSync(delegationPath, delegation);
      writeFileSync(auditPath, audit);
      writeFileSync(resolutionPath, "r".repeat(40));
      writeFileSync(webhookPath, "w".repeat(40));
      writeFileSync(merchantsPath, JSON.stringify({ "org-1:merchant-1": "Bearer rotated-secret" }));

      delete environment.MINO_MANDATE_PRIVATE_KEY_B64;
      delete environment.MINO_DELEGATION_PRIVATE_KEY_B64;
      delete environment.MINO_AUDIT_PRIVATE_KEY_B64;
      delete environment.MINO_APPROVAL_RESOLUTION_SECRET;
      delete environment.MINO_APPROVAL_WEBHOOK_SECRET;
      delete environment.MINO_MERCHANT_CREDENTIALS_JSON;
      environment.MINO_MANDATE_PRIVATE_KEY_FILE = mandatePath;
      environment.MINO_DELEGATION_PRIVATE_KEY_FILE = delegationPath;
      environment.MINO_AUDIT_PRIVATE_KEY_FILE = auditPath;
      environment.MINO_APPROVAL_RESOLUTION_SECRET_FILE = resolutionPath;
      environment.MINO_APPROVAL_WEBHOOK_SECRET_FILE = webhookPath;
      environment.MINO_MERCHANT_CREDENTIALS_FILE = merchantsPath;

      const config = loadProductionConfig(environment);
      expect(config.mandateSigningKey?.privateKey).toContain("BEGIN PRIVATE KEY");
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

    const mandateEnvironment = validEnvironment();
    mandateEnvironment.MINO_MANDATE_PRIVATE_KEY_FILE = "/tmp/also-a-mandate-key";
    expect(() => loadProductionConfig(mandateEnvironment)).toThrow(/MINO_MANDATE_PRIVATE_KEY.*exactly one secret source/i);
  });

  it("rejects signing private keys that do not match their active public key IDs", () => {
    const mandateEnvironment = validEnvironment();
    mandateEnvironment.MINO_MANDATE_PRIVATE_KEY_B64 = keyPairPem().privateB64;
    expect(() => loadProductionConfig(mandateEnvironment)).toThrow(/MINO_MANDATE_SIGNING_KEY_ID.*does not match/i);

    const auditEnvironment = validEnvironment();
    auditEnvironment.MINO_AUDIT_PRIVATE_KEY_B64 = keyPairPem().privateB64;
    expect(() => loadProductionConfig(auditEnvironment)).toThrow(/does not match/i);
  });

  it("allows historical verification keys to remain during active-key rotation", () => {
    const environment = validEnvironment();
    const oldMandateKey = keyPairPem();
    const oldAuditKey = keyPairPem();
    const mandateMap = JSON.parse(environment.MINO_MANDATE_PUBLIC_KEYS_B64_JSON as string) as Record<string, string>;
    const auditMap = JSON.parse(environment.MINO_AUDIT_PUBLIC_KEYS_B64_JSON as string) as Record<string, string>;
    environment.MINO_MANDATE_PUBLIC_KEYS_B64_JSON = JSON.stringify({
      "mino-old": oldMandateKey.publicB64,
      ...mandateMap,
    });
    environment.MINO_AUDIT_PUBLIC_KEYS_B64_JSON = JSON.stringify({
      "audit-old": oldAuditKey.publicB64,
      ...auditMap,
    });
    const config = loadProductionConfig(environment);
    expect(config.mandateVerificationKeys.has("mino-old")).toBe(true);
    expect(config.mandateVerificationKeys.has("mino-k1")).toBe(true);
    expect(config.auditVerificationKeys.has("audit-old")).toBe(true);
    expect(config.auditVerificationKeys.has("audit-k1")).toBe(true);
  });
});
