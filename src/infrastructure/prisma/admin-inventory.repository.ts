import type { PrismaClient } from "../../generated/prisma/client.js";
import type {
  AdminAgentInventoryItem,
  AdminInventoryPage,
  AdminInventoryPageRequest,
  AdminInventoryRepository,
  AdminMerchantInventoryItem,
  AdminPolicyInventoryItem,
} from "../../modules/admin/admin-inventory.js";

export class PrismaAdminInventoryRepository implements AdminInventoryRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async listAgents(
    input: AdminInventoryPageRequest,
  ): Promise<AdminInventoryPage<AdminAgentInventoryItem>> {
    const rows = await this.prisma.agentIdentity.findMany({
      where: {
        organizationId: input.organizationId,
        ...(input.cursor ? { id: { gt: input.cursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: input.limit + 1,
      select: {
        id: true,
        externalAgentId: true,
        displayName: true,
        status: true,
        keyId: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return page(rows, input.limit, (row) => ({
      id: row.id,
      externalAgentId: row.externalAgentId,
      ...(row.displayName ? { displayName: row.displayName } : {}),
      status: row.status,
      ...(row.keyId ? { keyId: row.keyId } : {}),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  public async listPolicies(
    input: AdminInventoryPageRequest,
  ): Promise<AdminInventoryPage<AdminPolicyInventoryItem>> {
    const rows = await this.prisma.policy.findMany({
      where: {
        organizationId: input.organizationId,
        ...(input.cursor ? { id: { gt: input.cursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: input.limit + 1,
      select: {
        id: true,
        name: true,
        version: true,
        active: true,
        baseCurrency: true,
        maxBudgetMinor: true,
        rollingDailyLimitMinor: true,
        approvedMerchantDomains: true,
        approvedVendorIds: true,
        restrictedCategories: true,
        approvalMode: true,
        maxTransactionsPerMinute: true,
        crossMerchantWindowSecs: true,
        maxDistinctMerchants: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return page(rows, input.limit, (row) => ({
      id: row.id,
      name: row.name,
      version: row.version,
      active: row.active,
      baseCurrency: row.baseCurrency,
      maxBudgetMinor: row.maxBudgetMinor.toString(),
      rollingDailyLimitMinor: row.rollingDailyLimitMinor.toString(),
      approvedMerchantDomains: row.approvedMerchantDomains,
      approvedVendorIds: row.approvedVendorIds,
      restrictedCategories: row.restrictedCategories,
      approvalMode: row.approvalMode,
      maxTransactionsPerMinute: row.maxTransactionsPerMinute,
      crossMerchantWindowSecs: row.crossMerchantWindowSecs,
      maxDistinctMerchants: row.maxDistinctMerchants,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  public async listMerchants(
    input: AdminInventoryPageRequest,
  ): Promise<AdminInventoryPage<AdminMerchantInventoryItem>> {
    const rows = await this.prisma.merchantEndpoint.findMany({
      where: {
        organizationId: input.organizationId,
        ...(input.cursor ? { id: { gt: input.cursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: input.limit + 1,
      select: {
        id: true,
        externalMerchantId: true,
        domain: true,
        vendorId: true,
        active: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return page(rows, input.limit, (row) => ({
      id: row.id,
      externalMerchantId: row.externalMerchantId,
      domain: row.domain,
      ...(row.vendorId ? { vendorId: row.vendorId } : {}),
      active: row.active,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }
}

function page<Row extends { id: string }, Item>(
  rows: readonly Row[],
  limit: number,
  map: (row: Row) => Item,
): AdminInventoryPage<Item> {
  const hasMore = rows.length > limit;
  const visibleRows = hasMore ? rows.slice(0, limit) : rows;
  const items = visibleRows.map(map);
  const last = visibleRows.at(-1);
  return {
    items,
    ...(hasMore && last ? { nextCursor: last.id } : {}),
  };
}
