import { lstatSync, readFileSync, realpathSync } from "node:fs";

export interface OperationalMetricsConfig {
  readonly bearerToken: string;
}

/**
 * Metrics exposure is opt-in. Exactly one token source may be configured.
 * Mounted-file support matches Mino's existing external secret-manager pattern.
 */
export function loadOperationalMetricsConfig(
  environment: NodeJS.ProcessEnv = process.env,
): OperationalMetricsConfig | undefined {
  const inline = environment.MINO_METRICS_BEARER_TOKEN?.trim();
  const file = environment.MINO_METRICS_BEARER_TOKEN_FILE?.trim();

  if (inline && file) {
    throw new Error(
      "Configure exactly one of MINO_METRICS_BEARER_TOKEN or MINO_METRICS_BEARER_TOKEN_FILE",
    );
  }
  if (!inline && !file) {
    return undefined;
  }

  const bearerToken = inline ?? readSecretFile(file!);
  if (bearerToken.length < 32) {
    throw new Error("MINO_METRICS_BEARER_TOKEN must contain at least 32 characters");
  }
  if (/\s/.test(bearerToken)) {
    throw new Error("MINO_METRICS_BEARER_TOKEN must not contain whitespace");
  }
  return { bearerToken };
}

function readSecretFile(path: string): string {
  let resolved: string;
  try {
    resolved = realpathSync(path);
    if (!lstatSync(resolved).isFile()) {
      throw new Error("not a regular file");
    }
  } catch {
    throw new Error("MINO_METRICS_BEARER_TOKEN_FILE must resolve to a readable regular file");
  }

  let value: string;
  try {
    value = readFileSync(resolved, "utf8").trim();
  } catch {
    throw new Error("MINO_METRICS_BEARER_TOKEN_FILE could not be read");
  }
  if (!value) {
    throw new Error("MINO_METRICS_BEARER_TOKEN_FILE must not be empty");
  }
  return value;
}
