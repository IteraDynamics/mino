import { describe, expect, it } from "vitest";
import {
  WebhookAdminAuditCheckpointRetainer,
  adminRetentionEvent,
  type AdminAuditChainCheckpoint,
} from "../../src/modules/admin/admin-audit-checkpoint-retention.js";

const checkpoint: AdminAuditChainCheckpoint = {
  version: 1,
  organizationId: "11111111-1111-4111-8111-111111111111",
  chainSequence: "42",
  chainDigest: "digest-42",
  issuedAt: "2026-08-15T06:55:00.000Z",
  signingKeyId: "audit-k1",
  signature: "signature-42",
};

describe("administrative audit checkpoint retention", () => {
  it("derives a deterministic event ID from the full signed checkpoint", () => {
    const first = adminRetentionEvent(checkpoint);
    const second = adminRetentionEvent({ ...checkpoint });

    expect(first).toEqual(second);
    expect(first.type).toBe("mino.admin.audit.checkpoint.retention.v1");
    expect(first.eventId).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("changes the stable event ID whenever retained proof changes", () => {
    const original = adminRetentionEvent(checkpoint).eventId;
    expect(adminRetentionEvent({ ...checkpoint, chainSequence: "43" }).eventId).not.toBe(original);
    expect(adminRetentionEvent({ ...checkpoint, chainDigest: "different" }).eventId).not.toBe(original);
    expect(adminRetentionEvent({ ...checkpoint, signature: "different-signature" }).eventId).not.toBe(
      original,
    );
  });

  it("requires HTTPS, a sufficiently strong HMAC secret, and a positive timeout", () => {
    expect(
      () =>
        new WebhookAdminAuditCheckpointRetainer({
          endpoint: "http://retention.example/checkpoints",
          secret: "s".repeat(32),
        }),
    ).toThrow(/HTTPS/i);

    expect(
      () =>
        new WebhookAdminAuditCheckpointRetainer({
          endpoint: "https://retention.example/checkpoints",
          secret: "too-short",
        }),
    ).toThrow(/32 characters/i);

    expect(
      () =>
        new WebhookAdminAuditCheckpointRetainer({
          endpoint: "https://retention.example/checkpoints",
          secret: "s".repeat(32),
          timeoutMs: 0,
        }),
    ).toThrow(/positive integer/i);
  });
});
