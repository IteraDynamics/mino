import { randomUUID } from "node:crypto";
import { domainToASCII } from "node:url";
import { canonicalJson, sha256Base64Url } from "../../infrastructure/crypto/canonical-json.js";
import type {
  AdminAuditAppendResult,
  AdminAuditSqlClient,
  PostgresAdminChangeAuditLedger,
} from "./admin-change-audit-ledger.js";
import type { AdminRole } from "./admin-authorizer.js";

export type AdminPolicyApprovalMode =
  | "AUTO_APPROVE"
  | "DUAL_SIGNATURE_SLACK"
  | "HARD_BLOCK";

export interface AdminPolicyActor {
  readonly principalId: string;
  readonly membershipId: string;
  readonly organizationId: string;
  readonly roles: readonly AdminRole[];
}

export interface AdminPolicyConfiguration {
  readonly baseCurrency: string;
  readonly maxBudgetMinor: string;
  readonly rollingDailyLimitMinor: string;
  readonly approvedMerchantDomains: readonly string[];
  readonly approvedVendorIds: readonly string[];
  readonly restrictedCategories: readonly string[];
  readonly approvalMode: AdminPolicyApprovalMode;
  readonly maxTransactionsPerMinute: number;
  readonly crossMerchantWindowSecs: number;
  readonly maxDistinctMerchants: number;
}

export interface AdminPolicyCreateRequest extends AdminPolicyConfiguration {
  readonly name: string;
}

export interface AdminPolicyVersionCreateRequest extends AdminPolicyConfiguration {
  readonly version: number;
}

