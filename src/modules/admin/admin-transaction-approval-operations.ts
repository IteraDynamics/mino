import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import {
  canonicalJson,
  sha256Base64Url,
} from "../../infrastructure/crypto/canonical-json.js";
import type {
  AdminAuditAppendResult,
  AdminAuditSqlClient,
  AdminAuditSqlExecutor,
  PostgresAdminChangeAuditLedger,
} from "./admin-change-audit-ledger.js";
import type { AdminRole } from "./admin-authorizer.js";

export const ADMIN_APPROVAL_STATUSES = ["PENDING", "APPROVED", "REJECTED", "EXPIRED"] as const;
export type AdminApprovalStatus = (typeof ADMIN_APPROVAL_STATUSES)[number];
export const ADMIN_PAYMENT_STATUSES = [
  "FORWARDING",
  "UNKNOWN",
  "SUCCEEDED",
  "FAILED_DEFINITIVE",
] as const;
export type AdminPaymentStatus = (typeof ADMIN_PAYMENT_STATUSES)[number];
export type AdminApprovalVoteDecision = "APPROVE" | "REJECT";

export interface AdminTransactionApprovalActor {
  readonly principalId: string;
  readonly membershipId: string;
  readonly organizationId: string;
  readonly roles: readonly AdminRole[];
}

export interface AdminApprovalFilter {
  readonly limit?: number;
  readonly cursor?: string;
  readonly status?: AdminApprovalStatus;
  readonly userId?: string;
  readonly agentId?: string;
  readonly mandateId?: string;
  readonly merchantId?: string;
  readonly createdAfter?: string;
  readonly createdBefore?: string;
}

export interface AdminPaymentFilter {
  readonly limit?: number;
  readonly cursor?: string;
  readonly status?: AdminPaymentStatus;
  readonly userId?: string;
  readonly agentId?: string;
  readonly mandateId?: string;
  readonly merchantId?: string;
  readonly checkoutSessionId?: string;
  readonly createdAfter?: string;
  readonly createdBefore?: string;
}

export interface AdminApprovalVoteProjection {
  readonly identity:
    | { readonly type: "ADMIN_PRINCIPAL"; readonly principalId: string }
    | { readonly type: "APPROVAL_BRIDGE"; readonly approverId: string };
  readonly decision: AdminApprovalVoteDecision;
  readonly createdAt: string;
  readonly comment?: string;
}

export interface AdminApprovalProjection {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly mandateId: string;
  readonly decisionId: string;
  readonly requestId: string;
  readonly policyVersion: number;
  readonly merchantId: string;
  readonly merchantDomain: string;
  readonly checkoutSessionId?: string;
  readonly reasonCodes: readonly string[];
  readonly amountMinor: string;
  readonly currency: string;
  readonly status: AdminApprovalStatus;
  readonly requiredSignatures: number;
  readonly voteCount: number;
  readonly approveCount: number;
  readonly rejectCount: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly resolvedAt?: string;
  readonly votes?: readonly AdminApprovalVoteProjection[];
}

export interface AdminPaymentProjection {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly mandateId: string;
  readonly reservationId: string;
  readonly merchantId: string;
  readonly merchantDomain: string;
  readonly checkoutSessionId: string;
  readonly amountMinor: string;
  readonly currency: string;
  readonly status: AdminPaymentStatus;
  readonly reconciliationState: "FORWARDING" | "PENDING" | "RESOLVED";
  readonly upstreamStatus?: number;
  readonly lastErrorCode?: string;
  readonly reconcileAttempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly forwardedAt?: string;
  readonly resolvedAt?: string;
  readonly lastReconciledAt?: string;
  readonly nextReconcileAt?: string;
}

export interface AdminPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export interface AdminApprovalVoteRequest {
  readonly decision: AdminApprovalVoteDecision;
  readonly comment?: string;
}

export type AdminApprovalVoteResult =
  | {
      readonly outcome: "UPDATED";
      readonly requestId: string;
      readonly approval: AdminApprovalProjection;
      readonly audit: AdminAuditAppendResult;
    }
  | {
      readonly outcome: "REPLAYED";
      readonly requestId: string;
      readonly approval: AdminApprovalProjection;
    }
  | {
      readonly outcome: "NOT_FOUND";
      readonly requestId: string;
    }
  | {
      readonly outcome: "CONFLICT";
      readonly requestId: string;
    }
  | {
      readonly outcome: "ALREADY_RESOLVED";
      readonly requestId: string;
      readonly approval: AdminApprovalProjection;
    };

