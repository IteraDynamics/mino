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
  readonly approvalMode: "AUTO_APPROVE" | "DUAL_SIGNATURE_SLACK" | "HARD_BLOCK";
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

export interface AdminInventoryRepository {
  listAgents(input: AdminInventoryPageRequest): Promise<AdminInventoryPage<AdminAgentInventoryItem>>;
  listPolicies(input: AdminInventoryPageRequest): Promise<AdminInventoryPage<AdminPolicyInventoryItem>>;
  listMerchants(input: AdminInventoryPageRequest): Promise<AdminInventoryPage<AdminMerchantInventoryItem>>;
}
