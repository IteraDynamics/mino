import { generateKeyPairSync, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AUTHORIZATION_RECEIPT_SCHEMA_VERSION,
  type AuthorizationReceiptPayload,
} from "../../src/domain/economic/authorization-receipt.js";
import type { AuthorizationDecision } from "../../src/domain/economic/authorization-decision.js";
import {
  authorityReferenceFromMandate,
  bindEconomicIntent,
} from "../../src/domain/economic/canonical-economic-intent.js";
import { DecisionVerdict, type PolicyDecision } from "../../src/domain/evaluation/evaluation.types.js";
import { ApprovalMode, type AgentSpendMandate } from "../../src/domain/mandates/mandate.types.js";
import { sha256Base64Url } from "../../src/infrastructure/crypto/canonical-json.js";
import {
  approvalCoversDecision,
  grantApprovedDecision,
} from "../../src/modules/approvals/durable-approval.service.js";
import {
  ApprovalRequestStatus,
  type ApprovalRequestRecord,
} from "../../src/modules/approvals/approval-request.store.js";
import { AuthorizationGrantService } from "../../src/modules/authorization/authorization-grant.service.js";
import { PolicyEvaluator } from "../../src/modules/policy/policy-evaluator.js";
import {
  InvoiceExecutionAdapter,
  InvoiceReconciliationAdapter,
  normalizeInvoiceIntent,
  type InvoiceAuthoritativeState,
  type InvoicePaymentState,
  type InvoiceProviderClient,
} from "../../src/modules/providers/invoice/invoice-provider-adapter.js";
import {
  signAuthorizationReceipt,
  verifyAuthorizationReceipt,
} from "../../src/modules/receipts/authorization-receipt.service.js";

const now = new Date("2026-08-25T16:00:00.000Z");

