import type { QueryResultRow } from "pg";
import type { AdminPermission } from "./admin-authorizer.js";
import type { AdminAuditSqlExecutor } from "./admin-change-audit-ledger.js";

export const ADMIN_AUDIT_TRANSACTION_VERDICTS = [
  "ALLOW",
  "BLOCK",
  "PENDING_HUMAN_APPROVAL",
] as const;
export type AdminAuditTransactionVerdict =
  (typeof ADMIN_AUDIT_TRANSACTION_VERDICTS)[number];

export interface AdminTransactionAuditFilter {
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
  readonly verdict?: AdminAuditTransactionVerdict | undefined;
  readonly operation?: string | undefined;
  readonly userId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly mandateId?: string | undefined;
  readonly merchantDomain?: string | undefined;
  readonly createdAfter?: string | undefined;
  readonly createdBefore?: string | undefined;
}

export interface AdminChangeAuditFilter {
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
  readonly principalId?: string | undefined;
  readonly permission?: AdminPermission | undefined;
  readonly action?: string | undefined;
  readonly resourceType?: string | undefined;
  readonly resourceId?: string | undefined;
  readonly createdAfter?: string | undefined;
  readonly createdBefore?: string | undefined;
}

export interface AdminTransactionAuditProjection {
  readonly chainSequence: string;
  readonly timestamp: string;
  readonly requestId: string;
  readonly decisionId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly mandateId?: string;
  readonly protocol: string;
  readonly operation: string;
  readonly merchantDomain: string;
  readonly merchantVendorId?: string;
  readonly verdict: AdminAuditTransactionVerdict;
  readonly reasonCodes: readonly string[];
  readonly policyVersion?: number;
  readonly evaluationLatencyMicros: number;
  readonly reservationId?: string;
  readonly upstreamStatus?: number;
  readonly eventDigest: string;
  readonly previousChainDigest?: string;
  readonly chainDigest: string;
  readonly signingKeyId: string;
}

export interface AdminChangeAuditProjection {
  readonly chainSequence: string;
  readonly timestamp: string;
  readonly requestId: string;
  readonly principalId: string;
  readonly membershipId: string;
  readonly permission: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string;
  readonly roles: readonly string[];
  readonly eventDigest: string;
  readonly previousChainDigest?: string;
  readonly chainDigest: string;
  readonly signingKeyId: string;
}

export interface AdminAuditPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export interface AdminOperationalSnapshot {
  readonly capturedAt: string;
  readonly payments: {
    readonly forwarding: number;
    readonly unknown: number;
    readonly succeeded: number;
    readonly failedDefinitive: number;
    readonly unresolved: number;
    readonly claimable: number;
    readonly stale: number;
    readonly highAttempt: number;
    readonly leased: number;
    readonly oldestUnresolvedAgeSeconds: number;
    readonly oldestUnresolvedPaymentId?: string;
  };
  readonly approvals: {
    readonly pending: number;
    readonly approved: number;
    readonly rejected: number;
    readonly expired: number;
    readonly expiredPending: number;
    readonly notificationPending: number;
    readonly notificationLeased: number;
    readonly notificationDelivered: number;
    readonly notificationDeadLetter: number;
    readonly notificationClaimable: number;
    readonly oldestUndeliveredAgeSeconds: number;
  };
  readonly reservations: {
    readonly reserved: number;
    readonly committed: number;
    readonly released: number;
    readonly expired: number;
    readonly overdueReserved: number;
  };
  readonly audit: {
    readonly transaction: AdminAuditHeadProjection;
    readonly administrative: AdminAuditHeadProjection;
  };
}

export interface AdminAuditHeadProjection {
  readonly headSequence: string;
  readonly headDigest?: string;
  readonly updatedAt?: string;
}

interface TransactionAuditRow extends QueryResultRow {
  chainSequence: string;
  timestamp: Date;
  requestId: string;
  decisionId: string;
  userId: string;
  agentId: string;
  mandateId: string | null;
  protocol: string;
  operation: string;
  merchantDomain: string;
  merchantVendorId: string | null;
  verdict: AdminAuditTransactionVerdict;
  reasonCodes: string[];
  policyVersion: number | null;
  evaluationLatencyMicros: number;
  reservationId: string | null;
  upstreamStatus: number | null;
  eventDigest: string;
  previousChainDigest: string | null;
  chainDigest: string;
  signingKeyId: string;
}

