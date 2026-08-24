export interface AdminInventoryPageRequest {
  readonly organizationId: string;
  readonly limit: number;
  readonly cursor?: string;
}

export interface AdminInventoryPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export interface AdminAgentInventoryItem {
  readonly id: string;
  readonly externalAgentId: string;
  readonly displayName?: string;
  readonly status: "ACTIVE" | "SUSPENDED" | "REVOKED";
  readonly keyId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AdminPolicyInventoryItem {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly active: boolean;
  readonly baseCurrency: string;
  readonly maxBudgetMinor: string;
  readonly rollingDailyLimitMinor: string;
  readonly approvedMerchantDomains: readonly string[];
  readonly approvedVendorIds: readonly string[];
  readonly restrictedCategories: readonly string[];
  readonly approvalMode:
    | "AUTO_APPROVE"
    | "OWNER_APPROVAL"
    | "DUAL_SIGNATURE_SLACK"
    | "HARD_BLOCK";
  readonly maxTransactionsPerMinute: number;
  readonly crossMerchantWindowSecs: number;
  readonly maxDistinctMerchants: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AdminMerchantInventoryItem {
  readonly id: string;
  readonly externalMerchantId: string;
  readonly domain: string;
  readonly vendorId?: string;
  readonly active: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AdminMandateInventoryItem {
  readonly id: string;
  readonly userId: string;
  readonly agentId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly currency: string;
  readonly maxBudgetMinor: string;
  readonly rollingDailyLimitMinor: string;
  readonly status: "ACTIVE" | "REVOKED" | "EXPIRED";
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revokedAt?: string;
  readonly signingKeyId: string;
}

export interface AdminInventoryRepository {
  listAgents(input: AdminInventoryPageRequest): Promise<AdminInventoryPage<AdminAgentInventoryItem>>;
  listPolicies(input: AdminInventoryPageRequest): Promise<AdminInventoryPage<AdminPolicyInventoryItem>>;
  listMerchants(input: AdminInventoryPageRequest): Promise<AdminInventoryPage<AdminMerchantInventoryItem>>;
  listMandates(input: AdminInventoryPageRequest): Promise<AdminInventoryPage<AdminMandateInventoryItem>>;
}
