import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  sha256Base64Url,
  sha256Hex,
} from "../../infrastructure/crypto/canonical-json.js";
import type {
  MandateSigningKey,
  MandateTokenService,
} from "../mandates/mandate-token.service.js";
import type {
  AdminAuditAppendResult,
  AdminAuditSqlClient,
  PostgresAdminChangeAuditLedger,
} from "./admin-change-audit-ledger.js";
import type { AdminRole } from "./admin-authorizer.js";

export type AdminMandateStatus = "ACTIVE" | "REVOKED" | "EXPIRED";
export type AdminMandateApprovalMode =
  | "AUTO_APPROVE"
  | "DUAL_SIGNATURE_SLACK"
  | "HARD_BLOCK";

export interface AdminMandateActor {
  readonly principalId: string;
  readonly membershipId: string;
  readonly organizationId: string;
  readonly roles: readonly AdminRole[];
}

export interface AdminMandateIssueRequest {
  readonly userId: string;
  readonly agentId: string;
  readonly policyId: string;
  readonly expiresAt: string;
  readonly idempotencyKey: string;
}

export interface AdminMandateDetail {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly currency: string;
  readonly maxBudgetMinor: string;
  readonly rollingDailyLimitMinor: string;
  readonly approvedMerchantDomains: readonly string[];
  readonly approvedVendorIds: readonly string[];
  readonly restrictedCategories: readonly string[];
  readonly approvalMode: AdminMandateApprovalMode;
  readonly maxTransactionsPerMinute: number;
  readonly crossMerchantWindowSecs: number;
  readonly maxDistinctMerchants: number;
  readonly status: AdminMandateStatus;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revokedAt?: string;
  readonly signingKeyId: string;
  readonly tokenJtiHash: string;
}

export type AdminMandateIssueResult =
  | {
      readonly outcome: "CREATED";
      readonly requestId: string;
      readonly mandate: AdminMandateDetail;
      readonly mandateToken: string;
      readonly audit: AdminAuditAppendResult;
    }
  | {
      readonly outcome: "REPLAYED";
      readonly requestId: string;
      readonly mandate: AdminMandateDetail;
    }
  | {
      readonly outcome: "CONFLICT";
      readonly requestId: string;
    }
  | {
      readonly outcome: "INVALID_TARGET";
      readonly requestId: string;
    };

export type AdminMandateRevokeResult =
  | {
      readonly outcome: "UPDATED";
      readonly requestId: string;
      readonly mandate: AdminMandateDetail;
      readonly audit: AdminAuditAppendResult;
    }
  | {
      readonly outcome: "REPLAYED";
      readonly requestId: string;
      readonly mandate: AdminMandateDetail;
    }
  | {
      readonly outcome: "NOT_FOUND";
      readonly requestId: string;
    };

interface UserRow {
  id: string;
  status: "ACTIVE" | "SUSPENDED" | "DISABLED";
}

interface AgentRow {
  id: string;
  status: "ACTIVE" | "SUSPENDED" | "REVOKED";
  publicKey: string | null;
  keyId: string | null;
}

interface PolicyRow {
  id: string;
  organizationId: string;
  version: number;
  active: boolean;
  baseCurrency: string;
  maxBudgetMinor: string;
  rollingDailyLimitMinor: string;
  approvedMerchantDomains: string[];
  approvedVendorIds: string[];
  restrictedCategories: string[];
  approvalMode: AdminMandateApprovalMode;
  maxTransactionsPerMinute: number;
  crossMerchantWindowSecs: number;
  maxDistinctMerchants: number;
}

