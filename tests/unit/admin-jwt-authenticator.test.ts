import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AdminJwtAuthenticator,
  type AdminJwtIssuerConfig,
} from "../../src/modules/admin/admin-jwt-authenticator.js";

const issuer = "https://login.example.test/";
const audience = "mino-admin";
const now = new Date("2026-08-15T05:45:00.000Z");

function rsaKeys(): { publicPem: string; privateKey: KeyObject } {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    publicPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: pair.privateKey,
  };
}

function ed25519Keys(): { publicPem: string; privateKey: KeyObject } {
  const pair = generateKeyPairSync("ed25519");
  return {
    publicPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: pair.privateKey,
  };
}

function issuerConfig(keyId: string, publicPem: string): AdminJwtIssuerConfig {
  return {
    issuer,
    audience,
    verificationKeys: new Map([[keyId, publicPem]]),
  };
}

function jwt(input: {
  privateKey: KeyObject;
  keyId?: string;
  algorithm?: "RS256" | "EdDSA" | "ES256";
  payload?: Record<string, unknown>;
}): string {
  const algorithm = input.algorithm ?? "RS256";
  const header = encode({ alg: algorithm, kid: input.keyId ?? "admin-k1", typ: "JWT" });
  const payload = encode({
    iss: issuer,
    sub: "user-123",
    aud: audience,
    iat: Math.floor(now.getTime() / 1_000) - 60,
    exp: Math.floor(now.getTime() / 1_000) + 300,
    ...input.payload,
  });
  const signingInput = Buffer.from(`${header}.${payload}`, "ascii");
  const signature =
    algorithm === "EdDSA"
      ? sign(null, signingInput, input.privateKey)
      : sign("RSA-SHA256", signingInput, input.privateKey);
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

describe("AdminJwtAuthenticator", () => {
  it("authenticates a trusted RS256 token and returns only stable issuer/subject identity", () => {
    const keys = rsaKeys();
    const authenticator = new AdminJwtAuthenticator(
      [issuerConfig("admin-k1", keys.publicPem)],
      () => now,
    );

    expect(
      authenticator.authenticateAuthorizationHeader(`Bearer ${jwt({ privateKey: keys.privateKey })}`),
    ).toEqual({ authenticated: true, issuer, subject: "user-123" });
  });

  it("supports Ed25519/EdDSA issuer keys", () => {
    const keys = ed25519Keys();
    const authenticator = new AdminJwtAuthenticator(
      [issuerConfig("admin-ed", keys.publicPem)],
      () => now,
    );

    expect(
      authenticator.authenticateAuthorizationHeader(
        `Bearer ${jwt({ privateKey: keys.privateKey, keyId: "admin-ed", algorithm: "EdDSA" })}`,
      ),
    ).toEqual({ authenticated: true, issuer, subject: "user-123" });
  });

  it("requires one syntactically valid Bearer authorization value", () => {
    const keys = rsaKeys();
    const authenticator = new AdminJwtAuthenticator([issuerConfig("admin-k1", keys.publicPem)]);

    expect(authenticator.authenticateAuthorizationHeader(undefined)).toEqual({
      authenticated: false,
      reason: "AUTHORIZATION_HEADER_INVALID",
    });
    expect(authenticator.authenticateAuthorizationHeader("Basic abc")).toEqual({
      authenticated: false,
      reason: "AUTHORIZATION_HEADER_INVALID",
    });
    expect(authenticator.authenticateAuthorizationHeader("Bearer token, Bearer second")).toEqual({
      authenticated: false,
      reason: "AUTHORIZATION_HEADER_INVALID",
    });
  });

  it("rejects untrusted issuers, unknown keys, and algorithm confusion", () => {
    const keys = rsaKeys();
    const authenticator = new AdminJwtAuthenticator(
      [issuerConfig("admin-k1", keys.publicPem)],
      () => now,
    );

    expect(
      authenticator.authenticateAuthorizationHeader(
        `Bearer ${jwt({ privateKey: keys.privateKey, payload: { iss: "https://evil.example/" } })}`,
      ),
    ).toEqual({ authenticated: false, reason: "ISSUER_NOT_TRUSTED" });

    expect(
      authenticator.authenticateAuthorizationHeader(
        `Bearer ${jwt({ privateKey: keys.privateKey, keyId: "unknown" })}`,
      ),
    ).toEqual({ authenticated: false, reason: "KEY_NOT_TRUSTED" });

    expect(
      authenticator.authenticateAuthorizationHeader(
        `Bearer ${jwt({ privateKey: keys.privateKey, algorithm: "ES256" })}`,
      ),
    ).toEqual({ authenticated: false, reason: "ALGORITHM_NOT_ALLOWED" });
  });

  it("rejects a token whose signature no longer covers the payload", () => {
    const keys = rsaKeys();
    const authenticator = new AdminJwtAuthenticator(
      [issuerConfig("admin-k1", keys.publicPem)],
      () => now,
    );
    const token = jwt({ privateKey: keys.privateKey });
    const [header, _payload, signature] = token.split(".");
    const tamperedPayload = encode({
      iss: issuer,
      sub: "attacker",
      aud: audience,
      exp: Math.floor(now.getTime() / 1_000) + 300,
    });

    expect(
      authenticator.authenticateAuthorizationHeader(
        `Bearer ${header}.${tamperedPayload}.${signature}`,
      ),
    ).toEqual({ authenticated: false, reason: "SIGNATURE_INVALID" });
  });

  it("requires the configured audience and a non-empty subject", () => {
    const keys = rsaKeys();
    const authenticator = new AdminJwtAuthenticator(
      [issuerConfig("admin-k1", keys.publicPem)],
      () => now,
    );

    expect(
      authenticator.authenticateAuthorizationHeader(
        `Bearer ${jwt({ privateKey: keys.privateKey, payload: { aud: "other-service" } })}`,
      ),
    ).toEqual({ authenticated: false, reason: "AUDIENCE_INVALID" });

    expect(
      authenticator.authenticateAuthorizationHeader(
        `Bearer ${jwt({ privateKey: keys.privateKey, payload: { sub: "   " } })}`,
      ),
    ).toEqual({ authenticated: false, reason: "SUBJECT_INVALID" });
  });

  it("accepts the expected audience within an audience array", () => {
    const keys = rsaKeys();
    const authenticator = new AdminJwtAuthenticator(
      [issuerConfig("admin-k1", keys.publicPem)],
      () => now,
    );

    expect(
      authenticator.authenticateAuthorizationHeader(
        `Bearer ${jwt({ privateKey: keys.privateKey, payload: { aud: ["other", audience] } })}`,
      ),
    ).toMatchObject({ authenticated: true });
  });

  it("fails closed on expired, future-not-before, and future-issued tokens", () => {
    const keys = rsaKeys();
    const authenticator = new AdminJwtAuthenticator(
      [issuerConfig("admin-k1", keys.publicPem)],
      () => now,
      { clockSkewSeconds: 0 },
    );
    const nowSeconds = Math.floor(now.getTime() / 1_000);

    expect(
      authenticator.authenticateAuthorizationHeader(
        `Bearer ${jwt({ privateKey: keys.privateKey, payload: { exp: nowSeconds } })}`,
      ),
    ).toEqual({ authenticated: false, reason: "TOKEN_EXPIRED" });
    expect(
      authenticator.authenticateAuthorizationHeader(
        `Bearer ${jwt({ privateKey: keys.privateKey, payload: { nbf: nowSeconds + 1 } })}`,
      ),
    ).toEqual({ authenticated: false, reason: "TOKEN_NOT_YET_VALID" });
    expect(
      authenticator.authenticateAuthorizationHeader(
        `Bearer ${jwt({ privateKey: keys.privateKey, payload: { iat: nowSeconds + 1 } })}`,
      ),
    ).toEqual({ authenticated: false, reason: "TOKEN_ISSUED_IN_FUTURE" });
  });

  it("rejects malformed and oversized tokens before authorization", () => {
    const keys = rsaKeys();
    const authenticator = new AdminJwtAuthenticator(
      [issuerConfig("admin-k1", keys.publicPem)],
      () => now,
      { maxTokenBytes: 256 },
    );

    expect(authenticator.authenticateAuthorizationHeader("Bearer a.b.c")).toEqual({
      authenticated: false,
      reason: "TOKEN_MALFORMED",
    });
    expect(authenticator.authenticateAuthorizationHeader(`Bearer ${"a".repeat(257)}`)).toEqual({
      authenticated: false,
      reason: "TOKEN_TOO_LARGE",
    });
  });

  it("rejects unsupported verification key types at construction time", () => {
    const pair = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
    const publicPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();

    expect(() => new AdminJwtAuthenticator([issuerConfig("ec384", publicPem)])).toThrow(/P-256/i);
  });
});