interface AdminAuditRow extends QueryResultRow {
  chainSequence: string;
  timestamp: Date;
  requestId: string;
  principalId: string;
  membershipId: string;
  permission: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  roles: string[];
  eventDigest: string;
  previousChainDigest: string | null;
  chainDigest: string;
  signingKeyId: string;
}

interface PaymentOperationalRow extends QueryResultRow {
  forwarding: string;
  unknown: string;
  succeeded: string;
  failedDefinitive: string;
  unresolved: string;
  claimable: string;
  stale: string;
  highAttempt: string;
  leased: string;
  oldestCreatedAt: Date | null;
  oldestOutcomeId: string | null;
}

interface ApprovalOperationalRow extends QueryResultRow {
  pending: string;
  approved: string;
  rejected: string;
  expired: string;
  expiredPending: string;
  notificationPending: string;
  notificationLeased: string;
  notificationDelivered: string;
  notificationDeadLetter: string;
  notificationClaimable: string;
  oldestUndeliveredAt: Date | null;
}

interface ReservationOperationalRow extends QueryResultRow {
  reserved: string;
  committed: string;
  released: string;
  expired: string;
  overdueReserved: string;
}

interface AuditHeadRow extends QueryResultRow {
  chainSequence: string;
  chainDigest: string | null;
  updatedAt: Date;
}

interface CursorPayload {
  readonly chainSequence: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const PAYMENT_FORWARDING_GRACE_MS = 30_000;
const PAYMENT_STALE_AFTER_MS = 5 * 60 * 1000;
const PAYMENT_HIGH_ATTEMPT_THRESHOLD = 8;

export class AdminAuditOperationsValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AdminAuditOperationsValidationError";
  }
}

