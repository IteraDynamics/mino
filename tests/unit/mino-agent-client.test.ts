import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MinoACPAgentClient,
  MinoAgentRequestSigner,
  MinoAgentTransportError,
  createMinoIdempotencyKey,
  generateEd25519AgentKeyPair,
} from "../../src/client/mino-agent-client.js";
import {
  AgentRequestError,
  AgentRequestErrorCode,
  AgentRequestVerifier,
} from "../../src/modules/agents/agent-request-verifier.js";
import { sha256Hex } from "../../src/infrastructure/crypto/canonical-json.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const mandateId = "22222222-2222-4222-8222-222222222222";
const jti = "mandate-jti-reference-client";
const now = new Date("2026-08-20T19:30:00.000Z");

function compactMandateToken(boundAgentId = agentId): string {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "mino+mandate+jwt", kid: "mino-k1", v: 1 })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({
    iss: "https://mino.example",
    sub: boundAgentId,
    aud: "mino",
    jti,
    organizationId: "33333333-3333-4333-8333-333333333333",
    userId: "44444444-4444-4444-8444-444444444444",
    agentId: boundAgentId,
    mandateId,
    policyVersion: 1,
    iat: 1787254200,
    nbf: 1787254200,
    exp: 1787257800,
  })).toString("base64url");
  return `${header}.${claims}.${Buffer.from("reference-signature").toString("base64url")}`;
}

function sequenceNonce(...values: string[]) {
  let index = 0;
  return () => {
    const value = values[index];
    if (!value) throw new Error("nonce sequence exhausted");
    index += 1;
    return value;
  };
}

