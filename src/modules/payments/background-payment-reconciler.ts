import type { EconomicReconciliationAdapter } from "../execution/economic-reconciliation-adapter.js";
import type { AuthorizationReservations } from "../spending/authorization-reservation.service.js";
import type {
  PaymentOutcomeRecord,
  ReconciliationPaymentOutcomeStore,
} from "./payment-outcome.store.js";

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_FORWARDING_GRACE_MS = 30_000;
const DEFAULT_BASE_BACKOFF_MS = 5_000;
const DEFAULT_MAX_BACKOFF_MS = 15 * 60 * 1000;

export interface BackgroundPaymentReconcilerDependencies {
  readonly outcomes: ReconciliationPaymentOutcomeStore;
  readonly reservations: AuthorizationReservations;
  readonly reconciliation: EconomicReconciliationAdapter;
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

    const observation = await this.deps.reconciliation.reconcile(outcome);

    if (observation.disposition === "DEFERRED") {
      return this.defer(
        outcome,
        workerId,
        now,
        observation.errorCode,
        observation.providerStatus,
      );
    }

    if (observation.disposition === "SUCCEEDED") {
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
          observation.evidence.status,
        );
      }

      await this.deps.outcomes.markSucceeded(
        outcome.id,
        observation.evidence,
        now,
      );
      return "SUCCEEDED";
    }

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
        observation.evidence.status,
      );
    }

    await this.deps.outcomes.markDefinitiveFailure(
      outcome.id,
      observation.evidence,
      now,
    );
    return "FAILED_DEFINITIVE";
  }

  private async defer(
    outcome: PaymentOutcomeRecord,
    workerId: string,
    now: Date,
    errorCode: string,
    upstreamStatus?: number,
  ): Promise<"DEFERRED"> {
    const delayMs = reconciliationBackoffMs(
      outcome.reconcileAttempts ?? 1,
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

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Reconciliation ${label} must be a positive integer`);
  }
}