interface ApprovalRow extends QueryResultRow {
  id: string;
  organizationId: string;
  userId: string;
  agentId: string;
  mandateId: string;
  decisionId: string;
  requestId: string;
  policyVersion: number;
  merchantId: string;
  merchantDomain: string;
  checkoutSessionId: string | null;
  reasonCodes: string[];
  amountMinor: string;
  currency: string;
  persistedStatus: AdminApprovalStatus;
  effectiveStatus: AdminApprovalStatus;
  requiredSignatures: number;
  createdAt: Date;
  expiresAt: Date;
  resolvedAt: Date | null;
  voteCount: number;
  approveCount: number;
  rejectCount: number;
}

interface ApprovalLockRow extends QueryResultRow {
  id: string;
  organizationId: string;
  status: AdminApprovalStatus;
  requiredSignatures: number;
  expiresAt: Date;
  resolvedAt: Date | null;
}

interface ApprovalVoteRow extends QueryResultRow {
  approverId: string;
  decision: AdminApprovalVoteDecision;
  comment: string | null;
  createdAt: Date;
}

interface CountRow extends QueryResultRow {
  count: number;
}

interface PaymentRow extends QueryResultRow {
  id: string;
  organizationId: string;
  userId: string;
  agentId: string;
  mandateId: string;
  reservationId: string;
  merchantId: string;
  merchantDomain: string;
  checkoutSessionId: string;
  amountMinor: string;
  currency: string;
  status: AdminPaymentStatus;
  upstreamStatus: number | null;
  lastErrorCode: string | null;
  reconcileAttempts: number;
  createdAt: Date;
  updatedAt: Date;
  forwardedAt: Date | null;
  resolvedAt: Date | null;
  lastReconciledAt: Date | null;
  nextReconcileAt: Date | null;
}

interface CursorPayload {
  readonly createdAt: string;
  readonly id: string;
}

const ADMIN_APPROVER_PREFIX = "admin-principal:";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class AdminTransactionApprovalValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AdminTransactionApprovalValidationError";
  }
}

