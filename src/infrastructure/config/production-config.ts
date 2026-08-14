import { createPrivateKey, createPublicKey } from "node:crypto";
import { z } from "zod";
import { readRequiredSecret } from "./secret-input.js";

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
  MINO_DELEGATION_PRIVATE_KEY_B64: z.string().min(1).optional(),
  MINO_DELEGATION_PRIVATE_KEY_FILE: z.string().min(1).optional(),
  MINO_AUDIT_SIGNING_KEY_ID: z.string().min(1),
  MINO_AUDIT_PRIVATE_KEY_B64: z.string().min(1).optional(),
  MINO_AUDIT_PRIVATE_KEY_FILE: z.string().min(1).optional(),
  MINO_AUDIT_PUBLIC_KEYS_B64_JSON: z.string().min(2),
  MINO_APPROVAL_RESOLUTION_SECRET: z.string().min(32).optional(),
  MINO_APPROVAL_RESOLUTION_SECRET_FILE: z.string().min(1).optional(),
  MINO_APPROVAL_WEBHOOK_URL: z.string().url(),
  MINO_APPROVAL_WEBHOOK_SECRET: z.string().min(32).optional(),
  MINO_APPROVAL_WEBHOOK_SECRET_FILE: z.string().min(1).optional(),
  MINO_MERCHANT_CREDENTIALS_JSON: z.string().optional(),
  MINO_MERCHANT_CREDENTIALS_FILE: z.string().min(1).optional(),
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

  const delegationPrivateKey = loadPrivatePemSecret(
    values.MINO_DELEGATION_PRIVATE_KEY_B64,
    values.MINO_DELEGATION_PRIVATE_KEY_FILE,
    "MINO_DELEGATION_PRIVATE_KEY",
  );
  assertEd25519PrivateKey(delegationPrivateKey, "MINO_DELEGATION_PRIVATE_KEY");

  const auditPrivateKey = loadPrivatePemSecret(
    values.MINO_AUDIT_PRIVATE_KEY_B64,
    values.MINO_AUDIT_PRIVATE_KEY_FILE,
    "MINO_AUDIT_PRIVATE_KEY",
  );
  const auditVerificationKeys = parseBase64PemMap(
    values.MINO_AUDIT_PUBLIC_KEYS_B64_JSON,
    "MINO_AUDIT_PUBLIC_KEYS_B64_JSON",
  );
  const activeAuditPublicKey = auditVerificationKeys.get(values.MINO_AUDIT_SIGNING_KEY_ID);
  if (!activeAuditPublicKey) {
    throw new Error("MINO_AUDIT_PUBLIC_KEYS_B64_JSON must contain the active audit signing key ID");
  }
  assertEd25519KeyPair(
    auditPrivateKey,
    activeAuditPublicKey,
    "MINO_AUDIT_SIGNING_KEY_ID",
  );

  const approvalResolutionSecret = readRequiredSecret(
    {
      ...(values.MINO_APPROVAL_RESOLUTION_SECRET
        ? { inline: values.MINO_APPROVAL_RESOLUTION_SECRET }
        : {}),
      ...(values.MINO_APPROVAL_RESOLUTION_SECRET_FILE
        ? { file: values.MINO_APPROVAL_RESOLUTION_SECRET_FILE }
        : {}),
    },
    "MINO_APPROVAL_RESOLUTION_SECRET",
  );
  assertSecretLength(approvalResolutionSecret, 32, "MINO_APPROVAL_RESOLUTION_SECRET");

  const approvalWebhookSecret = readRequiredSecret(
    {
      ...(values.MINO_APPROVAL_WEBHOOK_SECRET
        ? { inline: values.MINO_APPROVAL_WEBHOOK_SECRET }
        : {}),
      ...(values.MINO_APPROVAL_WEBHOOK_SECRET_FILE
        ? { file: values.MINO_APPROVAL_WEBHOOK_SECRET_FILE }
        : {}),
    },
    "MINO_APPROVAL_WEBHOOK_SECRET",
  );
  assertSecretLength(approvalWebhookSecret, 32, "MINO_APPROVAL_WEBHOOK_SECRET");

  const merchantCredentialJson = loadOptionalExclusiveSecret(
    values.MINO_MERCHANT_CREDENTIALS_JSON,
    values.MINO_MERCHANT_CREDENTIALS_FILE,
    "MINO_MERCHANT_CREDENTIALS",
  );

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
      privateKey: delegationPrivateKey,
    },
    auditSigningKey: {
      keyId: values.MINO_AUDIT_SIGNING_KEY_ID,
      privateKey: auditPrivateKey,
    },
    auditVerificationKeys,
    approvalResolutionSecret,
    approvalWebhook: {
      endpoint: assertHttpsUrl(values.MINO_APPROVAL_WEBHOOK_URL, "MINO_APPROVAL_WEBHOOK_URL"),
      secret: approvalWebhookSecret,
    },
    merchantCredentials: parseMerchantCredentials(merchantCredentialJson),
  };
}

