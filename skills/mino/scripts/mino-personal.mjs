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
const MINO_ACP_API_VERSION = "2026-04-17";
const MAX_EXECUTION_BODY_BYTES = 1_000_000;

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

export function buildAgentRequestPayload(input) {
  const bodyDigest = sha256Base64Url(canonicalJson(input.body));
  return [
    "MINO-AGENT-REQUEST-V1",
    input.method.trim().toUpperCase(),
    normalizePath(input.path),
    input.timestamp,
    input.nonce,
    input.mandateTokenJtiHash,
    input.apiVersion,
    input.idempotencyKey,
    bodyDigest,
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
    case "complete":
      return complete(args, environment);
    case "retry-pending":
      return retryPending(environment);
    default:
      throw new Error(
        "Usage: mino-personal.mjs <pair|status|activate|state|complete|retry-pending>",
      );
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
    pendingExecution: undefined,
  });
  printJson({
    outcome: "ACTIVE",
    agentId: state.agentId,
    mandateId: response.mandateId,
    expiresAt: response.expiresAt,
    policyVersion: response.policyVersion,
  });
}

async function complete(args, environment) {
  const options = parseArgs(args);
  const merchantId = requiredText(options["merchant-id"], "merchant id");
  const checkoutSessionId = requiredText(options["checkout-session-id"], "checkout session id");
  const bodyFile = requiredText(options["body-file"], "body file");
  const body = await readExecutionBody(bodyFile);
  const stateFile = statePath(environment);
  const state = requireExecutionState(await loadState(stateFile));
  const pending = {
    operation: "COMPLETE_CHECKOUT",
    merchantId,
    checkoutSessionId,
    body,
    idempotencyKey: randomUUID(),
  };
  await runPendingExecution(stateFile, state, pending, environment);
}

async function retryPending(environment) {
  const stateFile = statePath(environment);
  const state = requireExecutionState(await loadState(stateFile));
  const pending = state.pendingExecution;
  if (!pending || pending.operation !== "COMPLETE_CHECKOUT") {
    throw new Error("No pending Mino completion exists to retry");
  }
  await runPendingExecution(stateFile, state, pending, environment);
}

async function runPendingExecution(stateFile, state, pending, environment) {
  const baseUrl = requiredBaseUrl(environment, state.baseUrl);
  const path = `/v1/personal/acp/${encodeURIComponent(pending.merchantId)}/checkout_sessions/${encodeURIComponent(pending.checkoutSessionId)}/complete`;
  const response = await signedExecutionRequest(baseUrl, path, pending.body, pending.idempotencyKey, state);
  const body = response.body ?? {};
  const verdict = body?.decision?.verdict;

  if (response.status === 202 && verdict === "PENDING_HUMAN_APPROVAL") {
    if (!body.approval_request_id) {
      throw new Error("Mino returned a pending approval without an approval request id");
    }
    await saveState(stateFile, {
      ...state,
      pendingExecution: {
        ...pending,
        approvalRequestId: body.approval_request_id,
      },
    });
    printJson({
      outcome: "OWNER_APPROVAL_REQUIRED",
      approvalRequestId: body.approval_request_id,
      checkoutSessionId: pending.checkoutSessionId,
      idempotencyKey: pending.idempotencyKey,
      next: "retry-pending",
    });
    return;
  }

  if (response.status === 409 && body.error === "PAYMENT_OUTCOME_PENDING") {
    await saveState(stateFile, {
      ...state,
      pendingExecution: {
        ...pending,
        paymentOutcomeId: body.payment_outcome_id,
      },
    });
    printJson({
      outcome: "PAYMENT_OUTCOME_PENDING",
      checkoutSessionId: pending.checkoutSessionId,
      paymentOutcomeId: body.payment_outcome_id,
      retryAfterSeconds: response.retryAfterSeconds,
      next: "retry-pending",
    });
    return;
  }

  if (response.status === 403 && verdict === "BLOCK") {
    await saveState(stateFile, { ...state, pendingExecution: undefined });
    printJson({
      outcome: "BLOCKED",
      checkoutSessionId: pending.checkoutSessionId,
      reasons: Array.isArray(body?.decision?.reasons) ? body.decision.reasons : [],
    });
    return;
  }

  if (response.status >= 200 && response.status < 300 && verdict === "ALLOW") {
    await saveState(stateFile, { ...state, pendingExecution: undefined });
    printJson({
      outcome: "COMPLETED",
      checkoutSessionId: body.checkout_session_id ?? pending.checkoutSessionId,
      paymentOutcomeId: body.payment_outcome_id,
      idempotentReplayed: body.idempotent_replayed === true,
      reasons: Array.isArray(body?.decision?.reasons) ? body.decision.reasons : [],
    });
    return;
  }

  const code = body?.error ?? body?.outcome ?? `http_${response.status}`;
  throw new Error(`Mino execution failed: ${code}`);
}