export class PostgresAdminTransactionApprovalOperations {
  public constructor(
    private readonly sql: AdminAuditSqlClient,
    private readonly audit: Pick<PostgresAdminChangeAuditLedger, "appendInTransaction">,
    private readonly generateId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async listApprovals(
    organizationId: string,
    filter: AdminApprovalFilter = {},
  ): Promise<AdminPage<AdminApprovalProjection>> {
    requireUuid(organizationId, "organizationId");
    const at = validNow(this.now());
    const limit = normalizeLimit(filter.limit);
    const cursor = filter.cursor ? decodeCursor(filter.cursor) : undefined;
    const values: unknown[] = [organizationId, at];
    const where = [`a."organizationId" = $1::uuid`];
    const effectiveStatus = approvalStatusExpression("a", "$2");

    if (filter.status) {
      requireApprovalStatus(filter.status);
      values.push(filter.status);
      where.push(`${effectiveStatus} = $${values.length}`);
    }
    appendUuidFilter(where, values, `a."userId"`, filter.userId, "userId");
    appendUuidFilter(where, values, `a."agentId"`, filter.agentId, "agentId");
    appendUuidFilter(where, values, `a."mandateId"`, filter.mandateId, "mandateId");
    appendTextFilter(where, values, `a."merchantId"`, filter.merchantId, "merchantId");
    appendDateBounds(where, values, "a", filter.createdAfter, filter.createdBefore);
    appendCursor(where, values, "a", cursor);
    values.push(limit + 1);

    const result = await this.sql.query<ApprovalRow>(
      `select
         a."id", a."organizationId", a."userId", a."agentId", a."mandateId",
         a."decisionId", a."requestId", a."policyVersion", a."merchantId",
         a."merchantDomain", a."checkoutSessionId", a."reasonCodes",
         a."amountMinor"::text as "amountMinor", a."currency",
         a."status"::text as "persistedStatus",
         ${effectiveStatus} as "effectiveStatus",
         a."requiredSignatures", a."createdAt", a."expiresAt", a."resolvedAt",
         (select count(*)::int from "ApprovalVote" v where v."approvalRequestId" = a."id") as "voteCount",
         (select count(*)::int from "ApprovalVote" v where v."approvalRequestId" = a."id" and v."decision" = 'APPROVE') as "approveCount",
         (select count(*)::int from "ApprovalVote" v where v."approvalRequestId" = a."id" and v."decision" = 'REJECT') as "rejectCount"
       from "ApprovalRequest" a
       where ${where.join(" and ")}
       order by a."createdAt" desc, a."id" desc
       limit $${values.length}::int`,
      values,
    );

    return page(result.rows, limit, approvalProjection);
  }

  public async getApproval(
    organizationId: string,
    approvalRequestId: string,
  ): Promise<AdminApprovalProjection | undefined> {
    requireUuid(organizationId, "organizationId");
    requireUuid(approvalRequestId, "approvalRequestId");
    return this.getApprovalWithClient(this.sql, organizationId, approvalRequestId, validNow(this.now()));
  }

  public async listPayments(
    organizationId: string,
    filter: AdminPaymentFilter = {},
  ): Promise<AdminPage<AdminPaymentProjection>> {
    requireUuid(organizationId, "organizationId");
    const limit = normalizeLimit(filter.limit);
    const cursor = filter.cursor ? decodeCursor(filter.cursor) : undefined;
    const values: unknown[] = [organizationId];
    const where = [`p."organizationId" = $1::uuid`];

    if (filter.status) {
      requirePaymentStatus(filter.status);
      values.push(filter.status);
      where.push(`p."status"::text = $${values.length}`);
    }
    appendUuidFilter(where, values, `p."userId"`, filter.userId, "userId");
    appendUuidFilter(where, values, `p."agentId"`, filter.agentId, "agentId");
    appendUuidFilter(where, values, `p."mandateId"`, filter.mandateId, "mandateId");
    appendTextFilter(where, values, `p."merchantId"`, filter.merchantId, "merchantId");
    appendTextFilter(
      where,
      values,
      `p."checkoutSessionId"`,
      filter.checkoutSessionId,
      "checkoutSessionId",
    );
    appendDateBounds(where, values, "p", filter.createdAfter, filter.createdBefore);
    appendCursor(where, values, "p", cursor);
    values.push(limit + 1);

    const result = await this.sql.query<PaymentRow>(
      `select
         p."id", p."organizationId", p."userId", p."agentId", p."mandateId",
         p."reservationId", p."merchantId", p."merchantDomain", p."checkoutSessionId",
         p."amountMinor"::text as "amountMinor", p."currency", p."status"::text as "status",
         p."upstreamStatus", p."lastErrorCode", p."reconcileAttempts",
         p."createdAt", p."updatedAt", p."forwardedAt", p."resolvedAt",
         p."lastReconciledAt", p."nextReconcileAt"
       from "PaymentOutcome" p
       where ${where.join(" and ")}
       order by p."createdAt" desc, p."id" desc
       limit $${values.length}::int`,
      values,
    );

    return page(result.rows, limit, paymentProjection);
  }

  public async getPayment(
    organizationId: string,
    paymentOutcomeId: string,
  ): Promise<AdminPaymentProjection | undefined> {
    requireUuid(organizationId, "organizationId");
    requireUuid(paymentOutcomeId, "paymentOutcomeId");
    const row = (
      await this.sql.query<PaymentRow>(
        `select
           p."id", p."organizationId", p."userId", p."agentId", p."mandateId",
           p."reservationId", p."merchantId", p."merchantDomain", p."checkoutSessionId",
           p."amountMinor"::text as "amountMinor", p."currency", p."status"::text as "status",
           p."upstreamStatus", p."lastErrorCode", p."reconcileAttempts",
           p."createdAt", p."updatedAt", p."forwardedAt", p."resolvedAt",
           p."lastReconciledAt", p."nextReconcileAt"
         from "PaymentOutcome" p
         where p."organizationId" = $1::uuid and p."id" = $2::uuid`,
        [organizationId, paymentOutcomeId],
      )
    ).rows[0];
    return row ? paymentProjection(row) : undefined;
  }

  public async castApprovalVote(
    actor: AdminTransactionApprovalActor,
    approvalRequestId: string,
    request: AdminApprovalVoteRequest,
  ): Promise<AdminApprovalVoteResult> {
    requireUuid(actor.organizationId, "organizationId");
    requireUuid(actor.principalId, "principalId");
    requireUuid(actor.membershipId, "membershipId");
    requireUuid(approvalRequestId, "approvalRequestId");
    const decision = requireVoteDecision(request.decision);
    const comment = normalizeComment(request.comment);
    const timestamp = validNow(this.now());
    const requestId = this.generateId();
    const approverId = `${ADMIN_APPROVER_PREFIX}${actor.principalId}`;
    const tx = await this.sql.connect();
    let committed = false;

    try {
      await tx.query("begin");
      const locked = (
        await tx.query<ApprovalLockRow>(
          `select "id", "organizationId", "status"::text as "status", "requiredSignatures",
                  "expiresAt", "resolvedAt"
             from "ApprovalRequest"
            where "organizationId" = $1::uuid and "id" = $2::uuid
            for update`,
          [actor.organizationId, approvalRequestId],
        )
      ).rows[0];
      if (!locked) {
        await tx.query("rollback");
        committed = true;
        return { outcome: "NOT_FOUND", requestId };
      }

      if (locked.status === "PENDING" && timestamp >= locked.expiresAt) {
        await tx.query(
          `update "ApprovalRequest"
              set "status" = 'EXPIRED', "resolvedAt" = coalesce("resolvedAt", $3)
            where "organizationId" = $1::uuid and "id" = $2::uuid`,
          [actor.organizationId, approvalRequestId, timestamp],
        );
        const approval = await this.getApprovalWithClient(
          tx,
          actor.organizationId,
          approvalRequestId,
          timestamp,
        );
        if (!approval) {
          throw new Error("Expired approval could not be reloaded");
        }
        await tx.query("commit");
        committed = true;
        return { outcome: "ALREADY_RESOLVED", requestId, approval };
      }

      const existingVote = (
        await tx.query<ApprovalVoteRow>(
          `select "approverId", "decision"::text as "decision", "comment", "createdAt"
             from "ApprovalVote"
            where "approvalRequestId" = $1::uuid and "approverId" = $2`,
          [approvalRequestId, approverId],
        )
      ).rows[0];
      if (existingVote) {
        const approval = await this.getApprovalWithClient(
          tx,
          actor.organizationId,
          approvalRequestId,
          timestamp,
        );
        if (!approval) {
          throw new Error("Approval vote replay could not be reloaded");
        }
        await tx.query("rollback");
        committed = true;
        if (existingVote.decision !== decision) {
          return { outcome: "CONFLICT", requestId };
        }
        return { outcome: "REPLAYED", requestId, approval };
      }

      if (locked.status !== "PENDING") {
        const approval = await this.getApprovalWithClient(
          tx,
          actor.organizationId,
          approvalRequestId,
          timestamp,
        );
        if (!approval) {
          throw new Error("Resolved approval could not be reloaded");
        }
        await tx.query("rollback");
        committed = true;
        return { outcome: "ALREADY_RESOLVED", requestId, approval };
      }

      const beforeVotes = await loadVotes(tx, approvalRequestId);
      await tx.query(
        `insert into "ApprovalVote" (
           "id", "approvalRequestId", "approverId", "decision", "comment", "metadata", "createdAt"
         ) values (
           gen_random_uuid(), $1::uuid, $2, $3::"ApprovalVoteDecision", $4, $5::jsonb, $6
         )`,
        [
          approvalRequestId,
          approverId,
          decision,
          comment ?? null,
          JSON.stringify({
            source: "ADMIN_JWT",
            principalId: actor.principalId,
            membershipId: actor.membershipId,
          }),
          timestamp,
        ],
      );

      if (decision === "REJECT") {
        await tx.query(
          `update "ApprovalRequest"
              set "status" = 'REJECTED', "resolvedAt" = coalesce("resolvedAt", $3)
            where "organizationId" = $1::uuid and "id" = $2::uuid`,
          [actor.organizationId, approvalRequestId, timestamp],
        );
      } else {
        const approveCount = (
          await tx.query<CountRow>(
            `select count(*)::int as "count"
               from "ApprovalVote"
              where "approvalRequestId" = $1::uuid and "decision" = 'APPROVE'`,
            [approvalRequestId],
          )
        ).rows[0]?.count ?? 0;
        if (approveCount >= locked.requiredSignatures) {
          await tx.query(
            `update "ApprovalRequest"
                set "status" = 'APPROVED', "resolvedAt" = coalesce("resolvedAt", $3)
              where "organizationId" = $1::uuid and "id" = $2::uuid`,
            [actor.organizationId, approvalRequestId, timestamp],
          );
        }
      }

      const approval = await this.getApprovalWithClient(
        tx,
        actor.organizationId,
        approvalRequestId,
        timestamp,
      );
      if (!approval) {
        throw new Error("Updated approval could not be reloaded");
      }
      const audit = await this.audit.appendInTransaction(tx, {
        requestId,
        organizationId: actor.organizationId,
        principalId: actor.principalId,
        membershipId: actor.membershipId,
        timestamp,
        permission: "approval.vote",
        action: "approval.vote",
        resourceType: "approval_request",
        resourceId: approvalRequestId,
        roles: actor.roles,
        beforeState: approvalAuditState(locked.status, locked.requiredSignatures, beforeVotes),
        afterState: approvalAuditProjection(approval),
        requestDigest: sha256Base64Url(
          canonicalJson({
            organizationId: actor.organizationId,
            approvalRequestId,
            principalId: actor.principalId,
            decision,
            comment: comment ?? null,
          }),
        ),
        metadata: { decision },
      });
      await tx.query("commit");
      committed = true;
      return { outcome: "UPDATED", requestId, approval, audit };
    } catch (error) {
      if (!committed) {
        try {
          await tx.query("rollback");
        } catch {
          // Preserve the original failure.
        }
      }
      throw error;
    } finally {
      tx.release();
    }
  }

  private async getApprovalWithClient(
    client: AdminAuditSqlExecutor,
    organizationId: string,
    approvalRequestId: string,
    at: Date,
  ): Promise<AdminApprovalProjection | undefined> {
    const effectiveStatus = approvalStatusExpression("a", "$3");
    const row = (
      await client.query<ApprovalRow>(
        `select
           a."id", a."organizationId", a."userId", a."agentId", a."mandateId",
           a."decisionId", a."requestId", a."policyVersion", a."merchantId",
           a."merchantDomain", a."checkoutSessionId", a."reasonCodes",
           a."amountMinor"::text as "amountMinor", a."currency",
           a."status"::text as "persistedStatus",
           ${effectiveStatus} as "effectiveStatus",
           a."requiredSignatures", a."createdAt", a."expiresAt", a."resolvedAt",
           (select count(*)::int from "ApprovalVote" v where v."approvalRequestId" = a."id") as "voteCount",
           (select count(*)::int from "ApprovalVote" v where v."approvalRequestId" = a."id" and v."decision" = 'APPROVE') as "approveCount",
           (select count(*)::int from "ApprovalVote" v where v."approvalRequestId" = a."id" and v."decision" = 'REJECT') as "rejectCount"
         from "ApprovalRequest" a
         where a."organizationId" = $1::uuid and a."id" = $2::uuid`,
        [organizationId, approvalRequestId, at],
      )
    ).rows[0];
    if (!row) {
      return undefined;
    }
    return {
      ...approvalProjection(row),
      votes: (await loadVotes(client, approvalRequestId)).map(voteProjection),
    };
  }
}

function approvalStatusExpression(alias: string, nowParameter: string): string {
  return `case when ${alias}."status" = 'PENDING' and ${alias}."expiresAt" <= ${nowParameter} then 'EXPIRED' else ${alias}."status"::text end`;
}

function appendUuidFilter(
  where: string[],
  values: unknown[],
  column: string,
  value: string | undefined,
  label: string,
): void {
  if (!value) {
    return;
  }
  requireUuid(value, label);
  values.push(value);
  where.push(`${column} = $${values.length}::uuid`);
}

function appendTextFilter(
  where: string[],
  values: unknown[],
  column: string,
  value: string | undefined,
  label: string,
): void {
  if (value === undefined) {
    return;
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new AdminTransactionApprovalValidationError(`${label} is invalid`);
  }
  values.push(normalized);
  where.push(`${column} = $${values.length}`);
}

function appendDateBounds(
  where: string[],
  values: unknown[],
  alias: string,
  createdAfter: string | undefined,
  createdBefore: string | undefined,
): void {
  const after = createdAfter ? parseDate(createdAfter, "createdAfter") : undefined;
  const before = createdBefore ? parseDate(createdBefore, "createdBefore") : undefined;
  if (after && before && after >= before) {
    throw new AdminTransactionApprovalValidationError("createdAfter must be before createdBefore");
  }
  if (after) {
    values.push(after);
    where.push(`${alias}."createdAt" >= $${values.length}`);
  }
  if (before) {
    values.push(before);
    where.push(`${alias}."createdAt" < $${values.length}`);
  }
}

function appendCursor(
  where: string[],
  values: unknown[],
  alias: string,
  cursor: CursorPayload | undefined,
): void {
  if (!cursor) {
    return;
  }
  values.push(new Date(cursor.createdAt));
  const createdParameter = values.length;
  values.push(cursor.id);
  const idParameter = values.length;
  where.push(
    `(${alias}."createdAt", ${alias}."id") < ($${createdParameter}::timestamptz, $${idParameter}::uuid)`,
  );
}

function normalizeLimit(value: number | undefined): number {
  const limit = value ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new AdminTransactionApprovalValidationError("limit must be between 1 and 100");
  }
  return limit;
}

