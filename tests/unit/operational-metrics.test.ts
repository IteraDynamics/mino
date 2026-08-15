import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerMetricsRoute } from "../../src/api/metrics.routes.js";
import { loadOperationalMetricsConfig } from "../../src/infrastructure/config/operational-metrics-config.js";
import { renderPrometheusMetrics } from "../../src/operations/prometheus-metrics.js";
import type {
  OperationalMetricsSnapshot,
  PostgresOperationalMetrics,
} from "../../src/operations/postgres-operational-metrics.js";

const token = "metrics-token-abcdefghijklmnopqrstuvwxyz-123456";
const now = new Date("2026-08-15T04:00:00.000Z");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function snapshot(): OperationalMetricsSnapshot {
  return {
    capturedAt: now,
    auditDecisions: {
      ALLOW: 12n,
      BLOCK: 3n,
      PENDING_HUMAN_APPROVAL: 2n,
    },
    approvals: {
      PENDING: 2n,
      APPROVED: 4n,
      REJECTED: 1n,
      EXPIRED: 1n,
    },
    payments: {
      FORWARDING: 1n,
      UNKNOWN: 2n,
      SUCCEEDED: 20n,
      FAILED_DEFINITIVE: 3n,
    },
    spendReservations: {
      RESERVED: 3n,
      COMMITTED: 20n,
      RELEASED: 5n,
      EXPIRED: 1n,
    },
    auditOrganizations: 4n,
    unresolvedPayments: 3n,
    oldestUnresolvedPaymentAgeSeconds: 481,
  };
}

describe("operational metrics exposition", () => {
  it("renders deterministic low-cardinality Prometheus gauges without transaction identifiers", () => {
    const rendered = renderPrometheusMetrics(snapshot());

    expect(rendered).toContain('mino_audit_decisions{verdict="ALLOW"} 12');
    expect(rendered).toContain('mino_payment_outcomes{status="UNKNOWN"} 2');
    expect(rendered).toContain("mino_unresolved_payments 3");
    expect(rendered).toContain("mino_oldest_unresolved_payment_age_seconds 481");
    expect(rendered).toContain("# TYPE mino_audit_decisions gauge");
    expect(rendered.endsWith("\n")).toBe(true);

    for (const forbidden of [
      "organization_id",
      "agent_id",
      "merchant_id",
      "request_id",
      "payment_outcome_id",
      "reservation_id",
      "idempotency",
      "amount_minor",
    ]) {
      expect(rendered.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("loads a dedicated metrics token from inline config or a mounted secret file", () => {
    expect(
      loadOperationalMetricsConfig({ MINO_METRICS_BEARER_TOKEN: token }),
    ).toEqual({ bearerToken: token });

    const dir = mkdtempSync(join(tmpdir(), "mino-metrics-"));
    tempDirs.push(dir);
    const secretPath = join(dir, "metrics-token");
    writeFileSync(secretPath, `${token}\n`, { mode: 0o600 });

    expect(
      loadOperationalMetricsConfig({ MINO_METRICS_BEARER_TOKEN_FILE: secretPath }),
    ).toEqual({ bearerToken: token });
  });

  it("rejects ambiguous, weak, and whitespace-containing metrics credentials", () => {
    expect(() =>
      loadOperationalMetricsConfig({
        MINO_METRICS_BEARER_TOKEN: token,
        MINO_METRICS_BEARER_TOKEN_FILE: "/tmp/other",
      }),
    ).toThrow(/exactly one/i);
    expect(() =>
      loadOperationalMetricsConfig({ MINO_METRICS_BEARER_TOKEN: "too-short" }),
    ).toThrow(/at least 32/i);
    expect(() =>
      loadOperationalMetricsConfig({ MINO_METRICS_BEARER_TOKEN: `${token} bad` }),
    ).toThrow(/whitespace/i);
  });
});

describe("GET /metrics", () => {
  it("requires the dedicated Bearer credential and serves Prometheus text only after authentication", async () => {
    const metrics = {
      snapshot: vi.fn(async () => snapshot()),
    } as unknown as PostgresOperationalMetrics;
    const app = Fastify();
    await registerMetricsRoute(app, { metrics, bearerToken: token, now: () => now });

    const missing = await app.inject({ method: "GET", url: "/metrics" });
    expect(missing.statusCode).toBe(401);
    expect(metrics.snapshot).not.toHaveBeenCalled();

    const wrong = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(wrong.statusCode).toBe(401);
    expect(metrics.snapshot).not.toHaveBeenCalled();

    const ok = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toContain("text/plain");
    expect(ok.body).toContain("mino_payment_outcomes");
    expect(metrics.snapshot).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("isolates metrics query failures to the metrics endpoint", async () => {
    const metrics = {
      snapshot: vi.fn(async () => {
        throw new Error("database metrics read failed");
      }),
    } as unknown as PostgresOperationalMetrics;
    const app = Fastify();
    await registerMetricsRoute(app, { metrics, bearerToken: token, now: () => now });

    const response = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "METRICS_UNAVAILABLE" });
    await app.close();
  });
});