export class PostgresAdminAuditOperations {
  public constructor(
    private readonly sql: AdminAuditSqlExecutor,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async listTransactionAudit(
    organizationId: string,
    filter: AdminTransactionAuditFilter = {},
  ): Promise<AdminAuditPage<AdminTransactionAuditProjection>> {
    requireUuid(organizationId, "organizationId");
    const limit = normalizeLimit(filter.limit);
    const values: unknown[] = [organizationId];
    const where = [`a."organizationId" = $1::uuid`];

    if (filter.verdict) {
      values.push(requireTransactionVerdict(filter.verdict));
      where.push(`a."verdict"::text = $${values.length}`);
    }
    appendTextFilter(where, values, `a."operation"`, filter.operation, "operation");
    appendUuidFilter(where, values, `a."userId"`, filter.userId, "userId");
    appendUuidFilter(where, values, `a."agentId"`, filter.agentId, "agentId");
    appendUuidFilter(where, values, `a."mandateId"`, filter.mandateId, "mandateId");
    appendTextFilter(
      where,
      values,
      `a."merchantDomain"`,
      filter.merchantDomain?.trim().toLowerCase(),
      "merchantDomain",
    );
    appendDateBounds(where, values, `a."timestamp"`, filter.createdAfter, filter.createdBefore);
    appendCursor(where, values, `a."chainSequence"`, filter.cursor);
    values.push(limit + 1);

    const result = await this.sql.query<TransactionAuditRow>(
      `select
         a."chainSequence"::text as "chainSequence", a."timestamp", a."requestId",
         a."decisionId", a."userId", a."agentId", a."mandateId", a."protocol",
         a."operation", a."merchantDomain", a."merchantVendorId",
         a."verdict"::text as "verdict", a."reasonCodes", a."policyVersion",
         a."evaluationLatencyMicros", a."reservationId", a."upstreamStatus",
         a."eventDigest", a."previousChainDigest", a."chainDigest", a."signingKeyId"
       from "AuditLog" a
       where ${where.join(" and ")}
       order by a."chainSequence" desc
       limit $${values.length}::int`,
      values,
    );

    return page(result.rows, limit, transactionAuditProjection);
  }

  public async listAdministrativeAudit(
    organizationId: string,
    filter: AdminChangeAuditFilter = {},
  ): Promise<AdminAuditPage<AdminChangeAuditProjection>> {
    requireUuid(organizationId, "organizationId");
    const limit = normalizeLimit(filter.limit);
    const values: unknown[] = [organizationId];
    const where = [`a."organizationId" = $1::uuid`];

    appendUuidFilter(where, values, `a."principalId"`, filter.principalId, "principalId");
    appendTextFilter(where, values, `a."permission"`, filter.permission, "permission");
    appendTextFilter(where, values, `a."action"`, filter.action, "action");
    appendTextFilter(where, values, `a."resourceType"`, filter.resourceType, "resourceType");
    appendTextFilter(where, values, `a."resourceId"`, filter.resourceId, "resourceId");
    appendDateBounds(where, values, `a."timestamp"`, filter.createdAfter, filter.createdBefore);
    appendCursor(where, values, `a."chainSequence"`, filter.cursor);
    values.push(limit + 1);

    const result = await this.sql.query<AdminAuditRow>(
      `select
         a."chainSequence"::text as "chainSequence", a."timestamp", a."requestId",
         a."principalId", a."membershipId", a."permission", a."action",
         a."resourceType", a."resourceId", a."roles", a."eventDigest",
         a."previousChainDigest", a."chainDigest", a."signingKeyId"
       from "AdminAuditLog" a
       where ${where.join(" and ")}
       order by a."chainSequence" desc
       limit $${values.length}::int`,
      values,
    );

    return page(result.rows, limit, adminAuditProjection);
  }

  public async operationalSnapshot(organizationId: string): Promise<AdminOperationalSnapshot> {
    requireUuid(organizationId, "organizationId");
    const now = validNow(this.now());
    const staleForwardingBefore = new Date(now.getTime() - PAYMENT_FORWARDING_GRACE_MS);
    const stalePaymentBefore = new Date(now.getTime() - PAYMENT_STALE_AFTER_MS);

    const [payments, approvals, reservations, transactionHead, adminHead] = await Promise.all([
      this.sql.query<PaymentOperationalRow>(
        `with scoped as (
           select * from "PaymentOutcome" where "organizationId" = $1::uuid
         ), unresolved as (
           select * from scoped where "status" in ('FORWARDING', 'UNKNOWN')
         ), oldest as (
           select "id", "createdAt" from unresolved order by "createdAt" asc, "id" asc limit 1
         )
         select
           count(*) filter (where s."status" = 'FORWARDING')::text as "forwarding",
           count(*) filter (where s."status" = 'UNKNOWN')::text as "unknown",
           count(*) filter (where s."status" = 'SUCCEEDED')::text as "succeeded",
           count(*) filter (where s."status" = 'FAILED_DEFINITIVE')::text as "failedDefinitive",
           (select count(*)::text from unresolved) as "unresolved",
           (select count(*)::text from unresolved u
             where (
               (u."status" = 'UNKNOWN' and (u."nextReconcileAt" is null or u."nextReconcileAt" <= $2))
               or (u."status" = 'FORWARDING' and u."updatedAt" <= $3)
             )
             and (u."reconciliationLeaseExpiresAt" is null or u."reconciliationLeaseExpiresAt" <= $2)
           ) as "claimable",
           (select count(*)::text from unresolved u where u."createdAt" <= $4) as "stale",
           (select count(*)::text from unresolved u where u."reconcileAttempts" >= $5::int) as "highAttempt",
           (select count(*)::text from unresolved u where u."reconciliationLeaseExpiresAt" > $2) as "leased",
           (select o."createdAt" from oldest o) as "oldestCreatedAt",
           (select o."id" from oldest o) as "oldestOutcomeId"
         from scoped s`,
        [organizationId, now, staleForwardingBefore, stalePaymentBefore, PAYMENT_HIGH_ATTEMPT_THRESHOLD],
      ),
      this.sql.query<ApprovalOperationalRow>(
        `with scoped as (
           select * from "ApprovalRequest" where "organizationId" = $1::uuid
         ), undelivered as (
           select * from scoped a
            where a."status" = 'PENDING'
              and coalesce(a."approvalData"->'notification'->>'status', 'PENDING') in ('PENDING', 'LEASED')
         )
         select
           count(*) filter (where a."status" = 'PENDING')::text as "pending",
           count(*) filter (where a."status" = 'APPROVED')::text as "approved",
           count(*) filter (where a."status" = 'REJECTED')::text as "rejected",
           count(*) filter (where a."status" = 'EXPIRED')::text as "expired",
           count(*) filter (where a."status" = 'PENDING' and a."expiresAt" <= $2)::text as "expiredPending",
           count(*) filter (
             where a."status" = 'PENDING'
               and coalesce(a."approvalData"->'notification'->>'status', 'PENDING') = 'PENDING'
           )::text as "notificationPending",
           count(*) filter (
             where a."status" = 'PENDING'
               and a."approvalData"->'notification'->>'status' = 'LEASED'
               and nullif(a."approvalData"->'notification'->>'leaseExpiresAt', '')::timestamptz > $2
           )::text as "notificationLeased",
           count(*) filter (where a."approvalData"->'notification'->>'status' = 'DELIVERED')::text as "notificationDelivered",
           count(*) filter (where a."approvalData"->'notification'->>'status' = 'DEAD_LETTER')::text as "notificationDeadLetter",
           count(*) filter (
             where a."status" = 'PENDING'
               and (
                 a."approvalData"->'notification' is null
                 or coalesce(a."approvalData"->'notification'->>'status', 'PENDING') = 'PENDING'
                 or (
                   a."approvalData"->'notification'->>'status' = 'LEASED'
                   and nullif(a."approvalData"->'notification'->>'leaseExpiresAt', '')::timestamptz <= $2
                 )
               )
               and (
                 a."approvalData"->'notification'->>'nextAttemptAt' is null
                 or nullif(a."approvalData"->'notification'->>'nextAttemptAt', '')::timestamptz <= $2
               )
           )::text as "notificationClaimable",
           (select min(u."createdAt") from undelivered u) as "oldestUndeliveredAt"
         from scoped a`,
        [organizationId, now],
      ),
      this.sql.query<ReservationOperationalRow>(
        `select
           count(*) filter (where r."status" = 'RESERVED')::text as "reserved",
           count(*) filter (where r."status" = 'COMMITTED')::text as "committed",
           count(*) filter (where r."status" = 'RELEASED')::text as "released",
           count(*) filter (where r."status" = 'EXPIRED')::text as "expired",
           count(*) filter (where r."status" = 'RESERVED' and r."expiresAt" <= $2)::text as "overdueReserved"
         from "SpendReservation" r
         where r."organizationId" = $1::uuid`,
        [organizationId, now],
      ),
      this.loadHead("AuditChainHead", organizationId),
      this.loadHead("AdminAuditChainHead", organizationId),
    ]);

    const paymentRow = requiredRow(payments.rows[0], "payment operational snapshot");
    const approvalRow = requiredRow(approvals.rows[0], "approval operational snapshot");
    const reservationRow = requiredRow(reservations.rows[0], "reservation operational snapshot");

    return {
      capturedAt: now.toISOString(),
      payments: {
        forwarding: parseCount(paymentRow.forwarding, "forwarding payments"),
        unknown: parseCount(paymentRow.unknown, "unknown payments"),
        succeeded: parseCount(paymentRow.succeeded, "succeeded payments"),
        failedDefinitive: parseCount(paymentRow.failedDefinitive, "definitive payment failures"),
        unresolved: parseCount(paymentRow.unresolved, "unresolved payments"),
        claimable: parseCount(paymentRow.claimable, "claimable payments"),
        stale: parseCount(paymentRow.stale, "stale payments"),
        highAttempt: parseCount(paymentRow.highAttempt, "high-attempt payments"),
        leased: parseCount(paymentRow.leased, "leased payments"),
        oldestUnresolvedAgeSeconds: ageSeconds(now, paymentRow.oldestCreatedAt),
        ...(paymentRow.oldestOutcomeId
          ? { oldestUnresolvedPaymentId: paymentRow.oldestOutcomeId }
          : {}),
      },
      approvals: {
        pending: parseCount(approvalRow.pending, "pending approvals"),
        approved: parseCount(approvalRow.approved, "approved approvals"),
        rejected: parseCount(approvalRow.rejected, "rejected approvals"),
        expired: parseCount(approvalRow.expired, "expired approvals"),
        expiredPending: parseCount(approvalRow.expiredPending, "expired pending approvals"),
        notificationPending: parseCount(
          approvalRow.notificationPending,
          "pending approval notifications",
        ),
        notificationLeased: parseCount(
          approvalRow.notificationLeased,
          "leased approval notifications",
        ),
        notificationDelivered: parseCount(
          approvalRow.notificationDelivered,
          "delivered approval notifications",
        ),
        notificationDeadLetter: parseCount(
          approvalRow.notificationDeadLetter,
          "dead-letter approval notifications",
        ),
        notificationClaimable: parseCount(
          approvalRow.notificationClaimable,
          "claimable approval notifications",
        ),
        oldestUndeliveredAgeSeconds: ageSeconds(now, approvalRow.oldestUndeliveredAt),
      },
      reservations: {
        reserved: parseCount(reservationRow.reserved, "reserved reservations"),
        committed: parseCount(reservationRow.committed, "committed reservations"),
        released: parseCount(reservationRow.released, "released reservations"),
        expired: parseCount(reservationRow.expired, "expired reservations"),
        overdueReserved: parseCount(reservationRow.overdueReserved, "overdue reservations"),
      },
      audit: {
        transaction: headProjection(transactionHead),
        administrative: headProjection(adminHead),
      },
    };
  }

  private async loadHead(table: "AuditChainHead" | "AdminAuditChainHead", organizationId: string) {
    const result = await this.sql.query<AuditHeadRow>(
      `select "chainSequence"::text as "chainSequence", "chainDigest", "updatedAt"
         from "${table}"
        where "organizationId" = $1::uuid`,
      [organizationId],
    );
    return result.rows[0];
  }
}

function transactionAuditProjection(row: TransactionAuditRow): AdminTransactionAuditProjection {
  return {
    chainSequence: row.chainSequence,
    timestamp: row.timestamp.toISOString(),
    requestId: row.requestId,
    decisionId: row.decisionId,
    userId: row.userId,
    agentId: row.agentId,
    ...(row.mandateId ? { mandateId: row.mandateId } : {}),
    protocol: row.protocol,
    operation: row.operation,
    merchantDomain: row.merchantDomain,
    ...(row.merchantVendorId ? { merchantVendorId: row.merchantVendorId } : {}),
    verdict: row.verdict,
    reasonCodes: [...row.reasonCodes],
    ...(row.policyVersion !== null ? { policyVersion: row.policyVersion } : {}),
    evaluationLatencyMicros: row.evaluationLatencyMicros,
    ...(row.reservationId ? { reservationId: row.reservationId } : {}),
    ...(row.upstreamStatus !== null ? { upstreamStatus: row.upstreamStatus } : {}),
    eventDigest: row.eventDigest,
    ...(row.previousChainDigest ? { previousChainDigest: row.previousChainDigest } : {}),
    chainDigest: row.chainDigest,
    signingKeyId: row.signingKeyId,
  };
}

function adminAuditProjection(row: AdminAuditRow): AdminChangeAuditProjection {
  return {
    chainSequence: row.chainSequence,
    timestamp: row.timestamp.toISOString(),
    requestId: row.requestId,
    principalId: row.principalId,
    membershipId: row.membershipId,
    permission: row.permission,
    action: row.action,
    resourceType: row.resourceType,
    ...(row.resourceId ? { resourceId: row.resourceId } : {}),
    roles: [...row.roles],
    eventDigest: row.eventDigest,
    ...(row.previousChainDigest ? { previousChainDigest: row.previousChainDigest } : {}),
    chainDigest: row.chainDigest,
    signingKeyId: row.signingKeyId,
  };
}

function page<Row extends { readonly chainSequence: string }, Projection>(
  rows: readonly Row[],
  limit: number,
  project: (row: Row) => Projection,
): AdminAuditPage<Projection> {
  const visible = rows.slice(0, limit);
  const next = rows.length > limit ? visible[visible.length - 1] : undefined;
  return {
    items: visible.map(project),
    ...(next ? { nextCursor: encodeCursor(next.chainSequence) } : {}),
  };
}

function encodeCursor(chainSequence: string): string {
  return Buffer.from(JSON.stringify({ chainSequence }), "utf8").toString("base64url");
}

function decodeCursor(value: string): CursorPayload {
  try {
    if (!value || value.length > 256) {
      throw new Error("invalid cursor");
    }
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid cursor");
    }
    const chainSequence = (parsed as Record<string, unknown>).chainSequence;
    if (typeof chainSequence !== "string" || !/^[1-9][0-9]*$/.test(chainSequence)) {
      throw new Error("invalid cursor");
    }
    return { chainSequence };
  } catch {
    throw new AdminAuditOperationsValidationError("cursor is invalid");
  }
}