export function merchantCredentialKey(organizationId: string, merchantId: string): string {
  return `${organizationId}:${merchantId}`;
}

function loadPrivatePemSecret(
  inlineBase64: string | undefined,
  file: string | undefined,
  field: string,
): string {
  if (inlineBase64 && file) {
    throw new Error(`${field} must be supplied by exactly one secret source`);
  }
  if (file) {
    const pem = readRequiredSecret({ file }, field);
    assertPem(pem, field);
    return pem;
  }
  const encoded = readRequiredSecret(
    inlineBase64 ? { inline: inlineBase64 } : {},
    field,
  );
  return decodePem(encoded, field);
}

function loadOptionalExclusiveSecret(
  inline: string | undefined,
  file: string | undefined,
  field: string,
): string | undefined {
  if (inline && file) {
    throw new Error(`${field} must be supplied by at most one secret source`);
  }
  if (file) {
    return readRequiredSecret({ file }, field);
  }
  return inline;
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
    const pem = decodePem(encoded, field);
    assertEd25519PublicKey(pem, field);
    result.set(keyId, pem);
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
    throw new Error("MINO_MERCHANT_CREDENTIALS must be a JSON object");
  }
  if (!isRecord(parsed)) {
    throw new Error("MINO_MERCHANT_CREDENTIALS must be a JSON object");
  }

  const result = new Map<string, string>();
  for (const [key, authorization] of Object.entries(parsed)) {
    if (!key.trim() || typeof authorization !== "string" || !/^Bearer\s+\S+$/i.test(authorization)) {
      throw new Error("MINO_MERCHANT_CREDENTIALS contains an invalid bearer credential");
    }
    result.set(key, authorization);
  }
  return result;
}

function decodePem(value: string, field: string): string {
  const decoded = Buffer.from(value, "base64").toString("utf8");
  assertPem(decoded, field);
  return decoded;
}

function assertPem(value: string, field: string): void {
  if (!value.includes("-----BEGIN ") || !value.includes(" KEY-----")) {
    throw new Error(`${field} must contain a PEM key`);
  }
}

function assertEd25519PrivateKey(value: string, field: string): void {
  try {
    const key = createPrivateKey(value);
    if (key.asymmetricKeyType !== "ed25519") {
      throw new Error("wrong key type");
    }
  } catch {
    throw new Error(`${field} must contain a valid Ed25519 private key`);
  }
}

function assertEd25519PublicKey(value: string, field: string): void {
  try {
    const key = createPublicKey(value);
    if (key.asymmetricKeyType !== "ed25519") {
      throw new Error("wrong key type");
    }
  } catch {
    throw new Error(`${field} must contain valid Ed25519 public keys`);
  }
}

function assertEd25519KeyPair(privatePem: string, publicPem: string, field: string): void {
  assertEd25519PrivateKey(privatePem, field);
  assertEd25519PublicKey(publicPem, field);
  const derived = createPublicKey(createPrivateKey(privatePem)).export({ type: "spki", format: "der" });
  const configured = createPublicKey(publicPem).export({ type: "spki", format: "der" });
  if (!Buffer.from(derived).equals(Buffer.from(configured))) {
    throw new Error(`${field} private key does not match its configured public verification key`);
  }
}

function assertSecretLength(value: string, minimum: number, field: string): void {
  if (value.length < minimum) {
    throw new Error(`${field} must contain at least ${minimum} characters`);
  }
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