function parseDate(value: string, label: string): Date {
  const parsed = new Date(value);
  if (!value || !Number.isFinite(parsed.getTime())) {
    throw new AdminTransactionApprovalValidationError(`${label} must be a valid timestamp`);
  }
  return parsed;
}

function validNow(value: Date): Date {
  if (!Number.isFinite(value.getTime())) {
    throw new AdminTransactionApprovalValidationError("clock returned an invalid timestamp");
  }
  return value;
}

function requireUuid(value: string, label: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new AdminTransactionApprovalValidationError(`${label} must be a UUID`);
  }
  return value;
}

function requireApprovalStatus(value: string): AdminApprovalStatus {
  if (!(ADMIN_APPROVAL_STATUSES as readonly string[]).includes(value)) {
    throw new AdminTransactionApprovalValidationError("approval status is invalid");
  }
  return value as AdminApprovalStatus;
}

function requirePaymentStatus(value: string): AdminPaymentStatus {
  if (!(ADMIN_PAYMENT_STATUSES as readonly string[]).includes(value)) {
    throw new AdminTransactionApprovalValidationError("payment status is invalid");
  }
  return value as AdminPaymentStatus;
}

function requireVoteDecision(value: string): AdminApprovalVoteDecision {
  if (value !== "APPROVE" && value !== "REJECT") {
    throw new AdminTransactionApprovalValidationError("approval vote decision is invalid");
  }
  return value;
}