function appendCursor(
  where: string[],
  values: unknown[],
  column: string,
  cursor: string | undefined,
): void {
  if (!cursor) {
    return;
  }
  const parsed = decodeCursor(cursor);
  values.push(parsed.chainSequence);
  where.push(`${column} < $${values.length}::bigint`);
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
  values.push(requireUuid(value, label));
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
    throw new AdminAuditOperationsValidationError(`${label} is invalid`);
  }
  values.push(normalized);
  where.push(`${column} = $${values.length}`);
}

function appendDateBounds(
  where: string[],
  values: unknown[],
  column: string,
  createdAfter: string | undefined,
  createdBefore: string | undefined,
): void {
  const after = createdAfter ? parseDate(createdAfter, "createdAfter") : undefined;
  const before = createdBefore ? parseDate(createdBefore, "createdBefore") : undefined;
  if (after && before && after >= before) {
    throw new AdminAuditOperationsValidationError("createdAfter must be before createdBefore");
  }
  if (after) {
    values.push(after);
    where.push(`${column} >= $${values.length}::timestamptz`);
  }
  if (before) {
    values.push(before);
    where.push(`${column} < $${values.length}::timestamptz`);
  }
}

function normalizeLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new AdminAuditOperationsValidationError(`limit must be between 1 and ${MAX_LIMIT}`);
  }
  return limit;
}

