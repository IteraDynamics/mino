#!/usr/bin/env node
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_STATE_FILE = resolve(homedir(), ".mino", "openclaw-personal.json");

export function buildPairingPayload(input) {
  return [
    "MINO-PERSONAL-PAIRING-V1",
    input.externalAgentId,
    input.displayName ?? "",
    input.keyId,
    input.publicKeyFingerprint,
    String(input.timestamp),
    input.nonce,
  ].join("\n");
}

export function buildMandatePayload(input) {
  return [
    "MINO-PERSONAL-MANDATE-V1",
    input.agentId,
    input.keyId,
    String(input.timestamp),
    input.nonce,
  ].join("\n");
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const [command, ...args] = argv;
  switch (command) {
    case "pair":
      return pair(args, environment);
    case "status":
      return status(environment);
    case "activate":
      return activate(environment);
    case "state":
      return stateSummary(environment);
    default:
      throw new Error("Usage: mino-personal.mjs <pair|status|activate|state>");
  }
}

async function pair(args, environment) {
  const baseUrl = requiredBaseUrl(environment);
  const options = parseArgs(args);
  const stateFile = statePath(environment);
  const prior = await loadState(stateFile);
  const externalAgentId = requiredText(
    options["external-agent-id"] ?? prior?.externalAgentId ?? `openclaw-${randomUUID()}`,
    "external agent id",
  );
  const displayName = optionalText(options["display-name"] ?? prior?.displayName ?? "OpenClaw");

  const identity = prior?.privateKeyPem && prior?.publicKeyPem && prior?.keyId
    ? {
        keyId: prior.keyId,
        publicKeyPem: prior.publicKeyPem,
        privateKeyPem: prior.privateKeyPem,
      }
    : generateIdentity();
  const publicKey = createPublicKey(identity.publicKeyPem);
  const fingerprint = createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("base64url");
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(18).toString("base64url");
  const payload = buildPairingPayload({
    externalAgentId,
    displayName,
    keyId: identity.keyId,
    publicKeyFingerprint: fingerprint,
    timestamp,
    nonce,
  });
  const signature = sign(null, Buffer.from(payload), createPrivateKey(identity.privateKeyPem)).toString("base64url");

  const response = await jsonRequest(`${baseUrl}/v1/personal/pairing-requests`, {
    method: "POST",
    body: {
      externalAgentId,
      ...(displayName ? { displayName } : {}),
      keyId: identity.keyId,
      publicKey: identity.publicKeyPem,
      proof: { timestamp, nonce, signature },
    },
  });
  const pairing = response.pairing;
  if (!pairing?.id || !pairing?.claimSecret) {
    throw new Error("Mino pairing response did not contain the required one-time claim material");
  }

  await saveState(stateFile, {
    baseUrl,
    externalAgentId,
    ...(displayName ? { displayName } : {}),
    ...identity,
    pairingRequestId: pairing.id,
    claimSecret: pairing.claimSecret,
    pairingExpiresAt: pairing.expiresAt,
  });
  printJson({
    outcome: "PAIRING_PENDING",
    pairingRequestId: pairing.id,
    claimSecret: pairing.claimSecret,
    expiresAt: pairing.expiresAt,
    publicKeyFingerprint: pairing.publicKeyFingerprint,
  });
}

async function status(environment) {
  const stateFile = statePath(environment);
  const state = requiredState(await loadState(stateFile));
  if (!state.pairingRequestId) throw new Error("No pairing request exists; run pair first");
  const baseUrl = requiredBaseUrl(environment, state.baseUrl);
  const response = await jsonRequest(
    `${baseUrl}/v1/personal/pairing-requests/${encodeURIComponent(state.pairingRequestId)}`,
    { method: "GET" },
  );
  const pairing = response.pairing;
  if (!pairing?.status) throw new Error("Mino pairing status response is malformed");
  const next = {
    ...state,
    ...(pairing.agentId ? { agentId: pairing.agentId } : {}),
  };
  await saveState(stateFile, next);
  printJson({
    outcome: pairing.status,
    pairingRequestId: pairing.id,
    ...(pairing.agentId ? { agentId: pairing.agentId } : {}),
    expiresAt: pairing.expiresAt,
  });
}