interface MandateRow {
  id: string;
  organizationId: string;
  userId: string;
  agentId: string;
  policyId: string;
  issuanceKeyHash: string | null;
  tokenJtiHash: string;
  policyVersion: number;
  currency: string;
  maxBudgetMinor: string;
  rollingDailyLimitMinor: string;
  approvedMerchantDomains: string[];
  approvedVendorIds: string[];
  restrictedCategories: string[];
  approvalMode: AdminMandateApprovalMode;
  maxTransactionsPerMinute: number;
  crossMerchantWindowSecs: number;
  maxDistinctMerchants: number;
  delegationPayloadHash: string;
  signingKeyId: string;
  status: AdminMandateStatus;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

const MANDATE_COLUMNS = `"id", "organizationId", "userId", "agentId", "policyId",
  "issuanceKeyHash", "tokenJtiHash", "policyVersion", "currency",
  "maxBudgetMinor", "rollingDailyLimitMinor", "approvedMerchantDomains",
  "approvedVendorIds", "restrictedCategories", "approvalMode",
  "maxTransactionsPerMinute", "crossMerchantWindowSecs", "maxDistinctMerchants",
  "delegationPayloadHash", "signingKeyId", "status", "issuedAt", "expiresAt", "revokedAt"`;

const POLICY_COLUMNS = `"id", "organizationId", "version", "active", "baseCurrency",
  "maxBudgetMinor", "rollingDailyLimitMinor", "approvedMerchantDomains",
  "approvedVendorIds", "restrictedCategories", "approvalMode",
  "maxTransactionsPerMinute", "crossMerchantWindowSecs", "maxDistinctMerchants"`;

export class AdminMandateValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AdminMandateValidationError";
  }
}

