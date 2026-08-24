import { describe, expect, it } from "vitest";
import { buildAgentSigningPayload } from "../../src/modules/agents/agent-request-verifier.js";
import { buildPersonalMandateSigningPayload } from "../../src/modules/personal/personal-authority.service.js";
import { buildPersonalPairingSigningPayload } from "../../src/modules/personal/personal-pairing.service.js";
import {
  buildAgentRequestPayload,
  buildMandatePayload,
  buildPairingPayload,
} from "../../skills/mino/scripts/mino-personal.mjs";

describe("OpenClaw Mino Personal helper protocol", () => {
  it("matches the server pairing proof payload exactly", () => {
    const input = {
      externalAgentId: "openclaw-personal",
      displayName: "OpenClaw",
      keyId: "openclaw-k1",
      publicKeyFingerprint: "fingerprint",
      timestamp: 1_787_590_000,
      nonce: "abcdefghijklmnop12345678",
    };
    expect(buildPairingPayload(input)).toBe(buildPersonalPairingSigningPayload(input));
  });

  it("matches the server mandate credential proof payload exactly", () => {
    const input = {
      agentId: "10000000-0000-4000-8000-000000000001",
      keyId: "openclaw-k1",
      timestamp: 1_787_590_000,
      nonce: "abcdefghijklmnop12345678",
    };
    expect(buildMandatePayload(input)).toBe(
      buildPersonalMandateSigningPayload(input.agentId, input.keyId, input.timestamp, input.nonce),
    );
  });

  it("matches the server economic request proof payload exactly", () => {
    const input = {
      method: "POST",
      path: "/v1/personal/acp/personal-sandbox/checkout_sessions/cs_1/complete?ignored=true",
      timestamp: "1787590000",
      nonce: "transaction-nonce-123456789",
      body: {
        payment_data: { token: "opaque" },
        nested: { z: 2, a: 1 },
      },
      mandateTokenJtiHash: "abc123",
      idempotencyKey: "idem-personal-execution",
      apiVersion: "2026-04-17",
    };
    expect(buildAgentRequestPayload(input)).toBe(buildAgentSigningPayload(input));
  });
});
