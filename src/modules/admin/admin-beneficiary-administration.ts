import { randomUUID } from "node:crypto";
import { canonicalJson, sha256Base64Url } from "../../infrastructure/crypto/canonical-json.js";
import type {
  AdminAuditAppendResult,
  AdminAuditSqlClient,
  AdminAuditSqlTransaction,
  PostgresAdminChangeAuditLedger,
} from "./admin-change-audit-ledger.js";
import type { AdminRole } from "./admin-authorizer.js";

export type AdminBeneficiaryStatus = "ACTIVE" | "SUSPENDED" | "DISABLED";

export interface AdminBeneficiaryActor {
  readonly principalId: string;
  readonly membershipId: string;
  readonly organizationId: string;
  readonly roles: readonly AdminRole[];
}

export interface AdminBeneficiaryDetail {
  readonly id: string;
  readonly organizationId: string;
  readonly email: string;
  readonly status: AdminBeneficiaryStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AdminBeneficiaryListRequest {
  readonly organizationId: string;
  readonly limit: number;
  readonly cursor?: string;
}

export interface AdminBeneficiaryPage {
  readonly items: readonly AdminBeneficiaryDetail[];
  readonly nextCursor?: string;
}

export type AdminBeneficiaryCreateResult =
  | {
      readonly outcome: "CREATED";
      readonly requestId: string;
      readonly beneficiary: AdminBeneficiaryDetail;
      readonly audit: AdminAuditAppendResult;
    }
  | {
      readonly outcome: "REPLAYED";
      readonly requestId: string;
      readonly beneficiary: AdminBeneficiaryDetail;
    }
  | {
      readonly outcome: "CONFLICT";
      readonly requestId: string;
    };

export type AdminBeneficiarySuspendResult =
  | {
      readonly outcome: "UPDATED";
      readonly requestId: string;
      readonly beneficiary: AdminBeneficiaryDetail;
      readonly audit: AdminAuditAppendResult;
    }
  | {
      readonly outcome: "REPLAYED";
      readonly requestId: string;
      readonly beneficiary: AdminBeneficiaryDetail;
    }
  | {
      readonly outcome: "NOT_FOUND";
      readonly requestId: string;
    }
  | {
      readonly outcome: "CONFLICT";
      readonly requestId: string;
    };

interface BeneficiaryRow {
  id: string;
  organizationId: string;
  email: string;
  status: AdminBeneficiaryStatus;
  createdAt: Date;
  updatedAt: Date;
}

export class PostgresAdminBeneficiaryAdministrationService {
  public constructor(
    private readonly sql: AdminAuditSqlClient,
    private readonly audit: Pick<PostgresAdminChangeAuditLedger, "appendInTransaction">,
    private readonly generateId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async listBeneficiaries(
    request: AdminBeneficiaryListRequest,
  ): Promise<AdminBeneficiaryPage> {
    if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 100) {
      throw new AdminBeneficiaryValidationError("limit is invalid");
    }
    const client = await this.sql.connect();
    try {
      const result = await client.query<BeneficiaryRow>(
        `select "id", "organizationId", "email", "status", "createdAt", "updatedAt"
           from "User"
          where "organizationId" = $1::uuid
            and ($3::uuid is null or "id" > $3::uuid)
          order by "id" asc
          limit $2`,
        [request.organizationId, request.limit + 1, request.cursor ?? null],
      );
      const hasMore = result.rows.length > request.limit;
      const rows = hasMore ? result.rows.slice(0, request.limit) : result.rows;
      const last = rows.at(-1);
      return {
        items: rows.map(beneficiaryResponse),
        ...(hasMore && last ? { nextCursor: last.id } : {}),
      };
    } finally {
      client.release();
    }
  }

  public async getBeneficiary(
    organizationId: string,
    beneficiaryId: string,
  ): Promise<AdminBeneficiaryDetail | undefined> {
    const client = await this.sql.connect();
    try {
      const row = (
        await client.query<BeneficiaryRow>(
          `select "id", "organizationId", "email", "status", "createdAt", "updatedAt"
             from "User"
            where "organizationId" = $1::uuid and "id" = $2::uuid`,
          [organizationId, beneficiaryId],
        )
      ).rows[0];
      return row ? beneficiaryResponse(row) : undefined;
    } finally {
      client.release();
    }
  }