function jsonResponse(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

describe("Mino agent integration kit", () => {
  it("generates Ed25519 enrollment material and stable caller-owned idempotency keys", () => {
    const pair = generateEd25519AgentKeyPair("procurement-k1");
    expect(pair.keyId).toBe("procurement-k1");
    expect(pair.publicKeyPem).toContain("BEGIN PUBLIC KEY");
    expect(pair.privateKeyPem).toContain("BEGIN PRIVATE KEY");
    expect(createMinoIdempotencyKey()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("produces a proof accepted by the real server verifier", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const signer = new MinoAgentRequestSigner({
      agentId,
      keyId: "agent-k1",
      privateKey,
      mandateToken: compactMandateToken(),
      now: () => now,
      nonce: () => "nonce_reference_client_001",
    });
    const body = { line_items: [{ id: "sku-1", quantity: 1 }] };
    const signed = signer.sign({
      method: "POST",
      path: "/v1/acp/supplier/checkout_sessions/cs_123/complete",
      body,
      idempotencyKey: "complete-order-123",
      apiVersion: "2026-04-17",
    });

    const claimed = new Set<string>();
    const verifier = new AgentRequestVerifier(
      { async resolveAgentPublicKey(resolvedAgentId, keyId) {
        return resolvedAgentId === agentId && keyId === "agent-k1" ? publicKey : undefined;
      } },
      { async claim(resolvedAgentId, nonce) {
        const key = `${resolvedAgentId}:${nonce}`;
        if (claimed.has(key)) return false;
        claimed.add(key);
        return true;
      } },
    );

    await expect(verifier.verify({
      method: "POST",
      path: "/v1/acp/supplier/checkout_sessions/cs_123/complete",
      body,
      mandateTokenJtiHash: sha256Hex(jti),
      idempotencyKey: "complete-order-123",
      apiVersion: "2026-04-17",
      expectedAgentId: agentId,
      proof: signed.proof,
      now,
    })).resolves.toBeUndefined();
    expect(signed.headers["x-mino-mandate-token"]).toBe(compactMandateToken());
  });

  it("binds the signature to body and semantic idempotency rather than permitting mutation", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const signer = new MinoAgentRequestSigner({
      agentId,
      keyId: "agent-k1",
      privateKey,
      mandateToken: compactMandateToken(),
      now: () => now,
      nonce: () => "nonce_reference_client_002",
    });
    const signed = signer.sign({
      method: "POST",
      path: "/v1/acp/supplier/checkout_sessions/cs_123/complete",
      body: { confirmation: true },
      idempotencyKey: "complete-order-123",
      apiVersion: "2026-04-17",
    });
    const verifier = new AgentRequestVerifier(
      { async resolveAgentPublicKey() { return publicKey; } },
      { async claim() { return true; } },
    );

    await expect(verifier.verify({
      method: "POST",
      path: "/v1/acp/supplier/checkout_sessions/cs_123/complete",
      body: { confirmation: false },
      mandateTokenJtiHash: sha256Hex(jti),
      idempotencyKey: "complete-order-123",
      apiVersion: "2026-04-17",
      expectedAgentId: agentId,
      proof: signed.proof,
      now,
    })).rejects.toMatchObject({ code: AgentRequestErrorCode.SIGNATURE_INVALID });
  });

  it("refuses to sign with a mandate token bound to another agent", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    expect(() => new MinoAgentRequestSigner({
      agentId,
      keyId: "agent-k1",
      privateKey,
      mandateToken: compactMandateToken("55555555-5555-4555-8555-555555555555"),
    })).toThrow("different agent identity");
  });

  it("omits idempotency on retrieval and sends exact signed control headers", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const client = new MinoACPAgentClient({
      baseUrl: "https://mino.example/",
      agentId,
      keyId: "agent-k1",
      privateKey,
      mandateToken: compactMandateToken(),
      merchantAuthorization: "Bearer merchant-secret",
      now: () => now,
      nonce: () => "nonce_reference_client_003",
      fetchImpl: async (input, init = {}) => {
        requests.push({ url: String(input), init });
        return jsonResponse(200, { decision: { verdict: "ALLOW" }, checkout_session_id: "cs_123" });
      },
    });

    const result = await client.retrieveCheckout("supplier", "cs_123");
    expect(result.kind).toBe("success");
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    const headers = new Headers(request.init.headers);
    expect(request.url).toBe("https://mino.example/v1/acp/supplier/checkout_sessions/cs_123");
    expect(request.init.method).toBe("GET");
    expect(request.init.body).toBeUndefined();
    expect(headers.get("idempotency-key")).toBeNull();
    expect(headers.get("authorization")).toBe("Bearer merchant-secret");
    expect(headers.get("api-version")).toBe("2026-04-17");
    expect(headers.get("x-mino-agent-id")).toBe(agentId);
    expect(headers.get("x-mino-agent-nonce")).toBe("nonce_reference_client_003");
  });

  it("reuses caller idempotency while refreshing nonce and signature across approved completion retries", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const nonces = ["nonce_reference_retry_001", "nonce_reference_retry_002"];
    const requests: RequestInit[] = [];
    let call = 0;
    const client = new MinoACPAgentClient({
      baseUrl: "https://mino.example",
      agentId,
      keyId: "agent-k1",
      privateKey,
      mandateToken: compactMandateToken(),
      merchantAuthorization: "Bearer merchant-secret",
      now: () => now,
      nonce: sequenceNonce(...nonces),
      fetchImpl: async (_input, init = {}) => {
        requests.push(init);
        call += 1;
        return call === 1
          ? jsonResponse(202, { decision: { verdict: "PENDING_HUMAN_APPROVAL" }, approval_request_id: "approval-1" })
          : jsonResponse(200, { decision: { verdict: "ALLOW" }, payment_outcome_id: "payment-1" });
      },
    });

    const key = "complete-order-456";
    const body = { confirmation: true };
    const pending = await client.completeCheckout("supplier", "cs_456", body, key);
    expect(pending.kind).toBe("approval_required");
    expect(pending.retry).toEqual({
      mode: "after_approval_same_request",
      reuseIdempotencyKey: true,
      freshAgentProof: true,
    });

    const allowed = await client.completeCheckout("supplier", "cs_456", body, key);
    expect(allowed.kind).toBe("success");
    const firstHeaders = new Headers(requests[0]!.headers);
    const secondHeaders = new Headers(requests[1]!.headers);
    expect(firstHeaders.get("idempotency-key")).toBe(key);
    expect(secondHeaders.get("idempotency-key")).toBe(key);
    expect(firstHeaders.get("x-mino-agent-nonce")).toBe(nonces[0]);
    expect(secondHeaders.get("x-mino-agent-nonce")).toBe(nonces[1]);
    expect(firstHeaders.get("x-mino-agent-signature")).not.toBe(secondHeaders.get("x-mino-agent-signature"));
  });

  it("surfaces unresolved payment retry timing without automatically dispatching again", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const client = new MinoACPAgentClient({
      baseUrl: "https://mino.example",
      agentId,
      keyId: "agent-k1",
      privateKey,
      mandateToken: compactMandateToken(),
      merchantAuthorization: "Bearer merchant-secret",
      nonce: () => "nonce_reference_pending_001",
      fetchImpl: async () => jsonResponse(
        409,
        { error: "PAYMENT_OUTCOME_PENDING", payment_outcome_id: "payment-2" },
        { "retry-after": "2" },
      ),
    });

    const result = await client.completeCheckout("supplier", "cs_pending", {}, "complete-pending-1");
    expect(result.kind).toBe("payment_pending");
    expect(result.retry).toEqual({
      mode: "after_delay_same_request",
      reuseIdempotencyKey: true,
      freshAgentProof: true,
      retryAfterMs: 2000,
    });
  });

  it("does not label idempotency conflicts or transport uncertainty as automatic retries", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const conflictClient = new MinoACPAgentClient({
      baseUrl: "https://mino.example",
      agentId,
      keyId: "agent-k1",
      privateKey,
      mandateToken: compactMandateToken(),
      merchantAuthorization: "Bearer merchant-secret",
      nonce: () => "nonce_reference_conflict_001",
      fetchImpl: async () => jsonResponse(409, { error: "IDEMPOTENCY_CONFLICT" }),
    });
    const conflict = await conflictClient.completeCheckout("supplier", "cs_1", {}, "complete-conflict-1");
    expect(conflict.kind).toBe("idempotency_conflict");
    expect(conflict.retry.mode).toBe("none");

    const transportClient = new MinoACPAgentClient({
      baseUrl: "https://mino.example",
      agentId,
      keyId: "agent-k1",
      privateKey,
      mandateToken: compactMandateToken(),
      merchantAuthorization: "Bearer merchant-secret",
      nonce: () => "nonce_reference_transport_001",
      fetchImpl: async () => { throw new Error("socket closed"); },
    });
    await expect(
      transportClient.completeCheckout("supplier", "cs_2", {}, "complete-transport-1"),
    ).rejects.toMatchObject({
      name: "MinoAgentTransportError",
      operation: "COMPLETE_CHECKOUT",
      idempotencyKey: "complete-transport-1",
    } satisfies Partial<MinoAgentTransportError>);
  });

  it("server verifier still rejects an exact proof replay even though semantic retries can be re-signed", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const signer = new MinoAgentRequestSigner({
      agentId,
      keyId: "agent-k1",
      privateKey,
      mandateToken: compactMandateToken(),
      now: () => now,
      nonce: () => "nonce_exact_replay_001",
    });
    const signed = signer.sign({
      method: "POST",
      path: "/v1/acp/supplier/checkout_sessions/cs_replay/complete",
      body: {},
      idempotencyKey: "complete-replay-1",
      apiVersion: "2026-04-17",
    });
    let claimed = false;
    const verifier = new AgentRequestVerifier(
      { async resolveAgentPublicKey() { return publicKey; } },
      { async claim() {
        if (claimed) return false;
        claimed = true;
        return true;
      } },
    );
    const verifyInput = {
      method: "POST",
      path: "/v1/acp/supplier/checkout_sessions/cs_replay/complete",
      body: {},
      mandateTokenJtiHash: sha256Hex(jti),
      idempotencyKey: "complete-replay-1",
      apiVersion: "2026-04-17",
      expectedAgentId: agentId,
      proof: signed.proof,
      now,
    };

    await verifier.verify(verifyInput);
    await expect(verifier.verify(verifyInput)).rejects.toBeInstanceOf(AgentRequestError);
    await expect(verifier.verify({ ...verifyInput, proof: signed.proof })).rejects.toMatchObject({
      code: AgentRequestErrorCode.REPLAY_DETECTED,
    });
  });
});
