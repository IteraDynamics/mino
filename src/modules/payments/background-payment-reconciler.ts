import { redactSensitivePayload } from "../audit/audit-sink.js";
import type {
  ACPMerchantClient,
  MerchantEndpoint,
  MerchantRegistry,
  MerchantResponse,
} from "../proxy/merchant-client.js";
import {
  ACPProtocolError,
  ACP_STABLE_VERSION,
  parseCheckoutSession,
  type ACPCheckoutSession,
} from "../proxy/acp-adapter.js";
import type { AuthorizationReservations } from "../spending/authorization-reservation.service.js";
import type {
  PaymentOutcomeRecord,
  ReconciliationPaymentOutcomeStore,
  StoredMerchantResponse,
} from "./payment-outcome.store.js";

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_FORWARDING_GRACE_MS = 30_000;
const DEFAULT_BASE_BACKOFF_MS = 5_000;
const DEFAULT_MAX_BACKOFF_MS = 15 * 60 * 1000;

export interface MerchantCredentialProvider {
  getAuthorization(
    organizationId: string,
    merchantId: string,
  ): Promise<string | undefined>;
}

export interface BackgroundPaymentReconcilerDependencies {
  readonly outcomes: ReconciliationPaymentOutcomeStore;
  readonly reservations: AuthorizationReservations;
  readonly merchants: MerchantRegistry;
  readonly merchantClient: ACPMerchantClient;
  readonly credentials: MerchantCredentialProvider;
  readonly generateRequestId: () => string;
}

export interface BackgroundPaymentReconcilerOptions {
  readonly batchSize?: number;
  readonly leaseMs?: number;
  readonly forwardingGraceMs?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
}

export interface ReconciliationRunResult {
  readonly claimed: number;
  readonly succeeded: number;
  readonly failedDefinitive: number;
  readonly deferred: number;
  readonly errors: number;
}

type ReconciliationDisposition = "SUCCEEDED" | "FAILED_DEFINITIVE" | "DEFERRED";

export class BackgroundPaymentReconciler {
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly forwardingGraceMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;

  public constructor(
    private readonly deps: BackgroundPaymentReconcilerDependencies,
    options: BackgroundPaymentReconcilerOptions = {},
  ) {
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.forwardingGraceMs = options.forwardingGraceMs ?? DEFAULT_FORWARDING_GRACE_MS;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;

    assertPositiveInteger(this.batchSize, "batch size");
    assertPositiveInteger(this.leaseMs, "lease duration");
    if (!Number.isSafeInteger(this.forwardingGraceMs) || this.forwardingGraceMs < 0) {
      throw new Error("Reconciliation forwarding grace must be a non-negative integer");
    }
    assertPositiveInteger(this.baseBackoffMs, "base backoff");
    assertPositiveInteger(this.maxBackoffMs, "maximum backoff");
    if (this.maxBackoffMs < this.baseBackoffMs) {
      throw new Error("Reconciliation maximum backoff cannot be lower than base backoff");
    }
  }

  public async runOnce(workerId: string, now: Date): Promise<ReconciliationRunResult> {
    if (!workerId.trim()) {
      throw new Error("Reconciliation worker ID is required");
    }

    const claimed = await this.deps.outcomes.claimForReconciliation({
      workerId,
      now,
      limit: this.batchSize,
      leaseMs: this.leaseMs,
      forwardingGraceMs: this.forwardingGraceMs,
    });

    let succeeded = 0;
    let failedDefinitive = 0;
    let deferred = 0;
    let errors = 0;

    for (const outcome of claimed) {
      try {
        const disposition = await this.reconcileOne(outcome, workerId, now);
        if (disposition === "SUCCEEDED") {
          succeeded += 1;
        } else if (disposition === "FAILED_DEFINITIVE") {
          failedDefinitive += 1;
        } else {
          deferred += 1;
        }
      } catch {
        errors += 1;
      }
    }

    return {
      claimed: claimed.length,
      succeeded,
      failedDefinitive,
      deferred,
      errors,
    };
  }