async function activate(environment) {
  const stateFile = statePath(environment);
  const state = requiredState(await loadState(stateFile));
  if (!state.agentId) throw new Error("Agent is not claimed yet; run status after the owner claims the pairing");
  if (!state.privateKeyPem || !state.keyId) throw new Error("Local Mino key material is missing");
  const baseUrl = requiredBaseUrl(environment, state.baseUrl);
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(18).toString("base64url");
  const payload = buildMandatePayload({ agentId: state.agentId, keyId: state.keyId, timestamp, nonce });
  const signature = sign(null, Buffer.from(payload), createPrivateKey(state.privateKeyPem)).toString("base64url");
  const response = await jsonRequest(
    `${baseUrl}/v1/personal/agents/${encodeURIComponent(state.agentId)}/mandate`,
    {
      method: "POST",
      body: { keyId: state.keyId, timestamp, nonce, signature },
    },
  );
  if (response.outcome !== "ISSUED" || !response.mandateToken) {
    throw new Error("Mino did not issue an agent mandate credential");
  }
  await saveState(stateFile, {
    ...state,
    mandateId: response.mandateId,
    mandateToken: response.mandateToken,
    mandateExpiresAt: response.expiresAt,
    policyVersion: response.policyVersion,
  });
  printJson({
    outcome: "ACTIVE",
    agentId: state.agentId,
    mandateId: response.mandateId,
    expiresAt: response.expiresAt,
    policyVersion: response.policyVersion,
  });
}

async function stateSummary(environment) {
  const state = await loadState(statePath(environment));
  printJson({
    configured: !!state,
    paired: !!state?.agentId,
    authorityCredentialPresent: !!state?.mandateToken,
    ...(state?.externalAgentId ? { externalAgentId: state.externalAgentId } : {}),
    ...(state?.agentId ? { agentId: state.agentId } : {}),
    ...(state?.mandateExpiresAt ? { mandateExpiresAt: state.mandateExpiresAt } : {}),
    ...(state?.policyVersion ? { policyVersion: state.policyVersion } : {}),
  });
}

function generateIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    keyId: `openclaw-k-${randomUUID()}`,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

async function jsonRequest(url, { method, body }) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
  } catch (error) {
    throw new Error("Could not reach Mino", { cause: error });
  }
  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { error: "non_json_response" };
    }
  }
  if (!response.ok) {
    const code = parsed?.error ?? parsed?.outcome ?? `http_${response.status}`;
    throw new Error(`Mino request failed: ${code}`);
  }
  return parsed ?? {};
}

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token?.startsWith("--")) throw new Error(`Unexpected argument: ${token ?? ""}`);
    const key = token.slice(2);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    result[key] = value;
    index += 1;
  }
  return result;
}

function requiredBaseUrl(environment, fallback) {
  const value = (environment.MINO_BASE_URL ?? fallback ?? "").trim();
  if (!value) throw new Error("MINO_BASE_URL is required");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("MINO_BASE_URL must be a valid URL");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname))) {
    throw new Error("MINO_BASE_URL must use HTTPS except for loopback development");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function statePath(environment) {
  return resolve(environment.MINO_STATE_FILE?.trim() || DEFAULT_STATE_FILE);
}

async function loadState(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error("Could not read Mino local state", { cause: error });
  }
}

async function saveState(file, state) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
  await chmod(file, 0o600).catch(() => undefined);
}

function requiredState(state) {
  if (!state) throw new Error("Mino is not initialized; run pair first");
  return state;
}

function requiredText(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function optionalText(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return undefined;
  if (normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error("display name is invalid");
  }
  return normalized;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Mino helper failed"}\n`);
    process.exitCode = 1;
  });
}
