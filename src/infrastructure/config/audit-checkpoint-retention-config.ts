import { z } from "zod";
import { readRequiredSecret } from "./secret-input.js";

export interface AuditCheckpointRetentionConfig {
  readonly endpoint: string;
  readonly secret: string;
}

const schema = z.object({
  MINO_AUDIT_CHECKPOINT_RETENTION_URL: z.string().url(),
  MINO_AUDIT_CHECKPOINT_RETENTION_SECRET: z.string().min(32).optional(),
  MINO_AUDIT_CHECKPOINT_RETENTION_SECRET_FILE: z.string().min(1).optional(),
});

export function loadAuditCheckpointRetentionConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AuditCheckpointRetentionConfig {
  const parsed = schema.safeParse(environment);
  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) => issue.path.join(".") || "environment")
      .sort()
      .join(", ");
    throw new Error(`Mino audit checkpoint retention configuration is invalid or incomplete: ${fields}`);
  }

  const values = parsed.data;
  const endpoint = assertHttpsUrl(values.MINO_AUDIT_CHECKPOINT_RETENTION_URL);
  const secret = readRequiredSecret(
    {
      ...(values.MINO_AUDIT_CHECKPOINT_RETENTION_SECRET
        ? { inline: values.MINO_AUDIT_CHECKPOINT_RETENTION_SECRET }
        : {}),
      ...(values.MINO_AUDIT_CHECKPOINT_RETENTION_SECRET_FILE
        ? { file: values.MINO_AUDIT_CHECKPOINT_RETENTION_SECRET_FILE }
        : {}),
    },
    "MINO_AUDIT_CHECKPOINT_RETENTION_SECRET",
  );
  if (secret.length < 32) {
    throw new Error("MINO_AUDIT_CHECKPOINT_RETENTION_SECRET must contain at least 32 characters");
  }

  return { endpoint, secret };
}

function assertHttpsUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error("MINO_AUDIT_CHECKPOINT_RETENTION_URL must use HTTPS");
  }
  return value;
}
