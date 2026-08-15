import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  PROMETHEUS_CONTENT_TYPE,
  renderPrometheusMetrics,
} from "../operations/prometheus-metrics.js";
import type { PostgresOperationalMetrics } from "../operations/postgres-operational-metrics.js";

export interface MetricsRouteDependencies {
  readonly metrics: PostgresOperationalMetrics;
  readonly bearerToken: string;
  readonly now?: () => Date;
}

export async function registerMetricsRoute(
  app: FastifyInstance,
  deps: MetricsRouteDependencies,
): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const expectedDigest = tokenDigest(deps.bearerToken);

  app.get("/metrics", async (request, reply) => {
    const supplied = bearerToken(request);
    if (!supplied || !timingSafeEqual(tokenDigest(supplied), expectedDigest)) {
      return reply.code(401).send({ error: "UNAUTHORIZED" });
    }

    try {
      const snapshot = await deps.metrics.snapshot(now());
      return reply.type(PROMETHEUS_CONTENT_TYPE).send(renderPrometheusMetrics(snapshot));
    } catch {
      return reply.code(503).send({ error: "METRICS_UNAVAILABLE" });
    }
  });
}

function bearerToken(request: FastifyRequest): string | undefined {
  const value = request.headers.authorization;
  if (typeof value !== "string") {
    return undefined;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(value.trim());
  return match?.[1];
}

function tokenDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}
