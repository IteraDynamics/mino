import { describe, expect, it } from "vitest";
import { redactSensitivePayload } from "../../src/modules/audit/audit-sink.js";

describe("audit payload redaction", () => {
  it("preserves dates and bigint values as JSON-safe exact strings while redacting sensitive fields", () => {
    const timestamp = new Date("2026-08-15T06:45:00.123Z");
    expect(
      redactSensitivePayload({
        timestamp,
        maxBudgetMinor: 9007199254740993123n,
        authorization: "Bearer secret",
        nested: { token: "raw-token", count: 2n },
      }),
    ).toEqual({
      timestamp: "2026-08-15T06:45:00.123Z",
      maxBudgetMinor: "9007199254740993123",
      authorization: "[REDACTED]",
      nested: { token: "[REDACTED]", count: "2" },
    });
  });
});
