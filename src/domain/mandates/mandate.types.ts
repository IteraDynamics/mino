import type { CurrencyCode } from "../money.js";

export type UUID = string;

export enum ApprovalMode {
  AUTO_APPROVE = "AUTO_APPROVE",
  DUAL_SIGNATURE_SLACK = "DUAL_SIGNATURE_SLACK",
  HARD_BLOCK = "HARD_BLOCK",
}

export interface VelocityPolicy {
  readonly maxTransactionsPerMinute: number;
  readonly crossMerchantWindowSeconds: number;
  readonly maxDistinctMerchantsInWindow: number;
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

  readonly approvedMerchantDomains: readonly string[];
  readonly approvedVendorIds: readonly string[];
  readonly restrictedCategories: readonly string[];

  /**
   * Escalation behavior for otherwise-approvable spend-limit breaches.
   * Security/identity/category/velocity failures always fail closed.
   */
  readonly approvalMode: ApprovalMode;
  readonly velocity: VelocityPolicy;

  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt?: Date;
  readonly signingKeyId: string;
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
