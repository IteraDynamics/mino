import { describe, expect, it } from "vitest";
import { buildPersonalPairingSigningPayload } from "../../src/modules/personal/personal-pairing.service.js";
import { buildPersonalMandateSigningPayload } from "../../src/modules/personal/personal-authority.service.js";
import {
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
});
