import { z } from "zod";

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 3000;

export interface ProductionConfig {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly host: string;
  readonly port: number;
  readonly issuer: string;
  readonly mandateVerificationKeys: ReadonlyMap<string, string>;
  readonly delegationSigningKey: {
    readonly keyId: string;
    readonly privateKey: string;
  };
  readonly auditSigningKey: {
    readonly keyId: string;
    readonly privateKey: string;
  };
  readonly auditVerificationKeys: ReadonlyMap<string, string>;
  readonly approvalResolutionSecret: string;
  readonly approvalWebhook: {
    readonly endpoint: string;
    readonly secret: string;
  };
  readonly merchantCredentials: ReadonlyMap<string, string>;
}

const environmentSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  MINO_HOST: z.string().min(1).optional(),
  MINO_PORT: z.string().regex(/^\d+$/).optional(),
  MINO_ISSUER: z.string().url(),
  MINO_MANDATE_PUBLIC_KEYS_B64_JSON: z.string().min(2),
  MINO_DELEGATION_SIGNING_KEY_ID: z.string().min(1),
  MINO_DELEGATION_PRIVATE_KEY_B64: z.string().min(1),
  MINO_AUDIT_SIGNING_KEY_ID: z.string().min(1),
  MINO_AUDIT_PRIVATE_KEY_B64: z.string().min(1),
  MINO_AUDIT_PUBLIC_KEYS_B64_JSON: z.string().min(2),
  MINO_APPROVAL_RESOLUTION_SECRET: z.string().min(32),
  MINO_APPROVAL_WEBHOOK_URL: z.string().url(),
  MINO_APPROVAL_WEBHOOK_SECRET: z.string().min(32),
  MINO_MERCHANT_CREDENTIALS_JSON: z.string().optional(),
});

export function loadProductionConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ProductionConfig {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) => issue.path.join(".") || "environment")
      .sort()
      .join(", ");
    throw new Error(`Mino production configuration is invalid or incomplete: ${fields}`);
  }

  const values = parsed.data;
  const port = values.MINO_PORT ? Number(values.MINO_PORT) : DEFAULT_PORT;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("MINO_PORT must be an integer between 1 and 65535");
  }

  return {
    databaseUrl: assertPostgresUrl(values.DATABASE_URL),
    redisUrl: assertRedisUrl(values.REDIS_URL),
    host: values.MINO_HOST ?? DEFAULT_HOST,
    port,
    issuer: values.MINO_ISSUER,
    mandateVerificationKeys: parseBase64PemMap(
      values.MINO_MANDATE_PUBLIC_KEYS_B64_JSON,
      "MINO_MANDATE_PUBLIC_KEYS_B64_JSON",
    ),
    delegationSigningKey: {
      keyId: values.MINO_DELEGATION_SIGNING_KEY_ID,
      privateKey: decodePem(
        values.MINO_DELEGATION_PRIVATE_KEY_B64,
        "MINO_DELEGATION_PRIVATE_KEY_B64",
      ),
    },
    auditSigningKey: {
      keyId: values.MINO_AUDIT_SIGNING_KEY_ID,
      privateKey: decodePem(values.MINO_AUDIT_PRIVATE_KEY_B64, "MINO_AUDIT_PRIVATE_KEY_B64"),
    },
    auditVerificationKeys: parseBase64PemMap(
      values.MINO_AUDIT_PUBLIC_KEYS_B64_JSON,
      "MINO_AUDIT_PUBLIC_KEYS_B64_JSON",
    ),
    approvalResolutionSecret: values.MINO_APPROVAL_RESOLUTION_SECRET,
    approvalWebhook: {
      endpoint: assertHttpsUrl(values.MINO_APPROVAL_WEBHOOK_URL, "MINO_APPROVAL_WEBHOOK_URL"),
      secret: values.MINO_APPROVAL_WEBHOOK_SECRET,
    },
    merchantCredentials: parseMerchantCredentials(values.MINO_MERCHANT_CREDENTIALS_JSON),
  };
}

export function merchantCredentialKey(organizationId: string, merchantId: string): string {
  return `${organizationId}:${merchantId}`;
}

function parseBase64PemMap(value: string, field: string): ReadonlyMap<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${field} must be a JSON object of key IDs to base64-encoded PEM values`);
  }
  if (!isRecord(parsed) || Object.keys(parsed).length === 0) {
    throw new Error(`${field} must contain at least one verification key`);
  }

  const result = new Map<string, string>();
  for (const [keyId, encoded] of Object.entries(parsed)) {
    if (!keyId.trim() || typeof encoded !== "string" || !encoded.trim()) {
      throw new Error(`${field} contains an invalid key entry`);
    }
    result.set(keyId, decodePem(encoded, field));
  }
  return result;
}

function parseMerchantCredentials(value: string | undefined): ReadonlyMap<string, string> {
  if (!value) {
    return new Map();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("MINO_MERCHANT_CREDENTIALS_JSON must be a JSON object");
  }
  if (!isRecord(parsed)) {
    throw new Error("MINO_MERCHANT_CREDENTIALS_JSON must be a JSON object");
  }

  const result = new Map<string, string>();
  for (const [key, authorization] of Object.entries(parsed)) {
    if (!key.trim() || typeof authorization !== "string" || !/^Bearer\s+\S+$/i.test(authorization)) {
      throw new Error("MINO_MERCHANT_CREDENTIALS_JSON contains an invalid bearer credential");
    }
    result.set(key, authorization);
  }
  return result;
}

function decodePem(value: string, field: string): string {
  let decoded: string;
  try {
    decoded = Buffer.from(value, "base64").toString("utf8");
  } catch {
    throw new Error(`${field} is not valid base64`);
  }
  if (!decoded.includes("-----BEGIN ") || !decoded.includes(" KEY-----")) {
    throw new Error(`${field} must decode to a PEM key`);
  }
  return decoded;
}

function assertPostgresUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error("DATABASE_URL must use postgresql:// or postgres://");
  }
  return value;
}

function assertRedisUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error("REDIS_URL must use redis:// or rediss://");
  }
  return value;
}

function assertHttpsUrl(value: string, field: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error(`${field} must use HTTPS`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
