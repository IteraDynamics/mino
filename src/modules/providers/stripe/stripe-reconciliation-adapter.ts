import type {
  EconomicProviderCredentialProvider,
  EconomicReconciliationAdapter,
  EconomicReconciliationObservation,
} from "../../execution/economic-reconciliation-adapter.js";
import type { PaymentOutcomeRecord } from "../../payments/payment-outcome.store.js";
import {
  parseStripePaymentIntent,
  stripeEvidence,
  StripeProtocolError,
} from "./stripe-payment-intent.js";
import type { StripePaymentIntentClient } from "./stripe-payment-intent-client.js";

export interface StripeProviderTarget {
  readonly id: string;
  readonly accountId: string;
  readonly domain: string;
  readonly active: boolean;
}

export interface StripeProviderTargetRegistry {
  getById(
    organizationId: string,
    providerTargetId: string,
  ): Promise<StripeProviderTarget | undefined>;
}

export interface StripeReconciliationAdapterDependencies {
  readonly targets: StripeProviderTargetRegistry;
  readonly client: StripePaymentIntentClient;
  readonly credentials: EconomicProviderCredentialProvider;
}

/**
 * Provider-specific interpretation of Stripe PaymentIntent state.
 *
 * `PaymentOutcomeRecord` still carries the current merchant/checkout-shaped field
 * names. For this proof, `merchantId` is the internal Stripe target registry key
 * and `checkoutSessionId` carries the PaymentIntent ID. That storage compatibility
 * is intentionally not promoted into provider-neutral semantics.
 */
export class StripeReconciliationAdapter implements EconomicReconciliationAdapter {
  public readonly protocol = "STRIPE" as const;

  public constructor(private readonly deps: StripeReconciliationAdapterDependencies) {}

  public async reconcile(
    outcome: PaymentOutcomeRecord,
  ): Promise<EconomicReconciliationObservation> {
    const target = await this.deps.targets.getById(
      outcome.organizationId,
      outcome.merchantId,
    );
    if (!target || !target.active) {
      return deferred("STRIPE_TARGET_UNAVAILABLE");
    }
    if (canonicalDomain(target.domain) !== canonicalDomain(outcome.merchantDomain)) {
      return deferred("STRIPE_TARGET_DOMAIN_MISMATCH");
    }

    const authorization = await this.deps.credentials.getAuthorization(
      outcome.organizationId,
      target.id,
    );
    if (!authorization || !/^\S+\s+\S+$/.test(authorization.trim())) {
      return deferred("STRIPE_CREDENTIAL_UNAVAILABLE");
    }

    let upstream;
    try {
      upstream = await this.deps.client.retrievePaymentIntent({
        authorization,
        accountId: target.accountId,
        paymentIntentId: outcome.checkoutSessionId,
      });
    } catch {
      return deferred("STRIPE_RECONCILIATION_TRANSPORT_FAILURE");
    }

    if (upstream.status < 200 || upstream.status >= 300) {
      return deferred(`STRIPE_RECONCILIATION_HTTP_${upstream.status}`, upstream.status);
    }

    let paymentIntent;
    try {
      paymentIntent = parseStripePaymentIntent(upstream.body);
    } catch (error) {
      if (error instanceof StripeProtocolError) {
        return deferred("STRIPE_RECONCILIATION_INVALID_PAYMENT_INTENT", upstream.status);
      }
      throw error;
    }

    if (paymentIntent.id !== outcome.checkoutSessionId) {
      return deferred("STRIPE_PAYMENT_INTENT_ID_MISMATCH", upstream.status);
    }
    if (
      paymentIntent.amount !== outcome.amountMinor ||
      paymentIntent.currency !== outcome.currency.toUpperCase()
    ) {
      return deferred("STRIPE_PAYMENT_INTENT_ECONOMICS_MISMATCH", upstream.status);
    }

    if (paymentIntent.status === "succeeded") {
      return {
        disposition: "SUCCEEDED",
        evidence: stripeEvidence(upstream, paymentIntent),
      };
    }
    if (paymentIntent.status === "canceled") {
      return {
        disposition: "FAILED_DEFINITIVE",
        evidence: stripeEvidence(upstream, paymentIntent),
      };
    }

    return deferred("STRIPE_PAYMENT_INTENT_NOT_TERMINAL", upstream.status);
  }
}

function deferred(
  errorCode: string,
  providerStatus?: number,
): EconomicReconciliationObservation {
  return {
    disposition: "DEFERRED",
    errorCode,
    ...(providerStatus !== undefined ? { providerStatus } : {}),
  };
}

function canonicalDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}
