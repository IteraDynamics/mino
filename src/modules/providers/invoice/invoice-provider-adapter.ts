import {
  authorityReferenceFromMandate,
  bindEconomicIntent,
  type EconomicAuthorityReference,
} from "../../../domain/economic/canonical-economic-intent.js";
import type { AuthorizationDecision } from "../../../domain/economic/authorization-decision.js";
import type { SignedAuthorizationGrant } from "../../../domain/economic/authorization-grant.types.js";
import {
  economicAmount,
  type EconomicIntent,
} from "../../../domain/economic/economic-intent.types.js";
import { DecisionVerdict } from "../../../domain/evaluation/evaluation.types.js";
import { canonicalJson, sha256Base64Url } from "../../../infrastructure/crypto/canonical-json.js";
import type {
  EconomicExecutionAdapter,
  EconomicExecutionInput,
} from "../../execution/execution-adapter.js";
import type { EconomicReconciliationObservation } from "../../execution/economic-reconciliation-adapter.js";

export type InvoiceAuthoritativeStatus = "OPEN" | "VOID" | "PAID";
export type InvoicePaymentStatus = "PROCESSING" | "SETTLED" | "FAILED";

export interface InvoiceAuthoritativeState {
  readonly invoiceId: string;
  readonly payeeId: string;
  readonly amountDueMinor: bigint;
  readonly currency: string;
  readonly dueDate: string;
  readonly status: InvoiceAuthoritativeStatus;
  readonly version: string;
}

export interface InvoicePaymentState {
  readonly paymentId: string;
  readonly invoiceId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly status: InvoicePaymentStatus;
}

export interface InvoiceProviderClient {
  getInvoice(invoiceId: string): Promise<InvoiceAuthoritativeState>;
  submitPayment(input: {
    readonly invoiceId: string;
    readonly amountMinor: bigint;
    readonly currency: string;
    readonly idempotencyKey: string;
    readonly authorizationGrant: SignedAuthorizationGrant;
  }): Promise<InvoicePaymentState>;
  getPayment(paymentId: string): Promise<InvoicePaymentState>;
}

export interface NormalizeInvoiceIntentInput {
  readonly state: InvoiceAuthoritativeState;
  readonly requestId: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly idempotencyKey: string;
}

/**
 * Provider adapter responsibility: validate provider-native state and translate it
 * into Mino's provider-neutral economic intent. Core never interprets invoice JSON.
 */
export function normalizeInvoiceIntent(input: NormalizeInvoiceIntentInput): EconomicIntent {
  const state = input.state;
  assertInvoiceState(state);
  if (state.status !== "OPEN") {
    throw new Error("Only an open invoice can produce a PAY_INVOICE intent");
  }

  const currency = state.currency.trim().toUpperCase();
  const authoritativeProjection = {
    invoiceId: state.invoiceId.trim(),
    payeeId: state.payeeId.trim(),
    amountDueMinor: state.amountDueMinor.toString(10),
    currency,
    dueDate: new Date(state.dueDate).toISOString(),
    status: state.status,
    version: state.version.trim(),
  };

  return {
    requestId: input.requestId,
    protocol: "CUSTOM",
    operation: "PAY_INVOICE",
    organizationId: input.organizationId,
    userId: input.userId,
    agentId: input.agentId,
    counterparty: {
      kind: "PAYEE",
      identifiers: [
        {
          scheme: "PROVIDER_REFERENCE",
          namespace: "invoice-payee",
          value: state.payeeId.trim(),
        },
      ],
    },
    economicValue: {
      amount: {
        currency,
        minorUnits: state.amountDueMinor,
      },
    },
    idempotencyKey: input.idempotencyKey,
    authoritativeStateDigest: sha256Base64Url(canonicalJson(authoritativeProjection)),
    rawPayload: authoritativeProjection,
  };
}

export interface InvoiceExecutionContext {
  readonly invoiceId: string;
}

export interface InvoiceExecutionResult {
  readonly paymentId: string;
  readonly status: "PROCESSING";
}

/**
 * Materially different execution rail used to falsify Core neutrality.
 * It re-fetches authoritative invoice state immediately before execution and
 * requires that state to reproduce the exact authorized intent digest.
 */