describe("second-rail invoice falsification", () => {
  it("drives PAY_INVOICE through the same authority, intent, approval, grant, async execution, and receipt lifecycle", async () => {
    const provider = new FakeInvoiceProvider(openInvoice());
    const mandate = invoiceMandate();
    const evaluator = evaluatorWithRandomIds();
    const intent = normalizeInvoiceIntent({
      state: await provider.getInvoice("inv-8472"),
      requestId: randomUUID(),
      organizationId: mandate.organizationId,
      userId: mandate.userId,
      agentId: mandate.agentId,
      idempotencyKey: "invoice-payment-1",
    });

    expect(intent.economicValue?.amount).toEqual({ currency: "USD", minorUnits: 150_000n });
    expect(intent.cart).toBeUndefined();
    const canonical = bindEconomicIntent(intent, authorityReferenceFromMandate(mandate));
    expect(canonical.canonicalIntent.economics).toMatchObject({
      amount: { currency: "USD", minorUnits: 150_000n },
      items: [],
    });
    expect(canonical.canonicalIntent.economics.checkoutBreakdown).toBeUndefined();

    const pending = evaluator.evaluate(context(mandate, intent));
    expect(pending.verdict).toBe(DecisionVerdict.PENDING_HUMAN_APPROVAL);
    expect(pending.intentDigest).toBe(canonical.intentDigest);

    const approval = approvedRequestFor(pending, mandate);
    expect(approvalCoversDecision(approval, pending, zeroSpend())).toBe(true);

    const allowed = requireBoundDecision(grantApprovedDecision(pending));
    const grantKeys = generateKeyPairSync("ed25519");
    const grants = new AuthorizationGrantService(
      { keyId: "grant-k1", privateKey: grantKeys.privateKey },
      randomUUID,
      { issuer: "https://mino.test" },
    );
    const grant = grants.issue(intent, allowed, now);
    expect(grant.claims.intent_digest).toBe(allowed.intentDigest);
    expect(grant.claims.operation).toBe("PAY_INVOICE");

    const execution = await new InvoiceExecutionAdapter(provider).execute({
      intent,
      decision: allowed,
      grant,
      context: { invoiceId: "inv-8472" },
      now,
    });
    expect(execution.status).toBe("PROCESSING");
    expect(provider.submitCalls).toBe(1);

    const reconciliation = new InvoiceReconciliationAdapter(provider);
    expect(await reconciliation.reconcile(execution.paymentId)).toMatchObject({
      disposition: "DEFERRED",
      errorCode: "INVOICE_PAYMENT_PROCESSING",
    });

    provider.setPaymentStatus(execution.paymentId, "SETTLED");
    expect(await reconciliation.reconcile(execution.paymentId)).toMatchObject({
      disposition: "SUCCEEDED",
    });

    const auditKeys = generateKeyPairSync("ed25519");
    const receiptPayload: AuthorizationReceiptPayload = {
      schemaVersion: AUTHORIZATION_RECEIPT_SCHEMA_VERSION,
      receiptId: randomUUID(),
      intentDigest: allowed.intentDigest,
      authority: {
        organizationId: mandate.organizationId,
        userId: mandate.userId,
        agentId: mandate.agentId,
        mandateId: mandate.id,
        policyId: mandate.policyId,
        policyVersion: mandate.policyVersion,
      },
      decision: {
        decisionId: allowed.decisionId,
        verdict: "ALLOW",
        reasonCodes: [...allowed.reasons],
        evaluatedAt: allowed.evaluatedAt.toISOString(),
      },
      approval: {
        approvalRequestId: approval.id,
        approvedAt: approval.resolvedAt?.toISOString(),
        approvers: [{ approverId: "owner-1", approvedAt: approval.resolvedAt!.toISOString() }],
      },
      execution: {
        paymentOutcomeId: randomUUID(),
        protocol: "CUSTOM",
        operation: "PAY_INVOICE",
        status: "SUCCEEDED",
        providerReference: execution.paymentId,
        amountMinor: allowed.approvedAmount!.minorUnits.toString(10),
        currency: allowed.approvedAmount!.currency,
        upstreamStatus: 200,
        resolvedAt: new Date(now.getTime() + 60_000).toISOString(),
      },
      evidence: {
        executionRequestDigest: sha256Base64Url("invoice-payment-1"),
        audit: {
          chainSequence: "1",
          eventDigest: sha256Base64Url("invoice-authorization-event"),
          chainDigest: sha256Base64Url("invoice-authorization-chain"),
        },
      },
      issuedAt: new Date(now.getTime() + 60_001).toISOString(),
    };
    const receipt = signAuthorizationReceipt(receiptPayload, {
      keyId: "audit-k1",
      privateKey: auditKeys.privateKey,
    });

    expect(receipt.payload.intentDigest).toBe(grant.claims.intent_digest);
    expect(receipt.payload.execution.operation).toBe("PAY_INVOICE");
    expect(
      await verifyAuthorizationReceipt(receipt, {
        async resolvePublicKey(keyId) {
          return keyId === "audit-k1" ? auditKeys.publicKey : undefined;
        },
      }),
    ).toBe(true);
  });

  it("makes an owner approval and grant stale when authoritative invoice state changes before execution", async () => {
    const provider = new FakeInvoiceProvider(openInvoice());
    const mandate = invoiceMandate();
    const evaluator = evaluatorWithRandomIds();
    const originalIntent = normalizeInvoiceIntent({
      state: await provider.getInvoice("inv-8472"),
      requestId: randomUUID(),
      organizationId: mandate.organizationId,
      userId: mandate.userId,
      agentId: mandate.agentId,
      idempotencyKey: "invoice-payment-stale",
    });
    const originalPending = evaluator.evaluate(context(mandate, originalIntent));
    const approval = approvedRequestFor(originalPending, mandate);
    const originalAllowed = requireBoundDecision(grantApprovedDecision(originalPending));

    const grantKeys = generateKeyPairSync("ed25519");
    const grant = new AuthorizationGrantService(
      { keyId: "grant-k1", privateKey: grantKeys.privateKey },
      randomUUID,
      { issuer: "https://mino.test" },
    ).issue(originalIntent, originalAllowed, now);

    provider.invoice = {
      ...provider.invoice,
      amountDueMinor: 160_000n,
      version: "v2",
    };

    const changedIntent = normalizeInvoiceIntent({
      state: await provider.getInvoice("inv-8472"),
      requestId: randomUUID(),
      organizationId: mandate.organizationId,
      userId: mandate.userId,
      agentId: mandate.agentId,
      idempotencyKey: "invoice-payment-stale",
    });
    const changedPending = evaluator.evaluate(context(mandate, changedIntent));

    expect(changedPending.intentDigest).not.toBe(originalPending.intentDigest);
    expect(approvalCoversDecision(approval, changedPending, zeroSpend())).toBe(false);

    await expect(
      new InvoiceExecutionAdapter(provider).execute({
        intent: originalIntent,
        decision: originalAllowed,
        grant,
        context: { invoiceId: "inv-8472" },
        now,
      }),
    ).rejects.toThrow("Authoritative invoice state changed after authorization");
    expect(provider.submitCalls).toBe(0);
  });

  it("blocks an unapproved payee without provider-specific policy logic", () => {
    const mandate = invoiceMandate();
    const intent = normalizeInvoiceIntent({
      state: { ...openInvoice(), payeeId: "payee-unapproved" },
      requestId: randomUUID(),
      organizationId: mandate.organizationId,
      userId: mandate.userId,
      agentId: mandate.agentId,
      idempotencyKey: "invoice-payment-unapproved",
    });

    const decision = evaluatorWithRandomIds().evaluate(context(mandate, intent));
    expect(decision.verdict).toBe(DecisionVerdict.BLOCK);
    expect(decision.reasons).toContain("COUNTERPARTY_NOT_APPROVED");
  });
});

