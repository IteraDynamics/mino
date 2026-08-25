import { createHash, generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createClient } from "redis";
import type { ProductionConfig } from "../../src/infrastructure/config/production-config.js";
import { sha256Hex } from "../../src/infrastructure/crypto/canonical-json.js";
import { signEd25519 } from "../../src/infrastructure/crypto/ed25519.js";
import { StaticMandateVerificationKeyResolver } from "../../src/infrastructure/crypto/static-key-providers.js";
import { buildAgentSigningPayload } from "../../src/modules/agents/agent-request-verifier.js";
import { MandateTokenService } from "../../src/modules/mandates/mandate-token.service.js";
import { buildPersonalMandateSigningPayload } from "../../src/modules/personal/personal-authority.service.js";
import { buildPersonalPairingSigningPayload } from "../../src/modules/personal/personal-pairing.service.js";
import type { ACPMerchantClient, MerchantRequestHeaders } from "../../src/modules/proxy/merchant-client.js";
import { createProductionApplication } from "../../src/production/application.js";
import { registerPersonalProductionSurface } from "../../src/production/personal-surface.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const now = new Date("2026-08-24T18:30:00.000Z");
const nowSeconds = Math.floor(now.getTime() / 1_000);
const ownerIssuer = "https://personal-owner.test";
const ownerAudience = "mino-personal-test";
const ownerSubject = "personal-execution-owner";
const merchantId = "personal-sandbox-merchant";
const merchantRowId = "74000000-0000-4000-8000-000000000001";

