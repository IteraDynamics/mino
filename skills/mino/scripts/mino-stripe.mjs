#!/usr/bin/env node
import {
  createHash,
  createPrivateKey,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildAgentRequestPayload } from "./mino-personal.mjs";

const DEFAULT_STATE_FILE = resolve(homedir(), ".mino", "openclaw-personal.json");
export const MINO_PERSONAL_STRIPE_API_VERSION = "2026-08-26";

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const [command, ...args] = argv;
  switch (command) {
    case "confirm":
      return confirm(args, environment);
    case "retry":
      return retry(environment);
    default:
      throw new Error("Usage: mino-stripe.mjs <confirm --payment-intent-id pi_...|retry>");
  }
}

async function confirm(args, environment) {
  const options = parseArgs(args);
  const paymentIntentId = requiredPaymentIntentId(options["payment-intent-id"]);
  const stateFile = statePath(environment);
  const state = requireExecutionState(await loadState(stateFile));
  const pending = {
    paymentIntentId,
    idempotencyKey: randomUUID(),
  };
  await saveState(stateFile, { ...state, pendingStripeExecution: pending });
  await runPending(stateFile, state, pending, environment);
}

async function retry(environment) {
  const stateFile = statePath(environment);
  const state = requireExecutionState(await loadState(stateFile));
  const pending = state.pendingStripeExecution;
  if (!pending?.paymentIntentId || !pending?.idempotencyKey) {
    throw new Error("No pending Mino Stripe execution exists to retry");
  }
  await runPending(stateFile, state, pending, environment);
}

async function runPending(stateFile, state, pending, environment) {
  const baseUrl = requiredBaseUrl(environment, state.baseUrl);
  const path = `/v1/personal/stripe/payment_intents/${encodeURIComponent(pending.paymentIntentId)}/confirm`;
  const body = {};
  const response = await signedRequest(
    baseUrl,
    path,
    body,
    pending.idempotencyKey,
    state,
  );
  const payload = response.body ?? {};
  const verdict = payload?.decision?.verdict;

  if (response.status === 202 && verdict === "PENDING_HUMAN_APPROVAL") {
    if (!payload.approval_request_id) {
      throw new Error("Mino returned a pending Stripe approval without an approval request id");
    }
    await saveState(stateFile, {
      ...state,
      pendingStripeExecution: {
        ...pending,
        approvalRequestId: payload.approval_request_id,
      },
    });
    printJson({
      outcome: "OWNER_APPROVAL_REQUIRED",
      paymentIntentId: pending.paymentIntentId,
      approvalRequestId: payload.approval_request_id,
      idempotencyKey: pending.idempotencyKey,
      next: "retry",
    });
    return;
  }

  if (
    response.status === 409 &&
    (payload.error === "PAYMENT_OUTCOME_PENDING" ||
      payload.error === "AUTHORIZATION_RECEIPT_PENDING")
  ) {
    await saveState(stateFile, {
      ...state,
      pendingStripeExecution: {
        ...pending,
        ...(payload.payment_outcome_id
          ? { paymentOutcomeId: payload.payment_outcome_id }
          : {}),
      },
    });
    printJson({
      outcome: payload.error,
      paymentIntentId: pending.paymentIntentId,
      ...(payload.payment_outcome_id
        ? { paymentOutcomeId: payload.payment_outcome_id }
        : {}),
      retryAfterSeconds: response.retryAfterSeconds,
      next: "retry",
    });
    return;
  }

  if (response.status === 409 && payload.error === "STRIPE_STATE_CONFLICT") {
    await saveState(stateFile, { ...state, pendingStripeExecution: undefined });
    printJson({
      outcome: "REAUTHORIZE_REQUIRED",
      paymentIntentId: pending.paymentIntentId,
      reason: payload.reason,
    });
    return;
  }

  if (response.status === 403 && verdict === "BLOCK") {
    await saveState(stateFile, { ...state, pendingStripeExecution: undefined });
    printJson({
      outcome: "BLOCKED",
      paymentIntentId: pending.paymentIntentId,
      reasons: Array.isArray(payload?.decision?.reasons) ? payload.decision.reasons : [],
    });
    return;
  }

  if (response.status >= 200 && response.status < 300) {
    const providerStatus = payload?.upstream?.status;
    if (providerStatus === "succeeded") {
      await saveState(stateFile, { ...state, pendingStripeExecution: undefined });
      printJson({
        outcome: "COMPLETED",
        paymentIntentId: payload.payment_intent_id ?? pending.paymentIntentId,
        paymentOutcomeId: payload.payment_outcome_id,
        authorizationReceipt: payload.authorization_receipt ?? null,
        idempotentReplayed: payload.idempotent_replayed === true,
      });
      return;
    }
    if (providerStatus === "canceled") {
      await saveState(stateFile, { ...state, pendingStripeExecution: undefined });
      printJson({
        outcome: "FAILED_DEFINITIVE",
        paymentIntentId: payload.payment_intent_id ?? pending.paymentIntentId,
        paymentOutcomeId: payload.payment_outcome_id,
        authorizationReceipt: payload.authorization_receipt ?? null,
        idempotentReplayed: payload.idempotent_replayed === true,
      });
      return;
    }
  }

  const code = payload?.error ?? payload?.outcome ?? `http_${response.status}`;
  throw new Error(`Mino Stripe execution failed: ${code}`);
}

async function signedRequest(baseUrl, path, body, idempotencyKey, state) {
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
    apiVersion: MINO_PERSONAL_STRIPE_API_VERSION,
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
      "api-version": MINO_PERSONAL_STRIPE_API_VERSION,
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

async function rawJsonRequest(url, { method, headers = {}, body }) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { accept: "application/json", ...headers },
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
  const retryAfterSeconds = retryAfter && /^\d+$/.test(retryAfter)
    ? Number(retryAfter)
    : undefined;
  return {
    status: response.status,
    body: parsed ?? {},
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
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
  if (
    typeof claims.jti !== "string" ||
    !claims.jti ||
    typeof claims.agentId !== "string" ||
    !claims.agentId
  ) {
    throw new Error("Local mandate credential is missing required bindings");
  }
  return {
    agentId: claims.agentId,
    tokenJtiHash: createHash("sha256").update(claims.jti).digest("hex"),
  };
}

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token?.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token ?? ""}`);
    }
    const key = token.slice(2);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    result[key] = value;
    index += 1;
  }
  return result;
}

function requiredPaymentIntentId(value) {
  const normalized = String(value ?? "").trim();
  if (!/^pi_[A-Za-z0-9]+$/.test(normalized)) {
    throw new Error("payment intent id is invalid");
  }
  return normalized;
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
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname))
  ) {
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
  await writeFile(temporary, `${JSON.stringify(serializable, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, file);
  await chmod(file, 0o600).catch(() => undefined);
}

function requireExecutionState(state) {
  if (!state) throw new Error("Mino is not initialized; run pair first");
  if (!state.agentId || !state.keyId || !state.privateKeyPem || !state.mandateToken) {
    throw new Error("Mino authority is not active; pair, claim, grant authority, and run activate first");
  }
  return state;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Mino Stripe helper failed"}\n`);
    process.exitCode = 1;
  });
}