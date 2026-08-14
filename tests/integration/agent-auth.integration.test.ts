import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createClient } from "redis";
import { ApprovalMode, type AgentSpendMandate, type MandateTokenClaims } from "../../src/domain/mandates/mandate.types.js";
import { sha256Hex } from "../../src/infrastructure/crypto/canonical-json.js";
import { signEd25519 } from "../../src/infrastructure/crypto/ed25519.js";
import {
  AgentRequestError,
  AgentRequestErrorCode,
  AgentRequestVerifier,
  buildAgentSigningPayload,
} from "../../src/modules/agents/agent-request-verifier.js";
import { RedisNonceReplayGuard } from "../../src/modules/agents/redis-nonce-replay-guard.js";
import {
  MandateTokenError,
  MandateTokenErrorCode,
  MandateTokenService,
} from "../../src/modules/mandates/mandate-token.service.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const now = new Date("2026-08-13T20:00:00.000Z");
const nowSeconds = Math.floor(now.getTime() / 1000);

integration("Ed25519 mandate and agent-request boundary", () => {
  const minoKeys = generateKeyPairSync("ed25519");
  const agentKeys = generateKeyPairSync("ed25519");
  let redis: ReturnType<typeof createClient>;

  beforeAll(async () => {
    redis = createClient({ url: REDIS_URL });
    redis.on("error", () => undefined);
    await redis.connect();
  });

  beforeEach(async () => {
    await redis.flushDb();
  });

  afterAll(() => {
    redis.destroy();
  });

  function tokenHarness() {
    const jti = "integration-jti-001";
    const claims: MandateTokenClaims = {
      iss: "https://mino.example",
      sub: "agent-1",
      aud: "mino",
      jti,
      organizationId: "org-1",
      userId: "user-1",
      agentId: "agent-1",
      mandateId: "mandate-1",
      policyVersion: 3,
      iat: nowSeconds - 5,
      nbf: nowSeconds - 5,
      exp: nowSeconds + 300,
    };
    const mandate: AgentSpendMandate = {
      id: claims.mandateId,
      organizationId: claims.organizationId,
      userId: claims.userId,
      agentId: claims.agentId,
      policyId: "policy-1",
      policyVersion: claims.policyVersion,
      currency: "USD",
      maxBudgetPerTransactionMinor: 10_000n,
      rollingDailyLimitMinor: 20_000n,
      approvedMerchantDomains: ["merchant.example"],
      approvedVendorIds: [],
      restrictedCategories: [],
      approvalMode: ApprovalMode.AUTO_APPROVE,
      velocity: {
        maxTransactionsPerMinute: 10,
        crossMerchantWindowSeconds: 60,
        maxDistinctMerchantsInWindow: 3,
      },
      issuedAt: new Date((nowSeconds - 10) * 1000),
      expiresAt: new Date((nowSeconds + 600) * 1000),
      signingKeyId: "mino-k1",
      tokenJtiHash: sha256Hex(jti),
    };
    const service = new MandateTokenService(
      {
        async resolvePublicKey(keyId) {
          return keyId === "mino-k1" ? minoKeys.publicKey : undefined;
        },
      },
      { issuer: "https://mino.example" },
    );
    const token = service.issue(claims, {
      keyId: "mino-k1",
      privateKey: minoKeys.privateKey,
    });
    return { claims, mandate, service, token };
  }

  it("verifies a real signed mandate and binds it to the immutable mandate snapshot", async () => {
    const h = tokenHarness();
    const verified = await h.service.verify(h.token, now);
    expect(verified.claims.mandateId).toBe(h.mandate.id);
    expect(() => h.service.assertBoundToMandate(verified, h.mandate)).not.toThrow();
  });

  it("rejects an expired signed mandate", async () => {
    const h = tokenHarness();
    await expect(
      h.service.verify(h.token, new Date((h.claims.exp + 10) * 1000)),
    ).rejects.toMatchObject({ code: MandateTokenErrorCode.EXPIRED });
  });

  it("rejects a valid token when its server-side JTI binding no longer matches", async () => {
    const h = tokenHarness();
    const verified = await h.service.verify(h.token, now);
    const mismatched: AgentSpendMandate = {
      ...h.mandate,
      tokenJtiHash: "f".repeat(64),
    };
    expect(() => h.service.assertBoundToMandate(verified, mismatched)).toThrowError(
      MandateTokenError,
    );
    try {
      h.service.assertBoundToMandate(verified, mismatched);
    } catch (error) {
      expect((error as MandateTokenError).code).toBe(MandateTokenErrorCode.BINDING_MISMATCH);
    }
  });

  it("binds the agent signature to body/path/idempotency and rejects nonce replay in real Redis", async () => {
    const h = tokenHarness();
    const verified = await h.service.verify(h.token, now);
    const verifier = new AgentRequestVerifier(
      {
        async resolveAgentPublicKey(agentId, keyId) {
          return agentId === "agent-1" && keyId === "agent-k1"
            ? agentKeys.publicKey
            : undefined;
        },
      },
      new RedisNonceReplayGuard(redis),
    );

    const body = { payment_data: { token: "opaque-payment-token" } };
    const path = "/v1/acp/merchant-1/checkout_sessions/cs_1/complete";
    const timestamp = nowSeconds.toString(10);
    const nonce = "nonce_integration_000001";
    const idempotencyKey = "idem-agent-auth-1";
    const apiVersion = "2026-04-17";
    const signature = signEd25519(
      buildAgentSigningPayload({
        method: "POST",
        path,
        timestamp,
        nonce,
        body,
        mandateTokenJtiHash: verified.tokenJtiHash,
        idempotencyKey,
        apiVersion,
      }),
      agentKeys.privateKey,
    ).toString("base64url");

    const input = {
      method: "POST",
      path,
      body,
      mandateTokenJtiHash: verified.tokenJtiHash,
      idempotencyKey,
      apiVersion,
      expectedAgentId: "agent-1",
      proof: {
        agentId: "agent-1",
        keyId: "agent-k1",
        timestamp,
        nonce,
        signature,
      },
      now,
    } as const;

    await expect(verifier.verify(input)).resolves.toBeUndefined();
    await expect(verifier.verify(input)).rejects.toMatchObject({
      code: AgentRequestErrorCode.REPLAY_DETECTED,
    });

    const signProof = (proofNonce: string, signedPath: string, signedBody: unknown, signedIdempotencyKey: string) => ({
      agentId: "agent-1",
      keyId: "agent-k1",
      timestamp,
      nonce: proofNonce,
      signature: signEd25519(
        buildAgentSigningPayload({
          method: "POST",
          path: signedPath,
          timestamp,
          nonce: proofNonce,
          body: signedBody,
          mandateTokenJtiHash: verified.tokenJtiHash,
          idempotencyKey: signedIdempotencyKey,
          apiVersion,
        }),
        agentKeys.privateKey,
      ).toString("base64url"),
    });

    const mutatedBodyInput = {
      ...input,
      body: { payment_data: { token: "different-token" } },
      proof: signProof("nonce_integration_000002", path, body, idempotencyKey),
    };
    await expect(verifier.verify(mutatedBodyInput)).rejects.toMatchObject({
      code: AgentRequestErrorCode.SIGNATURE_INVALID,
    });

    const mutatedPathInput = {
      ...input,
      path: "/v1/acp/merchant-1/checkout_sessions/other/complete",
      proof: signProof("nonce_integration_000003", path, body, idempotencyKey),
    };
    await expect(verifier.verify(mutatedPathInput)).rejects.toMatchObject({
      code: AgentRequestErrorCode.SIGNATURE_INVALID,
    });

    const mutatedIdempotencyInput = {
      ...input,
      idempotencyKey: "different-idempotency-key",
      proof: signProof("nonce_integration_000004", path, body, idempotencyKey),
    };
    await expect(verifier.verify(mutatedIdempotencyInput)).rejects.toMatchObject({
      code: AgentRequestErrorCode.SIGNATURE_INVALID,
    });
  });

  it("fails agent identity mismatch before accepting a signed request", async () => {
    const verifier = new AgentRequestVerifier(
      { async resolveAgentPublicKey() { return agentKeys.publicKey; } },
      new RedisNonceReplayGuard(redis),
    );

    await expect(
      verifier.verify({
        method: "POST",
        path: "/test",
        body: {},
        mandateTokenJtiHash: "a".repeat(64),
        idempotencyKey: "idem",
        apiVersion: "2026-04-17",
        expectedAgentId: "agent-1",
        proof: {
          agentId: "agent-2",
          keyId: "agent-k1",
          timestamp: nowSeconds.toString(10),
          nonce: "nonce_integration_000005",
          signature: "not-used",
        },
        now,
      }),
    ).rejects.toBeInstanceOf(AgentRequestError);
  });
});