export class PostgresAdminMandateManagementService {
  public constructor(
    private readonly sql: AdminAuditSqlClient,
    private readonly audit: Pick<PostgresAdminChangeAuditLedger, "appendInTransaction">,
    private readonly mandateTokens: Pick<MandateTokenService, "issue">,
    private readonly signingKey: MandateSigningKey,
    private readonly issuer: string,
    private readonly generateId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async getMandate(
    organizationId: string,
    mandateId: string,
  ): Promise<AdminMandateDetail | undefined> {
    const client = await this.sql.connect();
    try {
      const row = (
        await client.query<MandateRow>(
          `select ${MANDATE_COLUMNS}
             from "AgentMandate"
            where "organizationId" = $1::uuid and "id" = $2::uuid`,
          [organizationId, mandateId],
        )
      ).rows[0];
      return row ? mandateResponse(row) : undefined;
    } finally {
      client.release();
    }
  }

  public async issue(
    actor: AdminMandateActor,
    request: AdminMandateIssueRequest,
  ): Promise<AdminMandateIssueResult> {
    const userId = requireUuidLike(request.userId, "userId");
    const agentId = requireUuidLike(request.agentId, "agentId");
    const policyId = requireUuidLike(request.policyId, "policyId");
    const idempotencyKey = normalizeIdempotencyKey(request.idempotencyKey);
    const timestamp = validNow(this.now());
    const expiresAt = normalizeExpiration(request.expiresAt, timestamp);
    const requestId = this.generateId();
    const issuanceKeyHash = issuanceKeyDigest(actor.organizationId, idempotencyKey);
    const tx = await this.sql.connect();

    try {
      await tx.query("begin");
      await lockOrganization(tx, actor.organizationId);

      const prior = (
        await tx.query<MandateRow>(
          `select ${MANDATE_COLUMNS}
             from "AgentMandate"
            where "organizationId" = $1::uuid and "issuanceKeyHash" = $2
            limit 1`,
          [actor.organizationId, issuanceKeyHash],
        )
      ).rows[0];
      if (prior) {
        await tx.query("rollback");
        if (
          prior.userId === userId &&
          prior.agentId === agentId &&
          prior.policyId === policyId &&
          prior.expiresAt.toISOString() === expiresAt.toISOString()
        ) {
          return { outcome: "REPLAYED", requestId, mandate: mandateResponse(prior) };
        }
        return { outcome: "CONFLICT", requestId };
      }

      const user = (
        await tx.query<UserRow>(
          `select "id", "status"
             from "User"
            where "organizationId" = $1::uuid and "id" = $2::uuid
            for share`,
          [actor.organizationId, userId],
        )
      ).rows[0];
      const agent = (
        await tx.query<AgentRow>(
          `select "id", "status", "publicKey", "keyId"
             from "AgentIdentity"
            where "organizationId" = $1::uuid and "id" = $2::uuid
            for share`,
          [actor.organizationId, agentId],
        )
      ).rows[0];
      const policy = (
        await tx.query<PolicyRow>(
          `select ${POLICY_COLUMNS}
             from "Policy"
            where "organizationId" = $1::uuid and "id" = $2::uuid
            for share`,
          [actor.organizationId, policyId],
        )
      ).rows[0];

      if (
        !user ||
        user.status !== "ACTIVE" ||
        !agent ||
        agent.status !== "ACTIVE" ||
        !agent.publicKey ||
        !agent.keyId ||
        !policy ||
        !policy.active
      ) {
        await tx.query("rollback");
        return { outcome: "INVALID_TARGET", requestId };
      }

      const mandateId = this.generateId();
      const tokenJti = this.generateId();
      const tokenJtiHash = sha256Hex(tokenJti);
      const authorityDigest = authorityPayloadDigest({
        organizationId: actor.organizationId,
        userId,
        agentId,
        policy,
        expiresAt,
      });
      const issuedAtSeconds = Math.floor(timestamp.getTime() / 1_000);
      const expiresAtSeconds = Math.floor(expiresAt.getTime() / 1_000);
      if (expiresAtSeconds <= issuedAtSeconds) {
        throw new AdminMandateValidationError("expiresAt must allow at least one whole second of authority");
      }

      const mandateToken = this.mandateTokens.issue(
        {
          iss: this.issuer,
          sub: agentId,
          aud: "mino",
          jti: tokenJti,
          organizationId: actor.organizationId,
          userId,
          agentId,
          mandateId,
          policyVersion: policy.version,
          iat: issuedAtSeconds,
          nbf: issuedAtSeconds,
          exp: expiresAtSeconds,
        },
        this.signingKey,
      );

      const inserted = (
        await tx.query<MandateRow>(
          `insert into "AgentMandate" (
             "id", "organizationId", "userId", "agentId", "policyId",
             "issuanceKeyHash", "tokenJtiHash", "policyVersion", "currency",
             "maxBudgetMinor", "rollingDailyLimitMinor", "approvedMerchantDomains",
             "approvedVendorIds", "restrictedCategories", "approvalMode",
             "maxTransactionsPerMinute", "crossMerchantWindowSecs", "maxDistinctMerchants",
             "delegationPayloadHash", "signingKeyId", "status", "issuedAt", "expiresAt"
           ) values (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
             $6, $7, $8, $9,
             $10::bigint, $11::bigint, $12::text[],
             $13::text[], $14::text[], $15::"ApprovalMode",
             $16, $17, $18,
             $19, $20, 'ACTIVE', $21, $22
           )
           returning ${MANDATE_COLUMNS}`,
          [
            mandateId,
            actor.organizationId,
            userId,
            agentId,
            policy.id,
            issuanceKeyHash,
            tokenJtiHash,
            policy.version,
            policy.baseCurrency,
            policy.maxBudgetMinor,
            policy.rollingDailyLimitMinor,
            policy.approvedMerchantDomains,
            policy.approvedVendorIds,
            policy.restrictedCategories,
            policy.approvalMode,
            policy.maxTransactionsPerMinute,
            policy.crossMerchantWindowSecs,
            policy.maxDistinctMerchants,
            authorityDigest,
            this.signingKey.keyId,
            timestamp,
            expiresAt,
          ],
        )
      ).rows[0];
      if (!inserted) {
        throw new Error("Administrative mandate issuance returned no row");
      }

      const mandate = mandateResponse(inserted);
      const audit = await this.audit.appendInTransaction(tx, {
        requestId,
        organizationId: actor.organizationId,
        principalId: actor.principalId,
        membershipId: actor.membershipId,
        timestamp,
        permission: "mandate.issue",
        action: "mandate.issue",
        resourceType: "mandate",
        resourceId: mandate.id,
        roles: actor.roles,
        afterState: mandateAuditState(inserted),
        metadata: {
          policyId: policy.id,
          policyVersion: policy.version,
          issuanceKeyHash,
        },
        requestDigest: sha256Base64Url(
          canonicalJson({
            type: "mino.admin.mandate.issue-request.v1",
            organizationId: actor.organizationId,
            userId,
            agentId,
            policyId,
            expiresAt: expiresAt.toISOString(),
            issuanceKeyHash,
          }),
        ),
      });
      await tx.query("commit");
      return { outcome: "CREATED", requestId, mandate, mandateToken, audit };
    } catch (error) {
      await rollbackPreserving(tx);
      throw error;
    } finally {
      tx.release();
    }
  }

  public async revoke(
    actor: AdminMandateActor,
    mandateId: string,
  ): Promise<AdminMandateRevokeResult> {
    requireUuidLike(mandateId, "mandateId");
    const requestId = this.generateId();
    const timestamp = validNow(this.now());
    const tx = await this.sql.connect();

    try {
      await tx.query("begin");
      const prior = (
        await tx.query<MandateRow>(
          `select ${MANDATE_COLUMNS}
             from "AgentMandate"
            where "organizationId" = $1::uuid and "id" = $2::uuid
            for update`,
          [actor.organizationId, mandateId],
        )
      ).rows[0];
      if (!prior) {
        await tx.query("rollback");
        return { outcome: "NOT_FOUND", requestId };
      }
      if (
        prior.status === "REVOKED" ||
        prior.status === "EXPIRED" ||
        prior.expiresAt.getTime() <= timestamp.getTime()
      ) {
        await tx.query("rollback");
        return { outcome: "REPLAYED", requestId, mandate: mandateResponse(prior) };
      }

      const updated = (
        await tx.query<MandateRow>(
          `update "AgentMandate"
              set "status" = 'REVOKED', "revokedAt" = $3
            where "organizationId" = $1::uuid and "id" = $2::uuid
            returning ${MANDATE_COLUMNS}`,
          [actor.organizationId, mandateId, timestamp],
        )
      ).rows[0];
      if (!updated) {
        throw new Error("Administrative mandate revocation returned no row");
      }

      const mandate = mandateResponse(updated);
      const audit = await this.audit.appendInTransaction(tx, {
        requestId,
        organizationId: actor.organizationId,
        principalId: actor.principalId,
        membershipId: actor.membershipId,
        timestamp,
        permission: "mandate.revoke",
        action: "mandate.revoke",
        resourceType: "mandate",
        resourceId: mandateId,
        roles: actor.roles,
        beforeState: mandateAuditState(prior),
        afterState: mandateAuditState(updated),
        requestDigest: sha256Base64Url(
          canonicalJson({
            type: "mino.admin.mandate.revoke.v1",
            organizationId: actor.organizationId,
            mandateId,
          }),
        ),
      });
      await tx.query("commit");
      return { outcome: "UPDATED", requestId, mandate, audit };
    } catch (error) {
      await rollbackPreserving(tx);
      throw error;
    } finally {
      tx.release();
    }
  }
}

function mandateResponse(row: MandateRow): AdminMandateDetail {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    agentId: row.agentId,
    policyId: row.policyId,
    policyVersion: row.policyVersion,
    currency: row.currency,
    maxBudgetMinor: row.maxBudgetMinor,
    rollingDailyLimitMinor: row.rollingDailyLimitMinor,
    approvedMerchantDomains: row.approvedMerchantDomains,
    approvedVendorIds: row.approvedVendorIds,
    restrictedCategories: row.restrictedCategories,
    approvalMode: row.approvalMode,
    maxTransactionsPerMinute: row.maxTransactionsPerMinute,
    crossMerchantWindowSecs: row.crossMerchantWindowSecs,
    maxDistinctMerchants: row.maxDistinctMerchants,
    status: row.status,
    issuedAt: row.issuedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    ...(row.revokedAt ? { revokedAt: row.revokedAt.toISOString() } : {}),
    signingKeyId: row.signingKeyId,
    tokenJtiHash: row.tokenJtiHash,
  };
}

