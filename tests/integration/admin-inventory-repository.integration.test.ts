import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../../src/generated/prisma/client.js";
import { PrismaAdminInventoryRepository } from "../../src/infrastructure/prisma/admin-inventory.repository.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";

const organizationId = "10000000-0000-4000-8000-000000000001";
const otherOrganizationId = "10000000-0000-4000-8000-000000000002";

integration("Prisma admin inventory repository", () => {
  let prisma: PrismaClient;
  let repository: PrismaAdminInventoryRepository;

  beforeAll(async () => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) });
    await prisma.$connect();
    repository = new PrismaAdminInventoryRepository(prisma);

    await prisma.organization.createMany({
      data: [
        { id: organizationId, name: "Inventory org" },
        { id: otherOrganizationId, name: "Other inventory org" },
      ],
    });

    await prisma.agentIdentity.createMany({
      data: [
        {
          id: "20000000-0000-4000-8000-000000000001",
          organizationId,
          externalAgentId: "agent-a",
          displayName: "Agent A",
          keyId: "agent-key-a",
          publicKey: "SECRET-PUBLIC-KEY-MATERIAL",
        },
        {
          id: "20000000-0000-4000-8000-000000000002",
          organizationId,
          externalAgentId: "agent-b",
          status: "SUSPENDED",
        },
        {
          id: "20000000-0000-4000-8000-000000000003",
          organizationId,
          externalAgentId: "agent-c",
        },
        {
          id: "20000000-0000-4000-8000-000000000004",
          organizationId: otherOrganizationId,
          externalAgentId: "other-agent",
        },
      ],
    });

    await prisma.policy.createMany({
      data: [
        {
          id: "30000000-0000-4000-8000-000000000001",
          organizationId,
          name: "Travel",
          version: 1,
          maxBudgetMinor: 9007199254740993123n,
          rollingDailyLimitMinor: 9007199254740993999n,
          approvedMerchantDomains: ["airline.example"],
          approvedVendorIds: ["vendor-air"],
          restrictedCategories: ["gift-card"],
          approvalMode: "DUAL_SIGNATURE_SLACK",
        },
        {
          id: "30000000-0000-4000-8000-000000000002",
          organizationId: otherOrganizationId,
          name: "Other policy",
          version: 1,
          maxBudgetMinor: 1000n,
          rollingDailyLimitMinor: 2000n,
          approvedMerchantDomains: [],
          approvedVendorIds: [],
          restrictedCategories: [],
          approvalMode: "HARD_BLOCK",
        },
      ],
    });

    await prisma.merchantEndpoint.createMany({
      data: [
        {
          id: "40000000-0000-4000-8000-000000000001",
          organizationId,
          externalMerchantId: "merchant-a",
          domain: "merchant-a.example",
          vendorId: "vendor-a",
          baseUrl: "https://private-upstream.internal.example/acp",
        },
        {
          id: "40000000-0000-4000-8000-000000000002",
          organizationId: otherOrganizationId,
          externalMerchantId: "other-merchant",
          domain: "other.example",
          baseUrl: "https://other-private.internal.example/acp",
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.organization.deleteMany({
      where: { id: { in: [organizationId, otherOrganizationId] } },
    });
    await prisma.$disconnect();
  });

  it("paginates agents deterministically inside one organization without exposing public keys", async () => {
    const first = await repository.listAgents({ organizationId, limit: 2 });
    expect(first.items.map((item) => item.externalAgentId)).toEqual(["agent-a", "agent-b"]);
    expect(first.nextCursor).toBe("20000000-0000-4000-8000-000000000002");
    expect(JSON.stringify(first)).not.toContain("SECRET-PUBLIC-KEY-MATERIAL");
    expect(JSON.stringify(first)).not.toContain("publicKey");

    const second = await repository.listAgents({
      organizationId,
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items.map((item) => item.externalAgentId)).toEqual(["agent-c"]);
    expect(second.nextCursor).toBeUndefined();
    expect(second.items.some((item) => item.externalAgentId === "other-agent")).toBe(false);
  });

  it("serializes policy minor-unit amounts exactly as decimal strings and excludes other tenants", async () => {
    const page = await repository.listPolicies({ organizationId, limit: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      name: "Travel",
      maxBudgetMinor: "9007199254740993123",
      rollingDailyLimitMinor: "9007199254740993999",
      approvalMode: "DUAL_SIGNATURE_SLACK",
    });
    expect(page.items.some((item) => item.name === "Other policy")).toBe(false);
  });

  it("returns merchant identity/scope without exposing internal upstream base URLs", async () => {
    const page = await repository.listMerchants({ organizationId, limit: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      externalMerchantId: "merchant-a",
      domain: "merchant-a.example",
      vendorId: "vendor-a",
      active: true,
    });
    expect(JSON.stringify(page)).not.toContain("private-upstream");
    expect(JSON.stringify(page)).not.toContain("baseUrl");
    expect(page.items.some((item) => item.externalMerchantId === "other-merchant")).toBe(false);
  });
});