function requireUuid(value: string, label: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new AdminAuditOperationsValidationError(`${label} must be a UUID`);
  }
  return value;
}

function requireTransactionVerdict(value: string): AdminAuditTransactionVerdict {
  if (!(ADMIN_AUDIT_TRANSACTION_VERDICTS as readonly string[]).includes(value)) {
    throw new AdminAuditOperationsValidationError("transaction audit verdict is invalid");
  }
  return value as AdminAuditTransactionVerdict;
}

function parseDate(value: string, label: string): Date {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) {
    throw new AdminAuditOperationsValidationError(`${label} must be a valid timestamp`);
  }
  return date;
}

function validNow(value: Date): Date {
  if (!Number.isFinite(value.getTime())) {
    throw new AdminAuditOperationsValidationError("clock returned an invalid timestamp");
  }
  return value;
}

function parseCount(value: string, label: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Invalid ${label} count`);
  }
  return count;
}

function ageSeconds(now: Date, then: Date | null): number {
  return then ? Math.max(0, Math.floor((now.getTime() - then.getTime()) / 1_000)) : 0;
}

function headProjection(row: AuditHeadRow | undefined): AdminAuditHeadProjection {
  if (!row) {
    return { headSequence: "0" };
  }
  return {
    headSequence: row.chainSequence,
    ...(row.chainDigest ? { headDigest: row.chainDigest } : {}),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function requiredRow<T>(value: T | undefined, label: string): T {
  if (!value) {
    throw new Error(`${label} query returned no row`);
  }
  return value;
}
