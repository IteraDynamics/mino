import { describe, expect, it } from "vitest";
import type { EconomicReconciliationObservation } from "../../src/modules/execution/economic-reconciliation-adapter.js";
import { BackgroundPaymentReconciler } from "../../src/modules/payments/background-payment-reconciler.js";
import {
  BeginPaymentOutcomeKind,
  PaymentOutcomeStatus,
  type PaymentOutcomeRecord,
  type ReconciliationPaymentOutcomeStore,
} from "../../src/modules/payments/payment-outcome.store.js";
import type {
  AuthorizationReservations,
  ReservationAttemptInput,
  ReservationAttemptResult,
} from "../../src/modules/spending/authorization-reservation.service.js";

const NOW = new Date("2026-08-19T13:00:00.000Z");

function outcome(): PaymentOutcomeRecord {
  return {
    id: "outcome-35",
    organizationId: "org-35",
    userId: "user-35",
    agentId: "agent-35",
    mandateId: "mandate-35",
    reservationId: "reservation-35",
    idempotencyKey: "idem-35",
    requestDigest: "request-digest-35",
    merchantId: "legacy-target-35",
    merchantDomain: "legacy.example",
    checkoutSessionId: "legacy-resource-35",
    amountMinor: 5_000n,
    currency: "USD",
    status: PaymentOutcomeStatus.UNKNOWN,
    createdAt: NOW,
    updatedAt: NOW,
    reconcileAttempts: 1,
  };
}

describe("provider-neutral reconciliation boundary", () => {
  it("lets the reconciliation core consume a non-ACP provider observation without provider semantics", async () => {
    const record = outcome();
    let claimed = false;
    let committed = 0;
    let markedSucceeded: PaymentOutcomeRecord | undefined;

    const store: ReconciliationPaymentOutcomeStore = {
      async getByIdempotency() {
        return undefined;
      },
      async begin() {
        return { kind: BeginPaymentOutcomeKind.CREATED, outcome: record };
      },
      async markUnknown() {
        return record;
      },
      async markSucceeded(_id, response, now) {
        markedSucceeded = {
          ...record,
          status: PaymentOutcomeStatus.SUCCEEDED,
          response,
          updatedAt: now,
          resolvedAt: now,
        };
        return markedSucceeded;
      },
      async markDefinitiveFailure() {
        throw new Error("not expected");
      },
      async markReconciled() {
        return record;
      },
      async claimForReconciliation() {
        if (claimed) {
          return [];
        }
        claimed = true;
        return [record];
      },
      async deferReconciliation() {
        throw new Error("not expected");
      },
    };

    const reservations: AuthorizationReservations = {
      async tryReserve(_input: ReservationAttemptInput): Promise<ReservationAttemptResult> {
        throw new Error("not used");
      },
      async commit() {
        committed += 1;
        return true;
      },
      async release() {
        throw new Error("not expected");
      },
      async releaseForApproval() {
        throw new Error("not used");
      },
      async holdForReconciliation() {
        return true;
      },
    };

    const observation: EconomicReconciliationObservation = {
      disposition: "SUCCEEDED",
      evidence: {
        status: 200,
        body: { provider: "stripe", state: "succeeded" },
        headers: { "request-id": "provider-request-35" },
      },
    };

    const reconciler = new BackgroundPaymentReconciler({
      outcomes: store,
      reservations,
      reconciliation: {
        protocol: "STRIPE",
        async reconcile(received) {
          expect(received).toBe(record);
          return observation;
        },
      },
    });

    const result = await reconciler.runOnce("worker-35", NOW);

    expect(result).toEqual({
      claimed: 1,
      succeeded: 1,
      failedDefinitive: 0,
      deferred: 0,
      errors: 0,
    });
    expect(committed).toBe(1);
    expect(markedSucceeded?.response?.body).toEqual({
      provider: "stripe",
      state: "succeeded",
    });
  });
});