function normalizeComment(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const comment = value.trim();
  if (!comment) {
    return undefined;
  }
  if (comment.length > 1000 || /\u0000/.test(comment)) {
    throw new AdminTransactionApprovalValidationError("approval vote comment is invalid");
  }
  return comment;
}

function encodeCursor(row: { readonly createdAt: Date; readonly id: string }): string {
  return Buffer.from(
    canonicalJson({ createdAt: row.createdAt.toISOString(), id: row.id }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(value: string): CursorPayload {
  try {
    if (!value || value.length > 512) {
      throw new Error("invalid cursor");
    }
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid cursor");
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.createdAt !== "string" || typeof record.id !== "string") {
      throw new Error("invalid cursor");
    }
    if (!Number.isFinite(new Date(record.createdAt).getTime()) || !UUID_PATTERN.test(record.id)) {
      throw new Error("invalid cursor");
    }
    return { createdAt: record.createdAt, id: record.id };
  } catch {
    throw new AdminTransactionApprovalValidationError("cursor is invalid");
  }
}

function page<Row extends { readonly createdAt: Date; readonly id: string }, Projection>(
  rows: readonly Row[],
  limit: number,
  project: (row: Row) => Projection,
): AdminPage<Projection> {
  const visible = rows.slice(0, limit);
  const next = rows.length > limit ? visible[visible.length - 1] : undefined;
  return {
    items: visible.map(project),
    ...(next ? { nextCursor: encodeCursor(next) } : {}),
  };
}

function approvalProjection(row: ApprovalRow): AdminApprovalProjection {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    agentId: row.agentId,
    mandateId: row.mandateId,
    decisionId: row.decisionId,
    requestId: row.requestId,
    policyVersion: row.policyVersion,
    merchantId: row.merchantId,
    merchantDomain: row.merchantDomain,
    ...(row.checkoutSessionId ? { checkoutSessionId: row.checkoutSessionId } : {}),
    reasonCodes: [...row.reasonCodes],
    amountMinor: row.amountMinor,
    currency: row.currency,
    status: row.effectiveStatus,
    requiredSignatures: row.requiredSignatures,
    voteCount: row.voteCount,
    approveCount: row.approveCount,
    rejectCount: row.rejectCount,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    ...(row.resolvedAt ? { resolvedAt: row.resolvedAt.toISOString() } : {}),
  };
}

function paymentProjection(row: PaymentRow): AdminPaymentProjection {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    agentId: row.agentId,
    mandateId: row.mandateId,
    reservationId: row.reservationId,
    merchantId: row.merchantId,
    merchantDomain: row.merchantDomain,
    checkoutSessionId: row.checkoutSessionId,
    amountMinor: row.amountMinor,
    currency: row.currency,
    status: row.status,
    reconciliationState:
      row.status === "SUCCEEDED" || row.status === "FAILED_DEFINITIVE"
        ? "RESOLVED"
        : row.status === "UNKNOWN"
          ? "PENDING"
          : "FORWARDING",
    ...(row.upstreamStatus !== null ? { upstreamStatus: row.upstreamStatus } : {}),
    ...(row.lastErrorCode ? { lastErrorCode: row.lastErrorCode } : {}),
    reconcileAttempts: row.reconcileAttempts,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.forwardedAt ? { forwardedAt: row.forwardedAt.toISOString() } : {}),
    ...(row.resolvedAt ? { resolvedAt: row.resolvedAt.toISOString() } : {}),
    ...(row.lastReconciledAt ? { lastReconciledAt: row.lastReconciledAt.toISOString() } : {}),
    ...(row.nextReconcileAt ? { nextReconcileAt: row.nextReconcileAt.toISOString() } : {}),
  };
}