  public async createBeneficiary(
    actor: AdminBeneficiaryActor,
    request: { readonly email: string },
  ): Promise<AdminBeneficiaryCreateResult> {
    const email = normalizeEmail(request.email);
    const requestId = this.generateId();
    const timestamp = validNow(this.now());
    const tx = await this.sql.connect();
    try {
      await tx.query("begin");
      const organization = await tx.query<{ id: string }>(
        `select "id" from "Organization" where "id" = $1::uuid for update`,
        [actor.organizationId],
      );
      if (organization.rowCount !== 1) {
        throw new Error("Administrative beneficiary organization no longer exists");
      }

      const matches = await tx.query<BeneficiaryRow>(
        `select "id", "organizationId", "email", "status", "createdAt", "updatedAt"
           from "User"
          where "organizationId" = $1::uuid and lower("email") = $2
          order by "id" asc
          for update`,
        [actor.organizationId, email],
      );
      if (matches.rows.length > 1) {
        await tx.query("rollback");
        return { outcome: "CONFLICT", requestId };
      }
      const existing = matches.rows[0];
      if (existing) {
        await tx.query("rollback");
        if (existing.status !== "ACTIVE") {
          return { outcome: "CONFLICT", requestId };
        }
        return {
          outcome: "REPLAYED",
          requestId,
          beneficiary: beneficiaryResponse(existing),
        };
      }

      const beneficiaryId = this.generateId();
      const inserted = (
        await tx.query<BeneficiaryRow>(
          `insert into "User" (
             "id", "organizationId", "email", "status", "createdAt", "updatedAt"
           ) values ($1::uuid, $2::uuid, $3, 'ACTIVE', $4, $4)
           returning "id", "organizationId", "email", "status", "createdAt", "updatedAt"`,
          [beneficiaryId, actor.organizationId, email, timestamp],
        )
      ).rows[0];
      if (!inserted) {
        throw new Error("Administrative beneficiary creation returned no row");
      }

      const beneficiary = beneficiaryResponse(inserted);
      const audit = await this.audit.appendInTransaction(tx, {
        requestId,
        organizationId: actor.organizationId,
        principalId: actor.principalId,
        membershipId: actor.membershipId,
        timestamp,
        permission: "beneficiary.create",
        action: "beneficiary.create",
        resourceType: "beneficiary",
        resourceId: beneficiary.id,
        roles: actor.roles,
        afterState: beneficiaryAuditState(inserted),
        requestDigest: sha256Base64Url(
          canonicalJson({
            type: "mino.admin.beneficiary.create.v1",
            organizationId: actor.organizationId,
            email,
          }),
        ),
      });
      await tx.query("commit");
      return { outcome: "CREATED", requestId, beneficiary, audit };
    } catch (error) {
      await rollbackPreserving(tx, error);
      throw error;
    } finally {
      tx.release();
    }
  }

  public async suspendBeneficiary(
    actor: AdminBeneficiaryActor,
    beneficiaryId: string,
  ): Promise<AdminBeneficiarySuspendResult> {
    const requestId = this.generateId();
    const timestamp = validNow(this.now());
    const tx = await this.sql.connect();
    try {
      await tx.query("begin");
      const row = await lockBeneficiary(tx, actor.organizationId, beneficiaryId);
      if (!row) {
        await tx.query("rollback");
        return { outcome: "NOT_FOUND", requestId };
      }
      if (row.status === "DISABLED") {
        await tx.query("rollback");
        return { outcome: "CONFLICT", requestId };
      }
      if (row.status === "SUSPENDED") {
        await tx.query("rollback");
        return {
          outcome: "REPLAYED",
          requestId,
          beneficiary: beneficiaryResponse(row),
        };
      }

      const updated = (
        await tx.query<BeneficiaryRow>(
          `update "User"
              set "status" = 'SUSPENDED', "updatedAt" = $3
            where "organizationId" = $1::uuid and "id" = $2::uuid
            returning "id", "organizationId", "email", "status", "createdAt", "updatedAt"`,
          [actor.organizationId, beneficiaryId, timestamp],
        )
      ).rows[0];
      if (!updated) {
        throw new Error("Administrative beneficiary suspension returned no row");
      }

      const beneficiary = beneficiaryResponse(updated);
      const audit = await this.audit.appendInTransaction(tx, {
        requestId,
        organizationId: actor.organizationId,
        principalId: actor.principalId,
        membershipId: actor.membershipId,
        timestamp,
        permission: "beneficiary.suspend",
        action: "beneficiary.suspend",
        resourceType: "beneficiary",
        resourceId: beneficiaryId,
        roles: actor.roles,
        beforeState: beneficiaryAuditState(row),
        afterState: beneficiaryAuditState(updated),
        requestDigest: sha256Base64Url(
          canonicalJson({
            type: "mino.admin.beneficiary.status-transition.v1",
            organizationId: actor.organizationId,
            beneficiaryId,
            targetStatus: "SUSPENDED",
          }),
        ),
      });
      await tx.query("commit");
      return { outcome: "UPDATED", requestId, beneficiary, audit };
    } catch (error) {
      await rollbackPreserving(tx, error);
      throw error;
    } finally {
      tx.release();
    }
  }
}

async function lockBeneficiary(
  tx: AdminAuditSqlTransaction,
  organizationId: string,
  beneficiaryId: string,
): Promise<BeneficiaryRow | undefined> {
  return (
    await tx.query<BeneficiaryRow>(
      `select "id", "organizationId", "email", "status", "createdAt", "updatedAt"
         from "User"
        where "organizationId" = $1::uuid and "id" = $2::uuid
        for update`,
      [organizationId, beneficiaryId],
    )
  ).rows[0];
}

function beneficiaryResponse(row: BeneficiaryRow): AdminBeneficiaryDetail {
  return {
    id: row.id,
    organizationId: row.organizationId,
    email: row.email,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function beneficiaryAuditState(row: BeneficiaryRow) {
  return {
    id: row.id,
    email: row.email,
    status: row.status,
  };
}

function normalizeEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length < 3 ||
    normalized.length > 320 ||
    /[\u0000-\u001f\u007f\s]/.test(normalized) ||
    !/^[^@]+@[^@]+\.[^@]+$/.test(normalized)
  ) {
    throw new AdminBeneficiaryValidationError("email is invalid");
  }
  return normalized;
}

function validNow(value: Date): Date {
  if (!Number.isFinite(value.getTime())) {
    throw new Error("Administrative beneficiary clock returned an invalid timestamp");
  }
  return value;
}

async function rollbackPreserving(tx: AdminAuditSqlTransaction, original: unknown): Promise<void> {
  try {
    await tx.query("rollback");
  } catch {
    // Preserve the original mutation/audit failure.
  }
  if (original instanceof Error) return;
}

export class AdminBeneficiaryValidationError extends Error {}