integration("Mino Personal production execution boundary", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  beforeEach(async () => {
    await cleanupPersonal(pool);
    const redis = createClient({ url: REDIS_URL });
    redis.on("error", () => undefined);
    await redis.connect();
    await redis.flushDb();
    await redis.quit();
  });

  afterAll(async () => {
    await cleanupPersonal(pool);
    await pool.end();
  });

  it("uses server merchant credentials, routes over-limit completion to the owner, retries exactly once, and fails closed after revoke", async () => {
    const mandateKeys = generateKeyPairSync("ed25519");
    const delegationKeys = generateKeyPairSync("ed25519");
    const auditKeys = generateKeyPairSync("ed25519");
    const ownerJwtKeys = generateKeyPairSync("ed25519");
    const agentKeys = generateKeyPairSync("ed25519");

    const mandatePublic = pemPublic(mandateKeys.publicKey);
    const mandatePrivate = pemPrivate(mandateKeys.privateKey);
    const delegationPrivate = pemPrivate(delegationKeys.privateKey);
    const auditPublic = pemPublic(auditKeys.publicKey);
    const auditPrivate = pemPrivate(auditKeys.privateKey);
    const ownerJwtPublic = pemPublic(ownerJwtKeys.publicKey);
    const agentPublic = pemPublic(agentKeys.publicKey);
    const agentPrivate = pemPrivate(agentKeys.privateKey);
    const merchantCredentials = new Map<string, string>();

    const config: ProductionConfig = {
      databaseUrl: DATABASE_URL,
      redisUrl: REDIS_URL,
      host: "127.0.0.1",
      port: 3000,
      issuer: "https://mino.example",
      mandateVerificationKeys: new Map([["personal-m1", mandatePublic]]),
      mandateSigningKey: { keyId: "personal-m1", privateKey: mandatePrivate },
      delegationSigningKey: { keyId: "delegation-k1", privateKey: delegationPrivate },
      auditSigningKey: { keyId: "audit-k1", privateKey: auditPrivate },
      auditVerificationKeys: new Map([["audit-k1", auditPublic]]),
      approvalResolutionSecret: "r".repeat(32),
      approvalWebhook: {
        endpoint: "https://approvals.example/webhook",
        secret: "w".repeat(32),
      },
      merchantCredentials,
    };

    let completeCalls = 0;
    const observedAuthorizations: string[] = [];
    const observe = (headers: MerchantRequestHeaders) => {
      observedAuthorizations.push(headers.authorization);
    };
    const merchantClient: ACPMerchantClient = {
      async createCheckout() {
        throw new Error("Personal economic boundary does not create checkout sessions");
      },
      async getCheckout(_merchant, _checkoutSessionId, headers) {
        observe(headers);
        return { status: 200, body: readyCheckout() };
      },
      async completeCheckout(_merchant, _checkoutSessionId, _payload, headers) {
        observe(headers);
        completeCalls += 1;
        return {
          status: 200,
          body: {
            ...readyCheckout(),
            status: "completed",
            order: { id: "personal-order-1" },
          },
        };
      },
      async cancelCheckout() {
        throw new Error("not used");
      },
    };

    const production = await createProductionApplication(config, {
      merchantClient,
      now: () => now,
      logger: false,
    });
    const personalSurface = await registerPersonalProductionSurface(
      production.app,
      config,
      [
        {
          issuer: ownerIssuer,
          audience: ownerAudience,
          verificationKeys: new Map([["owner-k1", ownerJwtPublic]]),
        },
      ],
      () => now,
    );
    if (!personalSurface) throw new Error("Personal surface was not registered");

    const ownerToken = signOwnerJwt(ownerJwtKeys.privateKey, {
      issuer: ownerIssuer,
      audience: ownerAudience,
      subject: ownerSubject,
    });
    const ownerAuthorization = `Bearer ${ownerToken}`;

    try {
      const bootstrap = await production.app.inject({
        method: "POST",
        url: "/v1/personal/bootstrap",
        headers: { authorization: ownerAuthorization },
        payload: { beneficiaryEmail: "personal-execution@example.test", displayName: "Owner" },
      });
      expect(bootstrap.statusCode).toBe(201);
      const owner = bootstrap.json().owner as {
        organizationId: string;
        userId: string;
      };

      merchantCredentials.set(
        `${owner.organizationId}:${merchantId}`,
        "Bearer server-side-personal-merchant-credential",
      );
      await pool.query(
        `insert into "MerchantEndpoint" (
           "id", "organizationId", "externalMerchantId", "domain", "baseUrl", "active", "createdAt", "updatedAt"
         ) values ($1::uuid, $2::uuid, $3, 'shop.example', 'https://merchant.example', true, $4, $4)`,
        [merchantRowId, owner.organizationId, merchantId, now],
      );

      const keyId = "openclaw-execution-k1";
      const externalAgentId = "openclaw-execution";
      const pairingNonce = "personal-execution-pairing-nonce";
      const fingerprint = createHash("sha256")
        .update(agentKeys.publicKey.export({ type: "spki", format: "der" }))
        .digest("base64url");
      const pairingPayload = buildPersonalPairingSigningPayload({
        externalAgentId,
        displayName: "OpenClaw",
        keyId,
        publicKeyFingerprint: fingerprint,
        timestamp: nowSeconds,
        nonce: pairingNonce,
      });
      const pairingResponse = await production.app.inject({
        method: "POST",
        url: "/v1/personal/pairing-requests",
        payload: {
          externalAgentId,
          displayName: "OpenClaw",
          keyId,
          publicKey: agentPublic,
          proof: {
            timestamp: nowSeconds,
            nonce: pairingNonce,
            signature: signEd25519(pairingPayload, agentPrivate).toString("base64url"),
          },
        },
      });
      expect(pairingResponse.statusCode).toBe(201);
      const pairing = pairingResponse.json().pairing as { id: string; claimSecret: string };

      const claimed = await production.app.inject({
        method: "POST",
        url: `/v1/personal/pairing-requests/${pairing.id}/claim`,
        headers: { authorization: ownerAuthorization },
        payload: { claimSecret: pairing.claimSecret },
      });
      expect(claimed.statusCode).toBe(200);
      const agentId = claimed.json().pairing.agentId as string;

      const authority = await production.app.inject({
        method: "PUT",
        url: `/v1/personal/agents/${agentId}/authority`,
        headers: { authorization: ownerAuthorization },
        payload: {
          currency: "USD",
          perTransactionLimit: "40.00",
          dailyLimit: "200.00",
          allowedMerchantDomains: ["shop.example"],
          overLimitBehavior: "ASK_OWNER",
        },
      });
      expect(authority.statusCode).toBe(201);
      expect(authority.json().authority.profile.perTransactionLimit).toBe("40.00");

      const mandateNonce = "personal-execution-mandate-nonce";
      const mandatePayload = buildPersonalMandateSigningPayload(
        agentId,
        keyId,
        nowSeconds,
        mandateNonce,
      );
      const mandateResponse = await production.app.inject({
        method: "POST",
        url: `/v1/personal/agents/${agentId}/mandate`,
        payload: {
          keyId,
          timestamp: nowSeconds,
          nonce: mandateNonce,
          signature: signEd25519(mandatePayload, agentPrivate).toString("base64url"),
        },
      });
      expect(mandateResponse.statusCode).toBe(201);
      const mandateToken = mandateResponse.json().mandateToken as string;
      const tokens = new MandateTokenService(
        new StaticMandateVerificationKeyResolver(new Map([["personal-m1", mandatePublic]])),
        { issuer: config.issuer },
      );
      const verified = await tokens.verify(mandateToken, now);

      const checkoutSessionId = "cs_personal_execution";
      const path = `/v1/personal/acp/${merchantId}/checkout_sessions/${checkoutSessionId}/complete`;
      const body = { payment_data: { token: "personal-sensitive-payment-token" } };
      const idempotencyKey = "personal-execution-idempotency-1";

      const pending = await injectSignedCompletion({
        app: production.app,
        path,
        body,
        idempotencyKey,
        mandateToken,
        mandateTokenJtiHash: verified.tokenJtiHash,
        agentId,
        keyId,
        privateKey: agentPrivate,
        nonce: "personal-execution-request-nonce-1",
      });
      expect(pending.statusCode).toBe(202);
      expect(pending.json().decision.verdict).toBe("PENDING_HUMAN_APPROVAL");
      expect(pending.json().approval_request_id).toBeTruthy();
      expect(completeCalls).toBe(0);
      const approvalRequestId = pending.json().approval_request_id as string;

      const approval = await production.app.inject({
        method: "GET",
        url: `/v1/personal/approvals/${approvalRequestId}`,
        headers: { authorization: ownerAuthorization },
      });
      expect(approval.statusCode).toBe(200);
      expect(approval.json().approval).toMatchObject({
        id: approvalRequestId,
        status: "PENDING",
        merchantDomain: "shop.example",
        amountMinor: "5000",
        currency: "USD",
      });

      const approved = await production.app.inject({
        method: "POST",
        url: `/v1/personal/approvals/${approvalRequestId}/decision`,
        headers: { authorization: ownerAuthorization },
        payload: { decision: "APPROVE", comment: "Approved for integration test" },
      });
      expect(approved.statusCode).toBe(200);
      expect(approved.json().approval.status).toBe("APPROVED");

      const completed = await injectSignedCompletion({
        app: production.app,
        path,
        body,
        idempotencyKey,
        mandateToken,
        mandateTokenJtiHash: verified.tokenJtiHash,
        agentId,
        keyId,
        privateKey: agentPrivate,
        nonce: "personal-execution-request-nonce-2",
      });
      expect(completed.statusCode).toBe(200);
      expect(completed.json().decision.verdict).toBe("ALLOW");
      expect(completed.json().decision.reasons).toContain("HUMAN_APPROVAL_GRANTED");
      expect(completeCalls).toBe(1);
      expect(observedAuthorizations.length).toBeGreaterThanOrEqual(2);
      expect(new Set(observedAuthorizations)).toEqual(
        new Set(["Bearer server-side-personal-merchant-credential"]),
      );

      const outcome = await pool.query<{ status: string }>(
        `select "status"::text as "status" from "PaymentOutcome"
          where "organizationId" = $1::uuid and "idempotencyKey" = $2`,
        [owner.organizationId, idempotencyKey],
      );
      expect(outcome.rows[0]?.status).toBe("SUCCEEDED");

      const revoke = await production.app.inject({
        method: "DELETE",
        url: `/v1/personal/agents/${agentId}/authority`,
        headers: { authorization: ownerAuthorization },
      });
      expect(revoke.statusCode).toBe(200);
      expect(revoke.json().outcome).toBe("REVOKED");

      const afterRevoke = await injectSignedCompletion({
        app: production.app,
        path,
        body,
        idempotencyKey: "personal-execution-idempotency-after-revoke",
        mandateToken,
        mandateTokenJtiHash: verified.tokenJtiHash,
        agentId,
        keyId,
        privateKey: agentPrivate,
        nonce: "personal-execution-request-nonce-3",
      });
      expect(afterRevoke.statusCode).toBe(401);
      expect(afterRevoke.json().error).toBe("UNAUTHORIZED");
      expect(completeCalls).toBe(1);
    } finally {
      await personalSurface.close();
      await production.close();
    }
  });
});