function invoiceMandate(): AgentSpendMandate {
  return {
    id: randomUUID(),
    organizationId: randomUUID(),
    userId: randomUUID(),
    agentId: randomUUID(),
    policyId: randomUUID(),
    policyVersion: 1,
    currency: "USD",
    maxBudgetPerTransactionMinor: 100_000n,
    rollingDailyLimitMinor: 1_000_000n,
    approvedMerchantDomains: [],
    approvedVendorIds: [],
    approvedCounterparties: [
      {
        kind: "PAYEE",
        identifier: {
          scheme: "PROVIDER_REFERENCE",
          namespace: "invoice-payee",
          value: "payee-123",
        },
      },
    ],
    restrictedCategories: [],
    approvalMode: ApprovalMode.OWNER_APPROVAL,
    velocity: {
      maxTransactionsPerMinute: 10,
      crossMerchantWindowSeconds: 60,
      maxDistinctMerchantsInWindow: 5,
      maxDistinctCounterpartiesInWindow: 5,
    },
    issuedAt: new Date(now.getTime() - 60_000),
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    signingKeyId: "mandate-k1",
  };
}

function context(mandate: AgentSpendMandate, checkout: ReturnType<typeof normalizeInvoiceIntent>) {
  return {
    now,
    mandate,
    checkout,
    spend: zeroSpend(),
    velocity: {
      transactionsLastMinute: 0,
      distinctMerchantsInWindow: 0,
      attemptedAmountLastMinute: { currency: "USD", minorUnits: 0n },
      merchantDomainsInWindow: [],
      distinctCounterpartiesInWindow: 0,
      counterpartyKeysInWindow: [],
    },
  };
}

function zeroSpend() {
  return {
    committedDailySpend: { currency: "USD", minorUnits: 0n },
    reservedDailySpend: { currency: "USD", minorUnits: 0n },
  };
}

function evaluatorWithRandomIds() {
  let micros = 0;
  return new PolicyEvaluator({
    generateId: randomUUID,
    monotonicMicros: () => micros++,
  });
}

function requireBoundDecision(decision: PolicyDecision): AuthorizationDecision {
  if (!decision.intentDigest) throw new Error("Expected intent-bound decision");
  return decision as AuthorizationDecision;
}

function approvedRequestFor(
  decision: PolicyDecision,
  mandate: AgentSpendMandate,
): ApprovalRequestRecord {
  if (!decision.intentDigest || !decision.policyAmount || !decision.approval) {
    throw new Error("Expected pending intent-bound approval decision");
  }
  const resolvedAt = new Date(now.getTime() + 1_000);
  return {
    id: randomUUID(),
    organizationId: mandate.organizationId,
    userId: mandate.userId,
    agentId: mandate.agentId,
    mandateId: mandate.id,
    decisionId: decision.decisionId,
    requestId: decision.requestId,
    idempotencyKey: "invoice-approval",
    requestDigest: sha256Base64Url("invoice-approval-request"),
    intentDigest: decision.intentDigest,
    policyVersion: mandate.policyVersion,
    // These legacy presentation fields are intentionally not consulted by approvalCoversDecision.
    merchantId: "compatibility-unused",
    merchantDomain: "compatibility-unused",
    requestedPayload: {},
    reasonCodes: decision.reasons,
    amountMinor: decision.policyAmount.minorUnits,
    currency: decision.policyAmount.currency,
    status: ApprovalRequestStatus.APPROVED,
    requiredSignatures: 1,
    approvalData: { intentDigest: decision.intentDigest },
    createdAt: now,
    expiresAt: decision.approval.expiresAt,
    resolvedAt,
    votes: [],
  };
}

function openInvoice(): InvoiceAuthoritativeState {
  return {
    invoiceId: "inv-8472",
    payeeId: "payee-123",
    amountDueMinor: 150_000n,
    currency: "USD",
    dueDate: "2026-09-15T00:00:00.000Z",
    status: "OPEN",
    version: "v1",
  };
}

class FakeInvoiceProvider implements InvoiceProviderClient {
  public submitCalls = 0;
  public invoice: InvoiceAuthoritativeState;
  private readonly payments = new Map<string, InvoicePaymentState>();

  public constructor(invoice: InvoiceAuthoritativeState) {
    this.invoice = invoice;
  }

  public async getInvoice(invoiceId: string): Promise<InvoiceAuthoritativeState> {
    if (invoiceId !== this.invoice.invoiceId) throw new Error("invoice not found");
    return { ...this.invoice };
  }

  public async submitPayment(input: {
    readonly invoiceId: string;
    readonly amountMinor: bigint;
    readonly currency: string;
    readonly idempotencyKey: string;
  }): Promise<InvoicePaymentState> {
    this.submitCalls += 1;
    const payment: InvoicePaymentState = {
      paymentId: `payment-${this.submitCalls}`,
      invoiceId: input.invoiceId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      status: "PROCESSING",
    };
    this.payments.set(payment.paymentId, payment);
    return payment;
  }

  public async getPayment(paymentId: string): Promise<InvoicePaymentState> {
    const payment = this.payments.get(paymentId);
    if (!payment) throw new Error("payment not found");
    return { ...payment };
  }

  public setPaymentStatus(paymentId: string, status: InvoicePaymentState["status"]): void {
    const payment = this.payments.get(paymentId);
    if (!payment) throw new Error("payment not found");
    this.payments.set(paymentId, { ...payment, status });
  }
}