export class InvoiceExecutionAdapter
  implements EconomicExecutionAdapter<InvoiceExecutionContext, InvoiceExecutionResult>
{
  public readonly protocol = "CUSTOM" as const;

  public constructor(private readonly provider: InvoiceProviderClient) {}

  public async execute(
    input: EconomicExecutionInput<InvoiceExecutionContext>,
  ): Promise<InvoiceExecutionResult> {
    if (input.intent.operation !== "PAY_INVOICE" || input.intent.protocol !== this.protocol) {
      throw new Error("Invoice adapter can only execute CUSTOM PAY_INVOICE intents");
    }
    if (input.decision.verdict !== DecisionVerdict.ALLOW || !input.decision.approvedAmount) {
      throw new Error("Invoice execution requires an allowed authorization decision");
    }

    const currentState = await this.provider.getInvoice(input.context.invoiceId);
    if (currentState.invoiceId !== input.context.invoiceId) {
      throw new Error("Invoice provider returned the wrong authoritative invoice");
    }

    const currentIntent = normalizeInvoiceIntent({
      state: currentState,
      requestId: input.intent.requestId,
      organizationId: input.intent.organizationId,
      userId: input.intent.userId,
      agentId: input.intent.agentId,
      idempotencyKey: input.intent.idempotencyKey,
    });
    const authority = authorityFromDecision(input.intent, input.decision);
    const currentBinding = bindEconomicIntent(currentIntent, authority);

    if (currentBinding.intentDigest !== input.decision.intentDigest) {
      throw new Error("Authoritative invoice state changed after authorization");
    }
    assertGrantBinding(input.intent, input.decision, input.grant);

    const amount = economicAmount(currentIntent);
    const payment = await this.provider.submitPayment({
      invoiceId: currentState.invoiceId,
      amountMinor: amount.minorUnits,
      currency: amount.currency,
      idempotencyKey: input.intent.idempotencyKey,
      authorizationGrant: input.grant,
    });

    if (
      payment.invoiceId !== currentState.invoiceId ||
      payment.amountMinor !== amount.minorUnits ||
      payment.currency.toUpperCase() !== amount.currency.toUpperCase() ||
      payment.status !== "PROCESSING"
    ) {
      throw new Error("Invoice provider returned inconsistent submission state");
    }

    return { paymentId: payment.paymentId, status: "PROCESSING" };
  }
}

/** Provider-specific interpretation of async settlement; Mino reconciliation semantics remain neutral. */
export class InvoiceReconciliationAdapter {
  public constructor(private readonly provider: Pick<InvoiceProviderClient, "getPayment">) {}

  public async reconcile(paymentId: string): Promise<EconomicReconciliationObservation> {
    const state = await this.provider.getPayment(paymentId);
    switch (state.status) {
      case "SETTLED":
        return {
          disposition: "SUCCEEDED",
          evidence: {
            status: 200,
            body: providerEvidence(state),
          },
        };
      case "FAILED":
        return {
          disposition: "FAILED_DEFINITIVE",
          evidence: {
            status: 422,
            body: providerEvidence(state),
          },
        };
      case "PROCESSING":
        return {
          disposition: "DEFERRED",
          errorCode: "INVOICE_PAYMENT_PROCESSING",
          providerStatus: 202,
        };
    }
  }
}

function authorityFromDecision(
  intent: EconomicIntent,
  decision: AuthorizationDecision,
): EconomicAuthorityReference {
  return {
    organizationId: intent.organizationId,
    userId: intent.userId,
    agentId: intent.agentId,
    mandateId: decision.mandateId,
    policyId: decision.policyId,
    policyVersion: decision.policyVersion,
  };
}

function assertGrantBinding(
  intent: EconomicIntent,
  decision: AuthorizationDecision,
  grant: SignedAuthorizationGrant,
): void {
  const amount = economicAmount(intent);
  if (
    grant.claims.intent_digest !== decision.intentDigest ||
    grant.claims.decision_id !== decision.decisionId ||
    grant.claims.mandate_id !== decision.mandateId ||
    grant.claims.policy_id !== decision.policyId ||
    grant.claims.policy_version !== decision.policyVersion ||
    grant.claims.operation !== "PAY_INVOICE" ||
    grant.claims.amount_minor !== amount.minorUnits.toString(10) ||
    grant.claims.currency.toUpperCase() !== amount.currency.toUpperCase()
  ) {
    throw new Error("Invoice execution grant does not bind to the authorized intent");
  }
}

function assertInvoiceState(state: InvoiceAuthoritativeState): void {
  if (!state.invoiceId.trim() || !state.payeeId.trim() || !state.version.trim()) {
    throw new Error("Invoice authoritative state is missing stable identity");
  }
  if (state.amountDueMinor <= 0n) {
    throw new Error("Invoice amount due must be positive");
  }
  if (!/^[A-Za-z]{3}$/.test(state.currency.trim())) {
    throw new Error("Invoice currency must be a three-letter code");
  }
  if (Number.isNaN(Date.parse(state.dueDate))) {
    throw new Error("Invoice due date is invalid");
  }
}

function providerEvidence(state: InvoicePaymentState) {
  return {
    paymentId: state.paymentId,
    invoiceId: state.invoiceId,
    amountMinor: state.amountMinor.toString(10),
    currency: state.currency.toUpperCase(),
    status: state.status,
  };
}