function mandateAuditState(row: MandateRow) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    agentId: row.agentId,
    policyId: row.policyId,
    policyVersion: row.policyVersion,
    currency: row.currency,
    maxBudgetMinor: row.maxBudgetMinor,
    rollingDailyLimitMinor: row.rollingDailyLimitMinor,
    approvedMerchantDomains: row.approvedMerchantDomains,
    approvedVendorIds: row.approvedVendorIds,
    restrictedCategories: row.restrictedCategories,
    approvalMode: row.approvalMode,
    maxTransactionsPerMinute: row.maxTransactionsPerMinute,
    crossMerchantWindowSecs: row.crossMerchantWindowSecs,
    maxDistinctMerchants: row.maxDistinctMerchants,
    status: row.status,
    issuedAt: row.issuedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    signingKeyId: row.signingKeyId,
    tokenJtiHash: row.tokenJtiHash,
    delegationPayloadHash: row.delegationPayloadHash,
  };
}

function authorityPayloadDigest(input: {
  readonly organizationId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly policy: PolicyRow;
  readonly expiresAt: Date;
}): string {
  const policy = input.policy;
  return sha256Base64Url(
    canonicalJson({
      type: "mino.mandate.authority-snapshot.v1",
      organizationId: input.organizationId,
      userId: input.userId,
      agentId: input.agentId,
      policyId: policy.id,
      policyVersion: policy.version,
      currency: policy.baseCurrency,
      maxBudgetMinor: policy.maxBudgetMinor,
      rollingDailyLimitMinor: policy.rollingDailyLimitMinor,
      approvedMerchantDomains: policy.approvedMerchantDomains,
      approvedVendorIds: policy.approvedVendorIds,
      restrictedCategories: policy.restrictedCategories,
      approvalMode: policy.approvalMode,
      maxTransactionsPerMinute: policy.maxTransactionsPerMinute,
      crossMerchantWindowSecs: policy.crossMerchantWindowSecs,
      maxDistinctMerchants: policy.maxDistinctMerchants,
      expiresAt: input.expiresAt.toISOString(),
    }),
  );
}

