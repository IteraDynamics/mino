import type { PrismaClient } from "../../generated/prisma/client.js";
import {
  ApprovalMode,
  type AgentSpendMandate,
} from "../../domain/mandates/mandate.types.js";
import type { AgentVerificationKeyResolver } from "../../modules/agents/agent-request-verifier.js";
import type { MandateRepository } from "../../modules/proxy/checkout-proxy.service.js";
import type {
  MerchantEndpoint,
  MerchantRegistry,
} from "../../modules/proxy/merchant-client.js";

export interface PolicySnapshot {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly version: number;
  readonly active: boolean;
  readonly baseCurrency: string;
  readonly maxBudgetMinor: bigint;
  readonly rollingDailyLimitMinor: bigint;
  readonly approvedMerchantDomains: readonly string[];
  readonly approvedVendorIds: readonly string[];
  readonly restrictedCategories: readonly string[];
  readonly approvalMode: ApprovalMode;
}

export class PrismaMandateRepository implements MandateRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async getById(mandateId: string): Promise<AgentSpendMandate | undefined> {
    const row = await this.prisma.agentMandate.findUnique({
      where: { id: mandateId },
      include: {
        user: { select: { status: true } },
        agent: { select: { status: true } },
        policy: { select: { active: true, version: true } },
      },
    });

    if (
      !row ||
      row.status !== "ACTIVE" ||
      row.user.status !== "ACTIVE" ||
      row.agent.status !== "ACTIVE" ||
      !row.policy.active ||
      row.policy.version !== row.policyVersion
    ) {
      return undefined;
    }

    return {
      id: row.id,
      organizationId: row.organizationId,
      userId: row.userId,
      agentId: row.agentId,
      policyId: row.policyId,
      policyVersion: row.policyVersion,
      currency: row.currency,
      maxBudgetPerTransactionMinor: row.maxBudgetMinor,
      rollingDailyLimitMinor: row.rollingDailyLimitMinor,
      approvedMerchantDomains: row.approvedMerchantDomains,
      approvedVendorIds: row.approvedVendorIds,
      restrictedCategories: row.restrictedCategories,
      approvalMode: mapApprovalMode(row.approvalMode),
      velocity: {
        maxTransactionsPerMinute: row.maxTransactionsPerMinute,
        crossMerchantWindowSeconds: row.crossMerchantWindowSecs,
        maxDistinctMerchantsInWindow: row.maxDistinctMerchants,
      },
      issuedAt: row.issuedAt,
      expiresAt: row.expiresAt,
      ...(row.revokedAt ? { revokedAt: row.revokedAt } : {}),
      signingKeyId: row.signingKeyId,
      tokenJtiHash: row.tokenJtiHash,
    };
  }
}

export class PrismaMerchantRegistry implements MerchantRegistry {
  public constructor(private readonly prisma: PrismaClient) {}

  public async getById(
    organizationId: string,
    merchantId: string,
  ): Promise<MerchantEndpoint | undefined> {
    const row = await this.prisma.merchantEndpoint.findFirst({
      where: {
        organizationId,
        externalMerchantId: merchantId,
      },
    });
    if (!row) {
      return undefined;
    }

    return {
      id: row.externalMerchantId,
      domain: row.domain,
      ...(row.vendorId ? { vendorId: row.vendorId } : {}),
      baseUrl: row.baseUrl,
      active: row.active,
    };
  }
}

export class PrismaAgentVerificationKeyResolver implements AgentVerificationKeyResolver {
  public constructor(private readonly prisma: PrismaClient) {}

  public async resolveAgentPublicKey(
    agentId: string,
    keyId: string,
  ): Promise<string | undefined> {
    const agent = await this.prisma.agentIdentity.findFirst({
      where: {
        id: agentId,
        keyId,
        status: "ACTIVE",
        publicKey: { not: null },
      },
      select: { publicKey: true },
    });
    return agent?.publicKey ?? undefined;
  }
}

export class PrismaPolicyRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async getById(policyId: string): Promise<PolicySnapshot | undefined> {
    const row = await this.prisma.policy.findUnique({ where: { id: policyId } });
    if (!row) {
      return undefined;
    }
    return {
      id: row.id,
      organizationId: row.organizationId,
      name: row.name,
      version: row.version,
      active: row.active,
      baseCurrency: row.baseCurrency,
      maxBudgetMinor: row.maxBudgetMinor,
      rollingDailyLimitMinor: row.rollingDailyLimitMinor,
      approvedMerchantDomains: row.approvedMerchantDomains,
      approvedVendorIds: row.approvedVendorIds,
      restrictedCategories: row.restrictedCategories,
      approvalMode: mapApprovalMode(row.approvalMode),
    };
  }
}

function mapApprovalMode(value: string): ApprovalMode {
  switch (value) {
    case "AUTO_APPROVE":
      return ApprovalMode.AUTO_APPROVE;
    case "DUAL_SIGNATURE_SLACK":
      return ApprovalMode.DUAL_SIGNATURE_SLACK;
    case "HARD_BLOCK":
      return ApprovalMode.HARD_BLOCK;
    default:
      throw new Error(`Unsupported persisted approval mode: ${value}`);
  }
}
