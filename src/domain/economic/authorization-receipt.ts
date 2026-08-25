import type { EconomicOperation, EconomicProviderProtocol } from "./economic-intent.types.js";

export const AUTHORIZATION_RECEIPT_SCHEMA_VERSION = 1 as const;

export type AuthorizationReceiptExecutionStatus = "SUCCEEDED" | "FAILED_DEFINITIVE";

export interface AuthorizationReceiptApprovalEvidence {
  readonly approvalRequestId: string;
  readonly approvedAt?: string;
  readonly approvers: readonly {
    readonly approverId: string;
    readonly approvedAt: string;
  }[];
}

export interface AuthorizationReceiptAuditEvidence {
  readonly chainSequence: string;
  readonly eventDigest: string;
  readonly chainDigest: string;
}

/**
 * Durable proof of the exact delegated authority and canonical economic intent
 * that preceded one terminal execution outcome.
 *
 * The receipt intentionally carries no payment credential, provider secret, raw
 * request body, or arbitrary agent prose. `intentDigest` is the canonical join
 * key back to the immutable pre-execution EconomicIntent.
 */
export interface AuthorizationReceiptPayload {
  readonly schemaVersion: typeof AUTHORIZATION_RECEIPT_SCHEMA_VERSION;
  readonly receiptId: string;
  readonly intentDigest: string;
  readonly authority: {
    readonly organizationId: string;
    readonly userId: string;
    readonly agentId: string;
    readonly mandateId: string;
    readonly policyId: string;
    readonly policyVersion: number;
  };
  readonly decision: {
    readonly decisionId: string;
    readonly verdict: "ALLOW";
    readonly reasonCodes: readonly string[];
    readonly evaluatedAt: string;
  };
  readonly approval?: AuthorizationReceiptApprovalEvidence;
  readonly execution: {
    readonly paymentOutcomeId: string;
    readonly protocol: EconomicProviderProtocol;
    readonly operation: EconomicOperation;
    readonly status: AuthorizationReceiptExecutionStatus;
    readonly providerReference: string;
    readonly amountMinor: string;
    readonly currency: string;
    readonly upstreamStatus: number;
    readonly resolvedAt: string;
  };
  readonly evidence: {
    /** Digest used by payment idempotency to bind the exact execution attempt. */
    readonly executionRequestDigest: string;
    /** Tamper-evident audit-chain event that captured the pre-execution authorization. */
    readonly audit: AuthorizationReceiptAuditEvidence;
  };
  readonly issuedAt: string;
}

export interface SignedAuthorizationReceipt {
  readonly payload: AuthorizationReceiptPayload;
  readonly receiptDigest: string;
  readonly signingKeyId: string;
  readonly signature: string;
}