function issuanceKeyDigest(organizationId: string, idempotencyKey: string): string {
  return sha256Base64Url(
    canonicalJson({
      type: "mino.admin.mandate.idempotency.v1",
      organizationId,
      idempotencyKey,
    }),
  );
}

function normalizeIdempotencyKey(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new AdminMandateValidationError("idempotencyKey is invalid");
  }
  return value;
}

function normalizeExpiration(value: string, now: Date): Date {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) {
    throw new AdminMandateValidationError("expiresAt is invalid");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= now.getTime()) {
    throw new AdminMandateValidationError("expiresAt must be in the future");
  }
  return parsed;
}

function validNow(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new AdminMandateValidationError("current time is invalid");
  }
  return value;
}

function requireUuidLike(value: string, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new AdminMandateValidationError(`${field} must be a UUID`);
  }
  return value;
}

async function lockOrganization(
  tx: Awaited<ReturnType<AdminAuditSqlClient["connect"]>>,
  organizationId: string,
): Promise<void> {
  const result = await tx.query<{ id: string }>(
    `select "id" from "Organization" where "id" = $1::uuid for update`,
    [organizationId],
  );
  if (result.rowCount !== 1) {
    throw new Error("Administrative mandate organization no longer exists");
  }
}

async function rollbackPreserving(
  tx: Awaited<ReturnType<AdminAuditSqlClient["connect"]>>,
): Promise<void> {
  try {
    await tx.query("rollback");
  } catch {
    // Preserve the original error.
  }
}