  private async reconcileOne(
    outcome: PaymentOutcomeRecord,
    workerId: string,
    now: Date,
  ): Promise<ReconciliationDisposition> {
    const held = await this.deps.reservations.holdForReconciliation(
      outcome.mandateId,
      outcome.reservationId,
      now,
    );
    if (!held) {
      return this.defer(outcome, workerId, now, "RECONCILIATION_HOLD_MISSING");
    }

    const merchant = await this.deps.merchants.getById(
      outcome.organizationId,
      outcome.merchantId,
    );
    if (!merchant || !merchant.active) {
      return this.defer(outcome, workerId, now, "MERCHANT_ENDPOINT_UNAVAILABLE");
    }
    if (canonicalDomain(merchant.domain) !== canonicalDomain(outcome.merchantDomain)) {
      return this.defer(outcome, workerId, now, "MERCHANT_REGISTRY_MISMATCH");
    }

    const authorization = await this.deps.credentials.getAuthorization(
      outcome.organizationId,
      outcome.merchantId,
    );
    if (!authorization || !/^Bearer\s+\S+$/i.test(authorization)) {
      return this.defer(outcome, workerId, now, "MERCHANT_CREDENTIAL_UNAVAILABLE");
    }

    let upstream: MerchantResponse;
    try {
      upstream = await this.deps.merchantClient.getCheckout(
        merchant,
        outcome.checkoutSessionId,
        {
          authorization,
          apiVersion: ACP_STABLE_VERSION,
          idempotencyKey: outcome.idempotencyKey,
          requestId: this.deps.generateRequestId(),
        },
      );
    } catch {
      return this.defer(outcome, workerId, now, "MERCHANT_RECONCILIATION_TRANSPORT_FAILURE");
    }

    if (upstream.status < 200 || upstream.status >= 300) {
      return this.defer(
        outcome,
        workerId,
        now,
        `MERCHANT_RECONCILIATION_HTTP_${upstream.status}`,
        upstream.status,
      );
    }

    let session: ACPCheckoutSession;
    try {
      session = parseCheckoutSession(upstream.body);
    } catch (error) {
      if (error instanceof ACPProtocolError) {
        return this.defer(
          outcome,
          workerId,
          now,
          "MERCHANT_RECONCILIATION_INVALID_CHECKOUT",
          upstream.status,
        );
      }
      throw error;
    }

    if (session.id !== outcome.checkoutSessionId) {
      return this.defer(
        outcome,
        workerId,
        now,
        "MERCHANT_RECONCILIATION_CHECKOUT_ID_MISMATCH",
        upstream.status,
      );
    }

    const status = session.status.trim().toLowerCase();
    if (status === "completed") {
      if (!isRecord(session.order)) {
        return this.defer(
          outcome,
          workerId,
          now,
          "MERCHANT_COMPLETED_SESSION_MISSING_ORDER",
          upstream.status,
        );
      }

      const committed = await this.deps.reservations.commit(
        outcome.mandateId,
        outcome.reservationId,
        now,
      );
      if (!committed) {
        return this.defer(
          outcome,
          workerId,
          now,
          "RECONCILED_RESERVATION_COMMIT_FAILED",
          upstream.status,
        );
      }

      await this.deps.outcomes.markSucceeded(
        outcome.id,
        storedResponse(upstream, session),
        now,
      );
      return "SUCCEEDED";
    }

    if (status === "canceled" || status === "cancelled") {
      const released = await this.deps.reservations.release(
        outcome.mandateId,
        outcome.reservationId,
      );
      if (!released) {
        return this.defer(
          outcome,
          workerId,
          now,
          "RECONCILED_RESERVATION_RELEASE_FAILED",
          upstream.status,
        );
      }

      await this.deps.outcomes.markDefinitiveFailure(
        outcome.id,
        storedResponse(upstream, session),
        now,
      );
      return "FAILED_DEFINITIVE";
    }

    return this.defer(
      outcome,
      workerId,
      now,
      "MERCHANT_CHECKOUT_NOT_TERMINAL",
      upstream.status,
    );
  }

  private async defer(
    outcome: PaymentOutcomeRecord,
    workerId: string,
    now: Date,
    errorCode: string,
    upstreamStatus?: number,
  ): Promise<"DEFERRED"> {
    const delayMs = reconciliationBackoffMs(
      outcome.reconcileAttempts,
      this.baseBackoffMs,
      this.maxBackoffMs,
    );
    const nextAttemptAt = new Date(now.getTime() + delayMs);
    await this.deps.outcomes.deferReconciliation(outcome.id, {
      workerId,
      now,
      nextAttemptAt,
      errorCode,
      ...(upstreamStatus !== undefined ? { upstreamStatus } : {}),
    });
    return "DEFERRED";
  }
}

export function reconciliationBackoffMs(
  reconcileAttempts: number,
  baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
  maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
): number {
  assertPositiveInteger(baseBackoffMs, "base backoff");
  assertPositiveInteger(maxBackoffMs, "maximum backoff");
  if (!Number.isSafeInteger(reconcileAttempts) || reconcileAttempts < 1) {
    throw new Error("Reconciliation attempt count must be a positive integer");
  }
  const exponent = Math.min(reconcileAttempts - 1, 20);
  return Math.min(maxBackoffMs, baseBackoffMs * 2 ** exponent);
}

function storedResponse(
  upstream: MerchantResponse,
  session: ACPCheckoutSession,
): StoredMerchantResponse {
  const headers = safeResponseHeaders(upstream.headers);
  return {
    status: upstream.status,
    body: redactSensitivePayload(session),
    ...(headers ? { headers } : {}),
  };
}

function safeResponseHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (!headers) {
    return undefined;
  }
  const allowed = new Set(["request-id", "x-request-id", "idempotency-key"]);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (allowed.has(key.toLowerCase())) {
      result[key.toLowerCase()] = value;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function canonicalDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Reconciliation ${label} must be a positive integer`);
  }
}
