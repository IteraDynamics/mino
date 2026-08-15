import { createPublicKey } from "node:crypto";
import type { AdminJwtIssuerConfig } from "../../modules/admin/admin-jwt-authenticator.js";

export function loadAdminJwtIssuerConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): readonly AdminJwtIssuerConfig[] {
  return parseAdminJwtIssuerConfiguration(environment.MINO_ADMIN_JWT_ISSUERS_JSON);
}

export function parseAdminJwtIssuerConfiguration(
  value: string | undefined,
): readonly AdminJwtIssuerConfig[] {
  if (!value?.trim()) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("MINO_ADMIN_JWT_ISSUERS_JSON must be a JSON object");
  }
  if (!isRecord(parsed) || Object.keys(parsed).length === 0) {
    throw new Error("MINO_ADMIN_JWT_ISSUERS_JSON must contain at least one trusted issuer");
  }

  const issuers: AdminJwtIssuerConfig[] = [];
  for (const [issuer, rawConfig] of Object.entries(parsed)) {
    assertOidcIssuer(issuer);
    if (!isRecord(rawConfig)) {
      throw new Error("MINO_ADMIN_JWT_ISSUERS_JSON issuer entries must be objects");
    }
    const audience = rawConfig.audience;
    const rawKeys = rawConfig.keys;
    if (typeof audience !== "string" || !audience.trim()) {
      throw new Error("MINO_ADMIN_JWT_ISSUERS_JSON issuer audience must be non-empty");
    }
    if (!isRecord(rawKeys) || Object.keys(rawKeys).length === 0) {
      throw new Error("MINO_ADMIN_JWT_ISSUERS_JSON issuer keys must be a non-empty object");
    }

    const verificationKeys = new Map<string, string>();
    for (const [keyId, encoded] of Object.entries(rawKeys)) {
      if (!keyId.trim() || typeof encoded !== "string" || !encoded.trim()) {
        throw new Error("MINO_ADMIN_JWT_ISSUERS_JSON contains an invalid verification key entry");
      }
      const pem = Buffer.from(encoded, "base64").toString("utf8");
      assertSupportedAdminJwtPublicKey(pem);
      verificationKeys.set(keyId, pem);
    }

    issuers.push({ issuer, audience, verificationKeys });
  }

  return issuers.sort((left, right) => left.issuer.localeCompare(right.issuer));
}

function assertOidcIssuer(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("MINO_ADMIN_JWT_ISSUERS_JSON issuer must be a valid HTTPS URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "MINO_ADMIN_JWT_ISSUERS_JSON issuer must be an HTTPS URL without credentials, query, or fragment",
    );
  }
}

function assertSupportedAdminJwtPublicKey(pem: string): void {
  let key: ReturnType<typeof createPublicKey>;
  try {
    key = createPublicKey(pem);
  } catch {
    throw new Error("MINO_ADMIN_JWT_ISSUERS_JSON keys must decode to valid public PEM keys");
  }

  switch (key.asymmetricKeyType) {
    case "rsa":
    case "ed25519":
      return;
    case "ec": {
      const details = key.asymmetricKeyDetails as { namedCurve?: string } | undefined;
      if (details?.namedCurve === "prime256v1" || details?.namedCurve === "P-256") {
        return;
      }
      break;
    }
  }
  throw new Error(
    "MINO_ADMIN_JWT_ISSUERS_JSON keys must use RSA, P-256 EC, or Ed25519 public keys",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
