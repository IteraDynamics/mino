import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function sha256Base64Url(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Non-finite numbers cannot be canonicalized");
    }
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString(10);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalize(entry));
  }

  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};

    for (const key of Object.keys(source).sort()) {
      const entry = source[key];
      if (entry !== undefined) {
        output[key] = normalize(entry);
      }
    }

    return output;
  }

  throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`);
}
