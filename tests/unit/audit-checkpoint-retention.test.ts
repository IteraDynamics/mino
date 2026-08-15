import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson } from "../../src/infrastructure/crypto/canonical-json.js";
import { loadAuditCheckpointRetentionConfig } from "../../src/infrastructure/config/audit-checkpoint-retention-config.js";
import {
  WebhookAuditCheckpointRetainer,
  retentionEvent,
} from "../../src/modules/audit/audit-checkpoint-retention.js";

const checkpoint = {
  version: 1 as const,
  organizationId: "70000000-0000-4000-8000-000000000001",
  chainSequence: "12",
  chainDigest: "chain-digest-12",
  issuedAt: "2026-08-14T20:45:00.000Z",
  signingKeyId: "audit-k1",
  signature: "signed-checkpoint",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("audit checkpoint retention configuration", () => {
  it("loads an HTTPS endpoint with an inline secret", () => {
    const config = loadAuditCheckpointRetentionConfig({
      MINO_AUDIT_CHECKPOINT_RETENTION_URL: "https://audit-retention.example/checkpoints",
      MINO_AUDIT_CHECKPOINT_RETENTION_SECRET: "s".repeat(32),
    });
    expect(config).toEqual({
      endpoint: "https://audit-retention.example/checkpoints",
      secret: "s".repeat(32),
    });
  });

  it("loads the transport secret from a mounted file", () => {
    const directory = mkdtempSync(join(tmpdir(), "mino-audit-retention-"));
    try {
      const secretPath = join(directory, "retention-hmac");
      writeFileSync(secretPath, `${"f".repeat(40)}\n`);
      const config = loadAuditCheckpointRetentionConfig({
        MINO_AUDIT_CHECKPOINT_RETENTION_URL: "https://audit-retention.example/checkpoints",
        MINO_AUDIT_CHECKPOINT_RETENTION_SECRET_FILE: secretPath,
      });
      expect(config.secret).toBe("f".repeat(40));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed for insecure, missing, or ambiguous secret configuration", () => {
    expect(() =>
      loadAuditCheckpointRetentionConfig({
        MINO_AUDIT_CHECKPOINT_RETENTION_URL: "http://audit-retention.example/checkpoints",
        MINO_AUDIT_CHECKPOINT_RETENTION_SECRET: "s".repeat(32),
      }),
    ).toThrow(/HTTPS/);

    expect(() =>
      loadAuditCheckpointRetentionConfig({
        MINO_AUDIT_CHECKPOINT_RETENTION_URL: "https://audit-retention.example/checkpoints",
      }),
    ).toThrow(/exactly one secret source/i);

    expect(() =>
      loadAuditCheckpointRetentionConfig({
        MINO_AUDIT_CHECKPOINT_RETENTION_URL: "https://audit-retention.example/checkpoints",
        MINO_AUDIT_CHECKPOINT_RETENTION_SECRET: "s".repeat(32),
        MINO_AUDIT_CHECKPOINT_RETENTION_SECRET_FILE: "/tmp/duplicate-secret",
      }),
    ).toThrow(/exactly one secret source/i);
  });
});

describe("WebhookAuditCheckpointRetainer", () => {
  it("sends a canonical event with a stable event ID and authenticated transport headers", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const secret = "h".repeat(32);
    const event = retentionEvent(checkpoint);
    const retainer = new WebhookAuditCheckpointRetainer({
      endpoint: "https://audit-retention.example/checkpoints",
      secret,
    });

    await retainer.retain(event);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://audit-retention.example/checkpoints");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.body).toBe(canonicalJson(event));

    const headers = init.headers as Record<string, string>;
    expect(headers["X-Mino-Event-Id"]).toBe(event.eventId);
    expect(headers["X-Mino-Audit-Organization-Id"]).toBe(checkpoint.organizationId);
    expect(headers["X-Mino-Audit-Sequence"]).toBe(checkpoint.chainSequence);

    const signatureHeader = headers["X-Mino-Signature"] as string;
    const match = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(signatureHeader);
    expect(match).not.toBeNull();
    const expected = createHmac("sha256", secret)
      .update(`${match?.[1]}.${canonicalJson(event)}`)
      .digest("hex");
    expect(match?.[2]).toBe(expected);
  });

  it("rejects insecure configuration and treats non-2xx responses as delivery failure", async () => {
    expect(
      () =>
        new WebhookAuditCheckpointRetainer({
          endpoint: "http://audit-retention.example/checkpoints",
          secret: "s".repeat(32),
        }),
    ).toThrow(/HTTPS/);

    const fetchMock = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const retainer = new WebhookAuditCheckpointRetainer({
      endpoint: "https://audit-retention.example/checkpoints",
      secret: "s".repeat(32),
    });
    await expect(retainer.retain(retentionEvent(checkpoint))).rejects.toThrow(/HTTP 503/);
  });

  it("derives the same retention event for the same signed checkpoint", () => {
    expect(retentionEvent(checkpoint)).toEqual(retentionEvent({ ...checkpoint }));
  });
});
