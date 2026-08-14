import { readFileSync, realpathSync, statSync } from "node:fs";

export interface SecretInput {
  readonly inline?: string;
  readonly file?: string;
}

export function readRequiredSecret(input: SecretInput, label: string): string {
  const hasInline = typeof input.inline === "string" && input.inline.length > 0;
  const hasFile = typeof input.file === "string" && input.file.trim().length > 0;

  if (hasInline === hasFile) {
    throw new Error(`${label} must be supplied by exactly one secret source`);
  }

  if (hasInline) {
    return input.inline as string;
  }

  const requestedPath = (input.file as string).trim();
  let resolvedPath: string;
  try {
    resolvedPath = realpathSync(requestedPath);
    const stat = statSync(resolvedPath);
    if (!stat.isFile()) {
      throw new Error("not a regular file");
    }
  } catch {
    throw new Error(`${label} secret file cannot be read as a regular file`);
  }

  let value: string;
  try {
    value = readFileSync(resolvedPath, "utf8").replace(/[\r\n]+$/u, "");
  } catch {
    throw new Error(`${label} secret file cannot be read`);
  }
  if (!value) {
    throw new Error(`${label} secret file is empty`);
  }
  return value;
}
