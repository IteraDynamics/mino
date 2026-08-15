import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ProductionConfig } from "../../src/infrastructure/config/production-config.js";
import { createProductionApplication } from "../../src/production/application.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const metricsToken = "production-metrics-token-abcdefghijklmnopqrstuvwxyz";

integration("production operational metrics composition", () => {
  it("keeps /metrics absent when disabled and exposes it only with the dedicated credential", async () => {
    const config = productionConfig();

    const disabled = await createProductionApplication(config, { logger: false });
    try {
      const response = await disabled.app.inject({ method: "GET", url: "/metrics" });
      expect(response.statusCode).toBe(404);
    } finally {
      await disabled.close();
    }

    const enabled = await createProductionApplication(config, {
      logger: false,
      operationalMetrics: { bearerToken: metricsToken },
    });
    try {
      const missing = await enabled.app.inject({ method: "GET", url: "/metrics" });
      expect(missing.statusCode).toBe(401);

      const authorized = await enabled.app.inject({
        method: "GET",
        url: "/metrics",
        headers: { authorization: `Bearer ${metricsToken}` },
      });
      expect(authorized.statusCode).toBe(200);
      expect(authorized.headers["content-type"]).toContain("text/plain");
      expect(authorized.body).toContain("# TYPE mino_audit_decisions gauge");
      expect(authorized.body).toContain("mino_payment_outcomes");
      expect(authorized.body).toContain("mino_unresolved_payments");
      expect(authorized.body).not.toContain("organization_id");
      expect(authorized.body).not.toContain("merchant_id");
      expect(authorized.body).not.toContain("idempotency");
    } finally {
      await enabled.close();
    }
  });
});

function productionConfig(): ProductionConfig {
  const mandateKeys = generateKeyPairSync("ed25519");
  const delegationKeys = generateKeyPairSync("ed25519");
  const auditKeys = generateKeyPairSync("ed25519");

  return {
    databaseUrl: DATABASE_URL,
    redisUrl: REDIS_URL,
    host: "127.0.0.1",
    port: 3000,
    issuer: "https://mino.example",
    mandateVerificationKeys: new Map([["mino-k1", pemPublic(mandateKeys.publicKey)]]),
    delegationSigningKey: {
      keyId: "delegation-k1",
      privateKey: pemPrivate(delegationKeys.privateKey),
    },
    auditSigningKey: {
      keyId: "audit-k1",
      privateKey: pemPrivate(auditKeys.privateKey),
    },
    auditVerificationKeys: new Map([["audit-k1", pemPublic(auditKeys.publicKey)]]),
    approvalResolutionSecret: "r".repeat(32),
    approvalWebhook: {
      endpoint: "https://approvals.example/webhook",
      secret: "w".repeat(32),
    },
    merchantCredentials: new Map(),
  };
}

function pemPublic(key: ReturnType<typeof generateKeyPairSync>["publicKey"]): string {
  return key.export({ type: "spki", format: "pem" }).toString();
}

function pemPrivate(key: ReturnType<typeof generateKeyPairSync>["privateKey"]): string {
  return key.export({ type: "pkcs8", format: "pem" }).toString();
}
