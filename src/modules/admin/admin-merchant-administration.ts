import { randomUUID } from "node:crypto";
import { canonicalJson, sha256Base64Url } from "../../infrastructure/crypto/canonical-json.js";
import {
  MerchantRoutingValidationError,
  normalizeMerchantRoutingTarget,
} from "../proxy/merchant-routing.js";
import type {
  AdminAuditAppendResult,
  AdminAuditSqlClient,
  PostgresAdminChangeAuditLedger,
} from "./admin-change-audit-ledger.js";
import type { AdminRole } from "./admin-authorizer.js";

export interface AdminMerchantActor {
  readonly principalId: string;
  readonly membershipId: string;
  readonly organizationId: string;
  readonly roles: readonly AdminRole[];
}

export interface AdminMerchantCreateRequest {
  readonly externalMerchantId: string;
  readonly domain: string;
  readonly vendorId?: string;
  readonly baseUrl: string;
}

export interface AdminMerchantConfigurationUpdateRequest {
  readonly domain: string;
  readonly vendorId: string | null;
  readonly baseUrl: string;
}

export interface AdminMerchantDetail {
  readonly id: string;
  readonly organizationId: string;
  readonly externalMerchantId: string;
  readonly domain: string;
  readonly vendorId?: string;
  readonly baseUrl: string;
  readonly active: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type AdminMerchantCreateResult =
  | {
      readonly outcome: "CREATED";
      readonly requestId: string;
      readonly merchant: AdminMerchantDetail;
      readonly audit: AdminAuditAppendResult;
    }
  | {
      readonly outcome: "REPLAYED";
      readonly requestId: string;
      readonly merchant: AdminMerchantDetail;
    }
  | {
      readonly outcome: "CONFLICT";
      readonly requestId: string;
    };

export type AdminMerchantUpdateResult =
  | {
      readonly outcome: "UPDATED";
      readonly requestId: string;
      readonly merchant: AdminMerchantDetail;
      readonly audit: AdminAuditAppendResult;
    }
  | {
      readonly outcome: "REPLAYED";
      readonly requestId: string;
      readonly merchant: AdminMerchantDetail;
    }
  | {
      readonly outcome: "NOT_FOUND";
      readonly requestId: string;
    }
  | {
      readonly outcome: "CONFLICT";
      readonly requestId: string;
    };

export type AdminMerchantLifecycleResult =
  | {
      readonly outcome: "UPDATED";
      readonly requestId: string;
      readonly merchant: AdminMerchantDetail;
      readonly audit: AdminAuditAppendResult;
    }
  | {
      readonly outcome: "REPLAYED";
      readonly requestId: string;
      readonly merchant: AdminMerchantDetail;
    }
  | {
      readonly outcome: "NOT_FOUND";
      readonly requestId: string;
    };

interface MerchantRow {
  id: string;
  organizationId: string;
  externalMerchantId: string;
  domain: string;
  vendorId: string | null;
  baseUrl: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface NormalizedMerchantConfiguration {
  readonly domain: string;
  readonly vendorId?: string;
  readonly baseUrl: string;
}

const MERCHANT_COLUMNS = `"id", "organizationId", "externalMerchantId", "domain", "vendorId",
  "baseUrl", "active", "createdAt", "updatedAt"`;

export class PostgresAdminMerchantAdministrationService {
  public constructor(
    private readonly sql: AdminAuditSqlClient,
    private readonly audit: Pick<PostgresAdminChangeAuditLedger, "appendInTransaction">,
    private readonly generateId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async getMerchant(
    organizationId: string,
    merchantId: string,
  ): Promise<AdminMerchantDetail | undefined> {
    const client = await this.sql.connect();
    try {
      const row = (
        await client.query<MerchantRow>(
          `select ${MERCHANT_COLUMNS}
             from "MerchantEndpoint"
            where "organizationId" = $1::uuid and "id" = $2::uuid`,
          [organizationId, merchantId],
        )
      ).rows[0];
      return row ? merchantResponse(row) : undefined;
    } finally {
      client.release();
    }
  }

  public async createMerchant(
    actor: AdminMerchantActor,
    request: AdminMerchantCreateRequest,
  ): Promise<AdminMerchantCreateResult> {
    const externalMerchantId = normalizeText(request.externalMerchantId, "externalMerchantId", 256);
    const configuration = normalizeConfiguration({
      domain: request.domain,
      vendorId: request.vendorId ?? null,
      baseUrl: request.baseUrl,
    });
    const requestId = this.generateId();
    const timestamp = validNow(this.now());
    const tx = await this.sql.connect();

    try {
      await tx.query("begin");
      await lockOrganization(tx, actor.organizationId);

      const existing = (
        await tx.query<MerchantRow>(
          `select ${MERCHANT_COLUMNS}
             from "MerchantEndpoint"
            where "organizationId" = $1::uuid and "externalMerchantId" = $2`,
          [actor.organizationId, externalMerchantId],
        )
      ).rows[0];
      if (existing) {
        await tx.query("rollback");
        if (sameConfiguration(existing, configuration)) {
          return { outcome: "REPLAYED", requestId, merchant: merchantResponse(existing) };
        }
        return { outcome: "CONFLICT", requestId };
      }

      const merchantId = this.generateId();
      const inserted = (
        await tx.query<MerchantRow>(
          `insert into "MerchantEndpoint" (
             "id", "organizationId", "externalMerchantId", "domain", "vendorId",
             "baseUrl", "active", "createdAt", "updatedAt"
           ) values ($1::uuid, $2::uuid, $3, $4, $5, $6, false, $7, $7)
           returning ${MERCHANT_COLUMNS}`,
          [
            merchantId,
            actor.organizationId,
            externalMerchantId,
            configuration.domain,
            configuration.vendorId ?? null,
            configuration.baseUrl,
            timestamp,
          ],
        )
      ).rows[0];
      if (!inserted) {
        throw new Error("Administrative merchant insert returned no row");
      }

      const merchant = merchantResponse(inserted);
      const audit = await this.audit.appendInTransaction(tx, {
        requestId,
        organizationId: actor.organizationId,
        principalId: actor.principalId,
        membershipId: actor.membershipId,
        timestamp,
        permission: "merchant.manage",
        action: "merchant.create",
        resourceType: "merchant",
        resourceId: merchant.id,
        roles: actor.roles,
        afterState: merchantAuditState(inserted),
        requestDigest: merchantCreateDigest(
          actor.organizationId,
          externalMerchantId,
          configuration,
        ),
      });
      await tx.query("commit");
      return { outcome: "CREATED", requestId, merchant, audit };
    } catch (error) {
      await rollbackPreserving(tx);
      throw error;
    } finally {
      tx.release();
    }
  }

  public async updateConfiguration(
    actor: AdminMerchantActor,
    merchantId: string,
    request: AdminMerchantConfigurationUpdateRequest,
  ): Promise<AdminMerchantUpdateResult> {
    const configuration = normalizeConfiguration(request);
    const requestId = this.generateId();
    const timestamp = validNow(this.now());
    const tx = await this.sql.connect();

    try {
      await tx.query("begin");
      const row = await lockMerchant(tx, actor.organizationId, merchantId);
      if (!row) {
        await tx.query("rollback");
        return { outcome: "NOT_FOUND", requestId };
      }
      if (sameConfiguration(row, configuration)) {
        await tx.query("rollback");
        return { outcome: "REPLAYED", requestId, merchant: merchantResponse(row) };
      }
      if (row.active) {
        await tx.query("rollback");
        return { outcome: "CONFLICT", requestId };
      }

      const updated = (
        await tx.query<MerchantRow>(
          `update "MerchantEndpoint"
              set "domain" = $3, "vendorId" = $4, "baseUrl" = $5, "updatedAt" = $6
            where "organizationId" = $1::uuid and "id" = $2::uuid
            returning ${MERCHANT_COLUMNS}`,
          [
            actor.organizationId,
            merchantId,
            configuration.domain,
            configuration.vendorId ?? null,
            configuration.baseUrl,
            timestamp,
          ],
        )
      ).rows[0];
      if (!updated) {
        throw new Error("Administrative merchant configuration update returned no row");
      }

      const merchant = merchantResponse(updated);
      const audit = await this.audit.appendInTransaction(tx, {
        requestId,
        organizationId: actor.organizationId,
        principalId: actor.principalId,
        membershipId: actor.membershipId,
        timestamp,
        permission: "merchant.manage",
        action: "merchant.configuration.update",
        resourceType: "merchant",
        resourceId: merchant.id,
        roles: actor.roles,
        beforeState: merchantAuditState(row),
        afterState: merchantAuditState(updated),
        requestDigest: merchantUpdateDigest(
          actor.organizationId,
          merchant.id,
          merchant.externalMerchantId,
          configuration,
        ),
      });
      await tx.query("commit");
      return { outcome: "UPDATED", requestId, merchant, audit };
    } catch (error) {
      await rollbackPreserving(tx);
      throw error;
    } finally {
      tx.release();
    }
  }

  public activate(
    actor: AdminMerchantActor,
    merchantId: string,
  ): Promise<AdminMerchantLifecycleResult> {
    return this.changeActivation(actor, merchantId, true, "merchant.activate");
  }

  public deactivate(
    actor: AdminMerchantActor,
    merchantId: string,
  ): Promise<AdminMerchantLifecycleResult> {
    return this.changeActivation(actor, merchantId, false, "merchant.deactivate");
  }

  private async changeActivation(
    actor: AdminMerchantActor,
    merchantId: string,
    targetActive: boolean,
    action: "merchant.activate" | "merchant.deactivate",
  ): Promise<AdminMerchantLifecycleResult> {
    const requestId = this.generateId();
    const timestamp = validNow(this.now());
    const tx = await this.sql.connect();

    try {
      await tx.query("begin");
      const row = await lockMerchant(tx, actor.organizationId, merchantId);
      if (!row) {
        await tx.query("rollback");
        return { outcome: "NOT_FOUND", requestId };
      }
      if (row.active === targetActive) {
        await tx.query("rollback");
        return { outcome: "REPLAYED", requestId, merchant: merchantResponse(row) };
      }
      if (targetActive) {
        assertPersistedRouting(row);
      }

      const updated = (
        await tx.query<MerchantRow>(
          `update "MerchantEndpoint"
              set "active" = $3, "updatedAt" = $4
            where "organizationId" = $1::uuid and "id" = $2::uuid
            returning ${MERCHANT_COLUMNS}`,
          [actor.organizationId, merchantId, targetActive, timestamp],
        )
      ).rows[0];
      if (!updated) {
        throw new Error("Administrative merchant activation transition returned no row");
      }

      const merchant = merchantResponse(updated);
      const audit = await this.audit.appendInTransaction(tx, {
        requestId,
        organizationId: actor.organizationId,
        principalId: actor.principalId,
        membershipId: actor.membershipId,
        timestamp,
        permission: "merchant.manage",
        action,
        resourceType: "merchant",
        resourceId: merchant.id,
        roles: actor.roles,
        beforeState: merchantAuditState(row),
        afterState: merchantAuditState(updated),
        requestDigest: sha256Base64Url(
          canonicalJson({
            type: "mino.admin.merchant.activation-transition.v1",
            organizationId: actor.organizationId,
            merchantId,
            externalMerchantId: row.externalMerchantId,
            targetActive,
          }),
        ),
      });
      await tx.query("commit");
      return { outcome: "UPDATED", requestId, merchant, audit };
    } catch (error) {
      await rollbackPreserving(tx);
      throw error;
    } finally {
      tx.release();
    }
  }
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
    throw new Error("Administrative merchant organization no longer exists");
  }
}

async function lockMerchant(
  tx: Awaited<ReturnType<AdminAuditSqlClient["connect"]>>,
  organizationId: string,
  merchantId: string,
): Promise<MerchantRow | undefined> {
  return (
    await tx.query<MerchantRow>(
      `select ${MERCHANT_COLUMNS}
         from "MerchantEndpoint"
        where "organizationId" = $1::uuid and "id" = $2::uuid
        for update`,
      [organizationId, merchantId],
    )
  ).rows[0];
}

function normalizeConfiguration(input: {
  readonly domain: string;
  readonly vendorId: string | null;
  readonly baseUrl: string;
}): NormalizedMerchantConfiguration {
  let routing: ReturnType<typeof normalizeMerchantRoutingTarget>;
  try {
    routing = normalizeMerchantRoutingTarget(input.domain, input.baseUrl);
  } catch (error) {
    if (error instanceof MerchantRoutingValidationError) {
      throw new AdminMerchantValidationError(error.message);
    }
    throw error;
  }

  const vendorId = input.vendorId === null
    ? undefined
    : normalizeText(input.vendorId, "vendorId", 256);
  return {
    domain: routing.domain,
    ...(vendorId ? { vendorId } : {}),
    baseUrl: routing.baseUrl,
  };
}

function normalizeText(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new AdminMerchantValidationError(`${field} is invalid`);
  }
  return normalized;
}

function sameConfiguration(
  row: MerchantRow,
  configuration: NormalizedMerchantConfiguration,
): boolean {
  return (
    row.domain === configuration.domain &&
    (row.vendorId ?? undefined) === configuration.vendorId &&
    row.baseUrl === configuration.baseUrl
  );
}

function assertPersistedRouting(row: MerchantRow): void {
  try {
    const normalized = normalizeMerchantRoutingTarget(row.domain, row.baseUrl);
    if (normalized.domain !== row.domain || normalized.baseUrl !== row.baseUrl) {
      throw new Error("not canonical");
    }
  } catch {
    throw new Error("Persisted merchant routing configuration is invalid or non-canonical");
  }
}

function merchantResponse(row: MerchantRow): AdminMerchantDetail {
  return {
    id: row.id,
    organizationId: row.organizationId,
    externalMerchantId: row.externalMerchantId,
    domain: row.domain,
    ...(row.vendorId ? { vendorId: row.vendorId } : {}),
    baseUrl: row.baseUrl,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function merchantAuditState(row: MerchantRow): Record<string, unknown> {
  return {
    id: row.id,
    externalMerchantId: row.externalMerchantId,
    domain: row.domain,
    vendorId: row.vendorId,
    baseUrl: row.baseUrl,
    active: row.active,
  };
}

function merchantCreateDigest(
  organizationId: string,
  externalMerchantId: string,
  configuration: NormalizedMerchantConfiguration,
): string {
  return sha256Base64Url(
    canonicalJson({
      type: "mino.admin.merchant.create.v1",
      organizationId,
      externalMerchantId,
      domain: configuration.domain,
      vendorId: configuration.vendorId ?? null,
      baseUrl: configuration.baseUrl,
    }),
  );
}

function merchantUpdateDigest(
  organizationId: string,
  merchantId: string,
  externalMerchantId: string,
  configuration: NormalizedMerchantConfiguration,
): string {
  return sha256Base64Url(
    canonicalJson({
      type: "mino.admin.merchant.configuration-update.v1",
      organizationId,
      merchantId,
      externalMerchantId,
      domain: configuration.domain,
      vendorId: configuration.vendorId ?? null,
      baseUrl: configuration.baseUrl,
    }),
  );
}

function validNow(value: Date): Date {
  if (!Number.isFinite(value.getTime())) {
    throw new Error("Administrative merchant clock returned an invalid timestamp");
  }
  return value;
}

async function rollbackPreserving(
  tx: Awaited<ReturnType<AdminAuditSqlClient["connect"]>>,
): Promise<void> {
  try {
    await tx.query("rollback");
  } catch {
    // Preserve the original mutation/audit error.
  }
}

export class AdminMerchantValidationError extends Error {}
