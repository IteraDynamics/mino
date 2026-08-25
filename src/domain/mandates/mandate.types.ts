import type { EconomicCounterpartySelector } from "../economic/counterparty-identity.js";
import type { CurrencyCode } from "../money.js";

export type UUID = string;

export enum ApprovalMode {
  AUTO_APPROVE = "AUTO_APPROVE",
  OWNER_APPROVAL = "OWNER_APPROVAL",
  DUAL_SIGNATURE_SLACK = "DUAL_SIGNATURE_SLACK",
  HARD_BLOCK = "HARD_BLOCK",
}

export interface VelocityPolicy {
  readonly maxTransactionsPerMinute: number;
  readonly crossMerchantWindowSeconds: number;
  readonly maxDistinctMerchantsInWindow: number;
  /** New rails may express the same control without merchant terminology. */
  readonly maxDistinctCounterpartiesInWindow?: number;
}

export interface AgentSpendMandate {
  readonly id: UUID;
  readonly organizationId: UUID;
  readonly userId: UUID;
  readonly agentId: UUID;
  readonly policyId: UUID;
  readonly policyVersion: number;

  readonly currency: CurrencyCode;
  readonly maxBudgetPerTransactionMinor: bigint;
  readonly rollingDailyLimitMinor: bigint;

  /** Legacy checkout selectors retained for existing ACP policies. */
  readonly approvedMerchantDomains: readonly string[];
  readonly approvedVendorIds: readonly string[];
  /** Provider-neutral selectors. When present, Core evaluates these instead of merchant projections. */
  readonly approvedCounterparties?: readonly EconomicCounterpartySelector[];
  readonly restrictedCategories: readonly string[];

  /**
   * Escalation behavior for otherwise-approvable spend-limit breaches.
   * OWNER_APPROVAL is the single-principal Personal path. Enterprise dual-signature
   * approval remains distinct. Security/identity/category/velocity failures always
   * fail closed regardless of approval mode.
   */
  readonly approvalMode: ApprovalMode;
  readonly velocity: VelocityPolicy;

  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt?: Date;
  readonly signingKeyId: string;
  /** SHA-256 hex digest of the issued token JTI. Raw bearer tokens are never persisted. */
  readonly tokenJtiHash?: string;
}

export interface MandateTokenClaims {
  readonly iss: string;
  readonly sub: string;
  readonly aud: "mino";
  readonly jti: string;
  readonly organizationId: UUID;
  readonly userId: UUID;
  readonly agentId: UUID;
  readonly mandateId: UUID;
  readonly policyVersion: number;
  readonly iat: number;
  readonly nbf: number;
  readonly exp: number;
}