export interface AdminPolicyDetail extends AdminPolicyConfiguration {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly version: number;
  readonly active: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type AdminPolicyCreateResult =
  | {
      readonly outcome: "CREATED";
      readonly requestId: string;
      readonly policy: AdminPolicyDetail;
      readonly audit: AdminAuditAppendResult;
    }
  | {
      readonly outcome: "REPLAYED";
      readonly requestId: string;
      readonly policy: AdminPolicyDetail;
    }
  | {
      readonly outcome: "NOT_FOUND";
      readonly requestId: string;
    }
  | {
      readonly outcome: "CONFLICT";
      readonly requestId: string;
    };

export type AdminPolicyLifecycleResult =
  | {
      readonly outcome: "UPDATED";
      readonly requestId: string;
      readonly policy: AdminPolicyDetail;
      readonly audit: AdminAuditAppendResult;
    }
  | {
      readonly outcome: "REPLAYED";
      readonly requestId: string;
      readonly policy: AdminPolicyDetail;
    }
  | {
      readonly outcome: "NOT_FOUND";
      readonly requestId: string;
    };

interface PolicyRow {
  id: string;
  organizationId: string;
  name: string;
  version: number;
  active: boolean;
  baseCurrency: string;
  maxBudgetMinor: string;
  rollingDailyLimitMinor: string;
  approvedMerchantDomains: string[];
  approvedVendorIds: string[];
  restrictedCategories: string[];
  approvalMode: AdminPolicyApprovalMode;
  maxTransactionsPerMinute: number;
  crossMerchantWindowSecs: number;
  maxDistinctMerchants: number;
  createdAt: Date;
  updatedAt: Date;
}

interface NormalizedPolicyConfiguration {
  readonly baseCurrency: string;
  readonly maxBudgetMinor: string;
  readonly rollingDailyLimitMinor: string;
  readonly approvedMerchantDomains: readonly string[];
  readonly approvedVendorIds: readonly string[];
  readonly restrictedCategories: readonly string[];
  readonly approvalMode: AdminPolicyApprovalMode;
  readonly maxTransactionsPerMinute: number;
  readonly crossMerchantWindowSecs: number;
  readonly maxDistinctMerchants: number;
}

const SUPPORTED_CURRENCIES = new Set(["BHD", "EUR", "GBP", "JPY", "KWD", "USD"]);
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
const MAX_POLICY_VERSION = 2_147_483_647;
const POLICY_COLUMNS = `"id", "organizationId", "name", "version", "active",
  "baseCurrency", "maxBudgetMinor", "rollingDailyLimitMinor",
  "approvedMerchantDomains", "approvedVendorIds", "restrictedCategories", "approvalMode",
  "maxTransactionsPerMinute", "crossMerchantWindowSecs", "maxDistinctMerchants",
  "createdAt", "updatedAt"`;

export class PostgresAdminPolicyManagementService {
  public constructor(
    private readonly sql: AdminAuditSqlClient,
    private readonly audit: Pick<PostgresAdminChangeAuditLedger, "appendInTransaction">,
    private readonly generateId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async getPolicy(
    organizationId: string,
    policyId: string,
  ): Promise<AdminPolicyDetail | undefined> {
    const client = await this.sql.connect();
    try {
      const row = (
        await client.query<PolicyRow>(
          `select ${POLICY_COLUMNS}
             from "Policy"
            where "organizationId" = $1::uuid and "id" = $2::uuid`,
          [organizationId, policyId],
        )
      ).rows[0];
      return row ? policyResponse(row) : undefined;
    } finally {
      client.release();
    }
  }

  public async createPolicy(
    actor: AdminPolicyActor,
    request: AdminPolicyCreateRequest,
  ): Promise<AdminPolicyCreateResult> {
    const name = normalizeText(request.name, "name", 256);
    const configuration = normalizeConfiguration(request);
    const requestId = this.generateId();
    const timestamp = validNow(this.now());
    const tx = await this.sql.connect();

    try {
      await tx.query("begin");
      await lockOrganization(tx, actor.organizationId);

      const existingRows = (
        await tx.query<PolicyRow>(
          `select ${POLICY_COLUMNS}
             from "Policy"
            where "organizationId" = $1::uuid and "name" = $2
            order by "version" asc`,
          [actor.organizationId, name],
        )
      ).rows;

      if (existingRows.length > 0) {
        await tx.query("rollback");
        const versionOne = existingRows.find((row) => row.version === 1);
        if (versionOne && sameConfiguration(versionOne, configuration)) {
          return { outcome: "REPLAYED", requestId, policy: policyResponse(versionOne) };
        }
        return { outcome: "CONFLICT", requestId };
      }

      const policyId = this.generateId();
      const inserted = await insertPolicy(tx, {
        policyId,
        organizationId: actor.organizationId,
        name,
        version: 1,
        configuration,
        timestamp,
      });
      const policy = policyResponse(inserted);
      const audit = await this.audit.appendInTransaction(tx, {
        requestId,
        organizationId: actor.organizationId,
        principalId: actor.principalId,
        membershipId: actor.membershipId,
        timestamp,
        permission: "policy.create",
        action: "policy.create",
        resourceType: "policy",
        resourceId: policy.id,
        roles: actor.roles,
        afterState: policyAuditState(inserted),
        requestDigest: policyCreateDigest(actor.organizationId, name, 1, configuration),
      });
      await tx.query("commit");
      return { outcome: "CREATED", requestId, policy, audit };
    } catch (error) {
      await rollbackPreserving(tx);
      throw error;
    } finally {
      tx.release();
    }
  }

  public async createVersion(
    actor: AdminPolicyActor,
    sourcePolicyId: string,
    request: AdminPolicyVersionCreateRequest,
  ): Promise<AdminPolicyCreateResult> {
    const version = normalizeVersion(request.version);
    const configuration = normalizeConfiguration(request);
    const requestId = this.generateId();
    const timestamp = validNow(this.now());
    const tx = await this.sql.connect();

    try {
      await tx.query("begin");
      await lockOrganization(tx, actor.organizationId);
      const source = await lockPolicy(tx, actor.organizationId, sourcePolicyId);
      if (!source) {
        await tx.query("rollback");
        return { outcome: "NOT_FOUND", requestId };
      }
      if (version !== source.version + 1) {
        await tx.query("rollback");
        return { outcome: "CONFLICT", requestId };
      }

      const existing = (
        await tx.query<PolicyRow>(
          `select ${POLICY_COLUMNS}
             from "Policy"
            where "organizationId" = $1::uuid and "name" = $2 and "version" = $3`,
          [actor.organizationId, source.name, version],
        )
      ).rows[0];
      if (existing) {
        await tx.query("rollback");
        if (sameConfiguration(existing, configuration)) {
          return { outcome: "REPLAYED", requestId, policy: policyResponse(existing) };
        }
        return { outcome: "CONFLICT", requestId };
      }

      const latest = (
        await tx.query<{ version: number }>(
          `select "version"
             from "Policy"
            where "organizationId" = $1::uuid and "name" = $2
            order by "version" desc
            limit 1`,
          [actor.organizationId, source.name],
        )
      ).rows[0];
      if (!latest || latest.version !== source.version) {
        await tx.query("rollback");
        return { outcome: "CONFLICT", requestId };
      }

      const inserted = await insertPolicy(tx, {
        policyId: this.generateId(),
        organizationId: actor.organizationId,
        name: source.name,
        version,
        configuration,
        timestamp,
      });
      const policy = policyResponse(inserted);
      const audit = await this.audit.appendInTransaction(tx, {
        requestId,
        organizationId: actor.organizationId,
        principalId: actor.principalId,
        membershipId: actor.membershipId,
        timestamp,
        permission: "policy.create",
        action: "policy.version.create",
        resourceType: "policy",
        resourceId: policy.id,
        roles: actor.roles,
        beforeState: policyAuditState(source),
        afterState: policyAuditState(inserted),
        metadata: { sourcePolicyId: source.id, sourceVersion: source.version },
        requestDigest: policyVersionDigest(
          actor.organizationId,
          source.id,
          source.name,
          version,
          configuration,
        ),
      });
      await tx.query("commit");
      return { outcome: "CREATED", requestId, policy, audit };
    } catch (error) {
      await rollbackPreserving(tx);
      throw error;
    } finally {
      tx.release();
    }
  }

  public activate(
    actor: AdminPolicyActor,
    policyId: string,
  ): Promise<AdminPolicyLifecycleResult> {
    return this.changeActivation(actor, policyId, true, "policy.activate", "policy.activate");
  }

  public deactivate(
    actor: AdminPolicyActor,
    policyId: string,
  ): Promise<AdminPolicyLifecycleResult> {
    return this.changeActivation(actor, policyId, false, "policy.deactivate", "policy.deactivate");
  }

  private async changeActivation(
    actor: AdminPolicyActor,
    policyId: string,
    targetActive: boolean,
    permission: "policy.activate" | "policy.deactivate",
    action: "policy.activate" | "policy.deactivate",
  ): Promise<AdminPolicyLifecycleResult> {
    const requestId = this.generateId();
    const timestamp = validNow(this.now());
    const tx = await this.sql.connect();

    try {
      await tx.query("begin");
      const row = await lockPolicy(tx, actor.organizationId, policyId);
      if (!row) {
        await tx.query("rollback");
        return { outcome: "NOT_FOUND", requestId };
      }
      if (row.active === targetActive) {
        await tx.query("rollback");
        return { outcome: "REPLAYED", requestId, policy: policyResponse(row) };
      }

      const updated = (
        await tx.query<PolicyRow>(
          `update "Policy"
              set "active" = $3, "updatedAt" = $4
            where "organizationId" = $1::uuid and "id" = $2::uuid
            returning ${POLICY_COLUMNS}`,
          [actor.organizationId, policyId, targetActive, timestamp],
        )
      ).rows[0];
      if (!updated) {
        throw new Error("Administrative policy activation transition returned no row");
      }
      const policy = policyResponse(updated);
      const audit = await this.audit.appendInTransaction(tx, {
        requestId,
        organizationId: actor.organizationId,
        principalId: actor.principalId,
        membershipId: actor.membershipId,
        timestamp,
        permission,
        action,
        resourceType: "policy",
        resourceId: policyId,
        roles: actor.roles,
        beforeState: policyAuditState(row),
        afterState: policyAuditState(updated),
        requestDigest: sha256Base64Url(
          canonicalJson({
            type: "mino.admin.policy.activation-transition.v1",
            organizationId: actor.organizationId,
            policyId,
            targetActive,
          }),
        ),
      });
      await tx.query("commit");
      return { outcome: "UPDATED", requestId, policy, audit };
    } catch (error) {
      await rollbackPreserving(tx);
      throw error;
    } finally {
      tx.release();
    }
  }
}

async function insertPolicy(
  tx: Awaited<ReturnType<AdminAuditSqlClient["connect"]>>,
  input: {
    readonly policyId: string;
    readonly organizationId: string;
    readonly name: string;
    readonly version: number;
    readonly configuration: NormalizedPolicyConfiguration;
    readonly timestamp: Date;
  },
): Promise<PolicyRow> {
  const configuration = input.configuration;
  const row = (
    await tx.query<PolicyRow>(
      `insert into "Policy" (
         "id", "organizationId", "name", "version", "active",
         "baseCurrency", "maxBudgetMinor", "rollingDailyLimitMinor",
         "approvedMerchantDomains", "approvedVendorIds", "restrictedCategories", "approvalMode",
         "maxTransactionsPerMinute", "crossMerchantWindowSecs", "maxDistinctMerchants",
         "createdAt", "updatedAt"
       ) values (
         $1::uuid, $2::uuid, $3, $4, false,
         $5, $6::bigint, $7::bigint,
         $8::text[], $9::text[], $10::text[], $11::"ApprovalMode",
         $12, $13, $14,
         $15, $15
       )
       returning ${POLICY_COLUMNS}`,
      [
        input.policyId,
        input.organizationId,
        input.name,
        input.version,
        configuration.baseCurrency,
        configuration.maxBudgetMinor,
        configuration.rollingDailyLimitMinor,
        [...configuration.approvedMerchantDomains],
        [...configuration.approvedVendorIds],
        [...configuration.restrictedCategories],
        configuration.approvalMode,
        configuration.maxTransactionsPerMinute,
        configuration.crossMerchantWindowSecs,
        configuration.maxDistinctMerchants,
        input.timestamp,
      ],
    )
  ).rows[0];
  if (!row) {
    throw new Error("Administrative policy insert returned no row");
  }
  return row;
}

async function lockOrganization(
  tx: Awaited<ReturnType<AdminAuditSqlClient["connect"]>>,
  organizationId: string,
): Promise<void> {
  const organization = await tx.query<{ id: string }>(
    `select "id" from "Organization" where "id" = $1::uuid for update`,
    [organizationId],
  );
  if (organization.rowCount !== 1) {
    throw new Error("Administrative policy organization no longer exists");
  }
}

async function lockPolicy(
  tx: Awaited<ReturnType<AdminAuditSqlClient["connect"]>>,
  organizationId: string,
  policyId: string,
): Promise<PolicyRow | undefined> {
  return (
    await tx.query<PolicyRow>(
      `select ${POLICY_COLUMNS}
         from "Policy"
        where "organizationId" = $1::uuid and "id" = $2::uuid
        for update`,
      [organizationId, policyId],
    )
  ).rows[0];
}

function normalizeConfiguration(
  request: AdminPolicyConfiguration,
): NormalizedPolicyConfiguration {
  const baseCurrency = request.baseCurrency.trim().toUpperCase();
  if (!SUPPORTED_CURRENCIES.has(baseCurrency)) {
    throw new AdminPolicyValidationError("baseCurrency is unsupported");
  }

  return {
    baseCurrency,
    maxBudgetMinor: normalizeMinorUnits(request.maxBudgetMinor, "maxBudgetMinor"),
    rollingDailyLimitMinor: normalizeMinorUnits(
      request.rollingDailyLimitMinor,
      "rollingDailyLimitMinor",
    ),
    approvedMerchantDomains: normalizeDomains(request.approvedMerchantDomains),
    approvedVendorIds: normalizeList(request.approvedVendorIds, "approvedVendorIds", 256),
    restrictedCategories: normalizeCategories(request.restrictedCategories),
    approvalMode: normalizeApprovalMode(request.approvalMode),
    maxTransactionsPerMinute: normalizeBoundedInteger(
      request.maxTransactionsPerMinute,
      "maxTransactionsPerMinute",
      0,
      100_000,
    ),
    crossMerchantWindowSecs: normalizeBoundedInteger(
      request.crossMerchantWindowSecs,
      "crossMerchantWindowSecs",
      1,
      86_400,
    ),
    maxDistinctMerchants: normalizeBoundedInteger(
      request.maxDistinctMerchants,
      "maxDistinctMerchants",
      0,
      100_000,
    ),
  };
}

function normalizeMinorUnits(value: string, field: string): string {
  const normalized = value.trim();
  if (!/^(?:0|[1-9]\d*)$/.test(normalized)) {
    throw new AdminPolicyValidationError(`${field} must be a non-negative integer string`);
  }
  let amount: bigint;
  try {
    amount = BigInt(normalized);
  } catch {
    throw new AdminPolicyValidationError(`${field} is invalid`);
  }
  if (amount > MAX_POSTGRES_BIGINT) {
    throw new AdminPolicyValidationError(`${field} exceeds PostgreSQL BIGINT range`);
  }
  return amount.toString(10);
}

function normalizeDomains(values: readonly string[]): readonly string[] {
  if (values.length > 100) {
    throw new AdminPolicyValidationError("approvedMerchantDomains has too many entries");
  }
  const domains = values.map((value) => {
    const trimmed = value.trim().toLowerCase().replace(/\.$/, "");
    if (
      trimmed.length === 0 ||
      trimmed.length > 253 ||
      trimmed.includes("://") ||
      trimmed.includes("/") ||
      trimmed.includes("@") ||
      trimmed.includes(":")
    ) {
      throw new AdminPolicyValidationError("approvedMerchantDomains contains an invalid domain");
    }
    const ascii = domainToASCII(trimmed).toLowerCase();
    if (!ascii || ascii.length > 253 || !validHostname(ascii)) {
      throw new AdminPolicyValidationError("approvedMerchantDomains contains an invalid domain");
    }
    return ascii;
  });
  return [...new Set(domains)].sort();
}

function validHostname(value: string): boolean {
  return value.split(".").every(
    (label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
  );
}

function normalizeList(
  values: readonly string[],
  field: string,
  maxEntryLength: number,
): readonly string[] {
  if (values.length > 100) {
    throw new AdminPolicyValidationError(`${field} has too many entries`);
  }
  return [...new Set(values.map((value) => normalizeText(value, field, maxEntryLength)))].sort();
}

function normalizeCategories(values: readonly string[]): readonly string[] {
  if (values.length > 100) {
    throw new AdminPolicyValidationError("restrictedCategories has too many entries");
  }
  const categories = values.map((value) => {
    const normalized = normalizeText(value, "restrictedCategories", 128)
      .toUpperCase()
      .replace(/[\s-]+/g, "_");
    return normalized;
  });
  return [...new Set(categories)].sort();
}

function normalizeText(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new AdminPolicyValidationError(`${field} is invalid`);
  }
  return normalized;
}

function normalizeApprovalMode(value: AdminPolicyApprovalMode): AdminPolicyApprovalMode {
  switch (value) {
    case "AUTO_APPROVE":
    case "DUAL_SIGNATURE_SLACK":
    case "HARD_BLOCK":
      return value;
    default:
      throw new AdminPolicyValidationError("approvalMode is invalid");
  }
}

function normalizeBoundedInteger(
  value: number,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new AdminPolicyValidationError(`${field} is out of range`);
  }
  return value;
}

function normalizeVersion(value: number): number {
  return normalizeBoundedInteger(value, "version", 1, MAX_POLICY_VERSION);
}

function sameConfiguration(
  row: PolicyRow,
  configuration: NormalizedPolicyConfiguration,
): boolean {
  return (
    row.baseCurrency === configuration.baseCurrency &&
    String(row.maxBudgetMinor) === configuration.maxBudgetMinor &&
    String(row.rollingDailyLimitMinor) === configuration.rollingDailyLimitMinor &&
    sameArray(row.approvedMerchantDomains, configuration.approvedMerchantDomains) &&
    sameArray(row.approvedVendorIds, configuration.approvedVendorIds) &&
    sameArray(row.restrictedCategories, configuration.restrictedCategories) &&
    row.approvalMode === configuration.approvalMode &&
    row.maxTransactionsPerMinute === configuration.maxTransactionsPerMinute &&
    row.crossMerchantWindowSecs === configuration.crossMerchantWindowSecs &&
    row.maxDistinctMerchants === configuration.maxDistinctMerchants
  );
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function policyResponse(row: PolicyRow): AdminPolicyDetail {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    version: row.version,
    active: row.active,
    baseCurrency: row.baseCurrency,
    maxBudgetMinor: String(row.maxBudgetMinor),
    rollingDailyLimitMinor: String(row.rollingDailyLimitMinor),
    approvedMerchantDomains: row.approvedMerchantDomains,
    approvedVendorIds: row.approvedVendorIds,
    restrictedCategories: row.restrictedCategories,
    approvalMode: row.approvalMode,
    maxTransactionsPerMinute: row.maxTransactionsPerMinute,
    crossMerchantWindowSecs: row.crossMerchantWindowSecs,
    maxDistinctMerchants: row.maxDistinctMerchants,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function policyAuditState(row: PolicyRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    active: row.active,
    baseCurrency: row.baseCurrency,
    maxBudgetMinor: String(row.maxBudgetMinor),
    rollingDailyLimitMinor: String(row.rollingDailyLimitMinor),
    approvedMerchantDomains: row.approvedMerchantDomains,
    approvedVendorIds: row.approvedVendorIds,
    restrictedCategories: row.restrictedCategories,
    approvalMode: row.approvalMode,
    maxTransactionsPerMinute: row.maxTransactionsPerMinute,
    crossMerchantWindowSecs: row.crossMerchantWindowSecs,
    maxDistinctMerchants: row.maxDistinctMerchants,
  };
}

function policyCreateDigest(
  organizationId: string,
  name: string,
  version: number,
  configuration: NormalizedPolicyConfiguration,
): string {
  return sha256Base64Url(
    canonicalJson({
      type: "mino.admin.policy.create.v1",
      organizationId,
      name,
      version,
      ...configuration,
    }),
  );
}

function policyVersionDigest(
  organizationId: string,
  sourcePolicyId: string,
  name: string,
  version: number,
  configuration: NormalizedPolicyConfiguration,
): string {
  return sha256Base64Url(
    canonicalJson({
      type: "mino.admin.policy.version.create.v1",
      organizationId,
      sourcePolicyId,
      name,
      version,
      ...configuration,
    }),
  );
}

function validNow(value: Date): Date {
  if (!Number.isFinite(value.getTime())) {
    throw new Error("Administrative policy management clock returned an invalid timestamp");
  }
  return value;
}

async function rollbackPreserving(
  tx: Awaited<ReturnType<AdminAuditSqlClient["connect"]>>,
): Promise<void> {
  try {
    await tx.query("rollback");
  } catch {
    // Preserve the original policy mutation/audit failure.
  }
}

export class AdminPolicyValidationError extends Error {}