async function signedExecutionRequest(baseUrl, path, body, idempotencyKey, state) {
  const mandate = readMandateBinding(state.mandateToken);
  if (mandate.agentId !== state.agentId) {
    throw new Error("Local mandate credential is bound to a different agent");
  }
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(18).toString("base64url");
  const signingPayload = buildAgentRequestPayload({
    method: "POST",
    path,
    timestamp,
    nonce,
    body,
    mandateTokenJtiHash: mandate.tokenJtiHash,
    idempotencyKey,
    apiVersion: MINO_ACP_API_VERSION,
  });
  const signature = sign(
    null,
    Buffer.from(signingPayload),
    createPrivateKey(state.privateKeyPem),
  ).toString("base64url");

  return rawJsonRequest(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      "api-version": MINO_ACP_API_VERSION,
      "x-mino-mandate-token": state.mandateToken,
      "x-mino-agent-id": state.agentId,
      "x-mino-agent-key-id": state.keyId,
      "x-mino-agent-timestamp": timestamp,
      "x-mino-agent-nonce": nonce,
      "x-mino-agent-signature": signature,
    },
    body,
  });
}

async function stateSummary(environment) {
  const state = await loadState(statePath(environment));
  printJson({
    configured: !!state,
    paired: !!state?.agentId,
    authorityCredentialPresent: !!state?.mandateToken,
    pendingExecution: state?.pendingExecution?.operation ?? null,
    ...(state?.pendingExecution?.approvalRequestId
      ? { pendingApprovalRequestId: state.pendingExecution.approvalRequestId }
      : {}),
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
  const response = await rawJsonRequest(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body,
  });
  if (response.status < 200 || response.status >= 300) {
    const code = response.body?.error ?? response.body?.outcome ?? `http_${response.status}`;
    throw new Error(`Mino request failed: ${code}`);
  }
  return response.body ?? {};
}

async function rawJsonRequest(url, { method, headers = {}, body }) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        accept: "application/json",
        ...headers,
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
  const retryAfter = response.headers.get("retry-after");
  const retryAfterSeconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined;
  return {
    status: response.status,
    body: parsed ?? {},
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}

async function readExecutionBody(file) {
  const absolute = resolve(file);
  let text;
  try {
    text = await readFile(absolute, "utf8");
  } catch (error) {
    throw new Error("Could not read execution body file", { cause: error });
  }
  if (Buffer.byteLength(text, "utf8") > MAX_EXECUTION_BODY_BYTES) {
    throw new Error("Execution body file is too large");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Execution body file must contain valid JSON");
  }
}

function readMandateBinding(token) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3 || !parts[1]) {
    throw new Error("Local mandate credential is malformed");
  }
  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("Local mandate credential claims are malformed");
  }
  if (typeof claims.jti !== "string" || !claims.jti || typeof claims.agentId !== "string" || !claims.agentId) {
    throw new Error("Local mandate credential is missing required bindings");
  }
  return {
    agentId: claims.agentId,
    tokenJtiHash: createHash("sha256").update(claims.jti).digest("hex"),
  };
}

function canonicalJson(value) {
  return JSON.stringify(normalizeCanonical(value));
}

function normalizeCanonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite numbers cannot be canonicalized");
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeCanonical);
  if (typeof value === "object") {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) output[key] = normalizeCanonical(value[key]);
    }
    return output;
  }
  throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`);
}

function sha256Base64Url(value) {
  return createHash("sha256").update(value).digest("base64url");
}

function normalizePath(path) {
  const index = path.indexOf("?");
  return index === -1 ? path : path.slice(0, index);
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
  const serializable = Object.fromEntries(
    Object.entries(state).filter(([, value]) => value !== undefined),
  );
  await writeFile(temporary, `${JSON.stringify(serializable, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
  await chmod(file, 0o600).catch(() => undefined);
}

function requiredState(state) {
  if (!state) throw new Error("Mino is not initialized; run pair first");
  return state;
}

function requireExecutionState(state) {
  const value = requiredState(state);
  if (!value.agentId || !value.keyId || !value.privateKeyPem || !value.mandateToken) {
    throw new Error("Mino authority is not active; pair, claim, grant authority, and run activate first");
  }
  return value;
}

function requiredText(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
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