async function injectSignedCompletion(input: {
  readonly app: { inject(options: unknown): Promise<{ statusCode: number; json(): any }> };
  readonly path: string;
  readonly body: unknown;
  readonly idempotencyKey: string;
  readonly mandateToken: string;
  readonly mandateTokenJtiHash: string;
  readonly agentId: string;
  readonly keyId: string;
  readonly privateKey: string;
  readonly nonce: string;
}) {
  const timestamp = nowSeconds.toString(10);
  const signingPayload = buildAgentSigningPayload({
    method: "POST",
    path: input.path,
    timestamp,
    nonce: input.nonce,
    body: input.body,
    mandateTokenJtiHash: input.mandateTokenJtiHash,
    idempotencyKey: input.idempotencyKey,
    apiVersion: "2026-04-17",
  });
  const signature = signEd25519(signingPayload, input.privateKey).toString("base64url");
  return input.app.inject({
    method: "POST",
    url: input.path,
    headers: {
      "api-version": "2026-04-17",
      "idempotency-key": input.idempotencyKey,
      "x-mino-mandate-token": input.mandateToken,
      "x-mino-agent-id": input.agentId,
      "x-mino-agent-key-id": input.keyId,
      "x-mino-agent-timestamp": timestamp,
      "x-mino-agent-nonce": input.nonce,
      "x-mino-agent-signature": signature,
    },
    payload: input.body,
  });
}