async function loadVotes(
  client: AdminAuditSqlExecutor,
  approvalRequestId: string,
): Promise<ApprovalVoteRow[]> {
  return (
    await client.query<ApprovalVoteRow>(
      `select "approverId", "decision"::text as "decision", "comment", "createdAt"
         from "ApprovalVote"
        where "approvalRequestId" = $1::uuid
        order by "createdAt" asc, "id" asc`,
      [approvalRequestId],
    )
  ).rows;
}

function voteProjection(row: ApprovalVoteRow): AdminApprovalVoteProjection {
  const identity = row.approverId.startsWith(ADMIN_APPROVER_PREFIX)
    ? {
        type: "ADMIN_PRINCIPAL" as const,
        principalId: row.approverId.slice(ADMIN_APPROVER_PREFIX.length),
      }
    : { type: "APPROVAL_BRIDGE" as const, approverId: row.approverId };
  return {
    identity,
    decision: row.decision,
    createdAt: row.createdAt.toISOString(),
    ...(row.comment ? { comment: row.comment } : {}),
  };
}

function approvalAuditState(
  status: AdminApprovalStatus,
  requiredSignatures: number,
  votes: readonly ApprovalVoteRow[],
): Record<string, unknown> {
  return {
    status,
    requiredSignatures,
    voteCount: votes.length,
    approveCount: votes.filter((vote) => vote.decision === "APPROVE").length,
    rejectCount: votes.filter((vote) => vote.decision === "REJECT").length,
  };
}

function approvalAuditProjection(approval: AdminApprovalProjection): Record<string, unknown> {
  return {
    approvalRequestId: approval.id,
    status: approval.status,
    requiredSignatures: approval.requiredSignatures,
    voteCount: approval.voteCount,
    approveCount: approval.approveCount,
    rejectCount: approval.rejectCount,
    resolvedAt: approval.resolvedAt ?? null,
  };
}
