import type { PolicyDecision } from "../../domain/evaluation/evaluation.types.js";

export interface GatewayAuditEvent {
  readonly requestId: string;
  readonly decisionId: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly mandateId: string;
  readonly timestamp: Date;
  readonly protocol: "ACP";
  readonly operation: string;
  readonly merchantDomain: string;
  readonly merchantVendorId?: string;
  readonly requestedPayload: unknown;
  readonly approvedPayload?: unknown;
  readonly decision: PolicyDecision;
  readonly requestDigest: string;
  readonly reservationId?: string;
  readonly upstreamStatus?: number;
}

export interface AuditSink {
  record(event: GatewayAuditEvent): Promise<void>;
}

export class NoopAuditSink implements AuditSink {
  public async record(_event: GatewayAuditEvent): Promise<void> {}
}

export function redactSensitivePayload(value: unknown): unknown {
  return redact(value, "");
}

const REDACT_KEYS = new Set([
  "token",
  "credential",
  "authorization",
  "card_number",
  "number",
  "cvc",
  "cvv",
  "security_code",
]);

function redact(value: unknown, key: string): unknown {
  if (REDACT_KEYS.has(key.toLowerCase())) {
    return "[REDACTED]";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "bigint") {
    return value.toString(10);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, key));
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      output[entryKey] = redact(entryValue, entryKey);
    }
    return output;
  }
  return value;
}