function signOwnerJwt(
  privateKey: Parameters<typeof signEd25519>[1],
  input: { readonly issuer: string; readonly audience: string; readonly subject: string },
): string {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: "owner-k1" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: input.issuer,
      sub: input.subject,
      aud: input.audience,
      iat: nowSeconds - 5,
      nbf: nowSeconds - 5,
      exp: nowSeconds + 3_600,
    }),
  ).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const signature = signEd25519(signingInput, privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

function readyCheckout() {
  return {
    id: "cs_personal_execution",
    status: "ready_for_payment",
    currency: "usd",
    line_items: [
      {
        id: "line-personal",
        item: {
          id: "personal-item",
          name: "Personal integration item",
          unit_amount: 5_000,
        },
        quantity: 1,
        category: "OFFICE_SUPPLIES",
        totals: [{ type: "subtotal", amount: 5_000 }],
      },
    ],
    totals: [
      { type: "subtotal", amount: 5_000 },
      { type: "total", amount: 5_000 },
    ],
  };
}

function pemPublic(key: ReturnType<typeof generateKeyPairSync>["publicKey"]): string {
  return key.export({ type: "spki", format: "pem" }).toString();
}

function pemPrivate(key: ReturnType<typeof generateKeyPairSync>["privateKey"]): string {
  return key.export({ type: "pkcs8", format: "pem" }).toString();
}

async function cleanupPersonal(pool: Pool): Promise<void> {
  await pool.query('delete from "PersonalPairingRequest"');
  const organizations = await pool.query<{ id: string }>(
    `select "id" from "Organization" where "kind" = 'PERSONAL'`,
  );
  const ids = organizations.rows.map((row) => row.id);
  if (ids.length > 0) {
    await pool.query('delete from "PaymentOutcome" where "organizationId" = any($1::uuid[])', [ids]);
    await pool.query('delete from "SpendReservation" where "organizationId" = any($1::uuid[])', [ids]);
    await pool.query('delete from "ApprovalRequest" where "organizationId" = any($1::uuid[])', [ids]);
    await pool.query('delete from "AuditLog" where "organizationId" = any($1::uuid[])', [ids]);
    await pool.query('delete from "AgentMandate" where "organizationId" = any($1::uuid[])', [ids]);
    await pool.query('delete from "Policy" where "organizationId" = any($1::uuid[])', [ids]);
    await pool.query('delete from "MerchantEndpoint" where "organizationId" = any($1::uuid[])', [ids]);
    await pool.query('delete from "AgentIdentity" where "organizationId" = any($1::uuid[])', [ids]);
    await pool.query('delete from "User" where "organizationId" = any($1::uuid[])', [ids]);
  }
  await pool.query('delete from "PersonalOwner"');
  await pool.query(`delete from "Organization" where "kind" = 'PERSONAL'`);
}
