import { redactSensitivePayload } from "../audit/audit-sink.js";
import type {
  EconomicProviderCredentialProvider,
  EconomicProviderEvidence,
  EconomicReconciliationAdapter,
  EconomicReconciliationObservation,
} from "../execution/economic-reconciliation-adapter.js";
import type { PaymentOutcomeRecord } from "../payments/payment-outcome.store.js";
import {
  ACPProtocolError,
  ACP_STABLE_VERSION,
  parseCheckoutSession,
  type ACPCheckoutSession,
} from "./acp-adapter.js";
import type {
  ACPMerchantClient,
  MerchantRegistry,
  MerchantResponse,
} from "./merchant-client.js";

export interface ACPReconciliationAdapterDependencies {
  readonly merchants: MerchantRegistry;
  readonly merchantClient: ACPMerchantClient;
  readonly credentials: EconomicProviderCredentialProvider;
  readonly generateRequestId: () => string;
}

/** ACP provider adapter for durable outcome reconciliation. */
export class ACPReconciliationAdapter implements EconomicReconciliationAdapter {
  public readonly protocol = "ACP" as const;

  public constructor(private readonly deps: ACPReconciliationAdapterDependencies) {}

  public async reconcile(
    outcome: PaymentOutcomeRecord,
  ): Promise<EconomicReconciliationObservation> {
    const merchant = await this.deps.merchants.getById(
      outcome.organizationId,
      outcome.merchantId,
    );
    if (!merchant || !merchant.active) {
      return deferred("MERCHANT_ENDPOINT_UNAVAILABLE");
    }
    if (canonicalDomain(merchant.domain) !== canonicalDomain(outcome.merchantDomain)) {
      return deferred("MERCHANT_REGISTRY_MISMATCH");
    }

    const authorization = await this.deps.credentials.getAuthorization(
      outcome.organizationId,
      outcome.merchantId,
    );
    if (!authorization || !/^Bearer\s+\S+$/i.test(authorization)) {
      return deferred("MERCHANT_CREDENTIAL_UNAVAILABLE");
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
      return deferred("MERCHANT_RECONCILIATION_TRANSPORT_FAILURE");
    }

    if (upstream.status < 200 || upstream.status >= 300) {
      return deferred(
        `MERCHANT_RECONCILIATION_HTTP_${upstream.status}`,
        upstream.status,
      );
    }

    let session: ACPCheckoutSession;
    try {
      session = parseCheckoutSession(upstream.body);
    } catch (error) {
      if (error instanceof ACPProtocolError) {
        return deferred(
          "MERCHANT_RECONCILIATION_INVALID_CHECKOUT",
          upstream.status,
        );
      }
      throw error;
    }

    if (session.id !== outcome.checkoutSessionId) {
      return deferred(
        "MERCHANT_RECONCILIATION_CHECKOUT_ID_MISMATCH",
        upstream.status,
      );
    }

    const status = session.status.trim().toLowerCase();
    if (status === "completed") {
      if (!isRecord(session.order)) {
        return deferred(
          "MERCHANT_COMPLETED_SESSION_MISSING_ORDER",
          upstream.status,
        );
      }
      return {
        disposition: "SUCCEEDED",
        evidence: storedEvidence(upstream, session),
      };
    }

    if (status === "canceled" || status === "cancelled") {
      return {
        disposition: "FAILED_DEFINITIVE",
        evidence: storedEvidence(upstream, session),
      };
    }

    return deferred("MERCHANT_CHECKOUT_NOT_TERMINAL", upstream.status);
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

function storedEvidence(
  upstream: MerchantResponse,
  session: ACPCheckoutSession,
): EconomicProviderEvidence {
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
