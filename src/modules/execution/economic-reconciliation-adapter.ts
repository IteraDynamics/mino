import type { EconomicProviderProtocol } from "../../domain/economic/economic-intent.types.js";
import type { PaymentOutcomeRecord } from "../payments/payment-outcome.store.js";

export interface EconomicProviderEvidence {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export type EconomicReconciliationObservation =
  | {
      readonly disposition: "SUCCEEDED";
      readonly evidence: EconomicProviderEvidence;
    }
  | {
      readonly disposition: "FAILED_DEFINITIVE";
      readonly evidence: EconomicProviderEvidence;
    }
  | {
      readonly disposition: "DEFERRED";
      readonly errorCode: string;
      readonly providerStatus?: number;
    };

/**
 * Provider-neutral boundary for interpreting durable execution outcomes.
 *
 * The reconciler owns Mino state transitions (reservation hold/commit/release,
 * durable outcome transitions, leases, and backoff). A provider adapter owns
 * how provider state is queried and what that provider state means.
 */
export interface EconomicReconciliationAdapter {
  readonly protocol: EconomicProviderProtocol;
  reconcile(outcome: PaymentOutcomeRecord): Promise<EconomicReconciliationObservation>;
}

/** Server-side provider credential lookup used by execution/reconciliation adapters. */
export interface EconomicProviderCredentialProvider {
  getAuthorization(
    organizationId: string,
    providerTargetId: string,
  ): Promise<string | undefined>;
}
