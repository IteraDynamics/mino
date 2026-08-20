import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
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
  AdminAuditSqlExecutor,
  PostgresAdminChangeAuditLedger,
} from "./admin-change-audit-ledger.js";
import {
  ADMIN_ROLES,
  hasPermission,
  type AdminPermission,
  type AdminRole,
} from "./admin-authorizer.js";
import type { AdminMandateDetail } from "./admin-mandate-management.js";
import type { AdminPolicyDetail } from "./admin-policy-management.js";

export const ADMIN_GOVERNANCE_ACTIONS = ["MANDATE_ISSUE", "POLICY_ACTIVATE"] as const;
export type AdminGovernanceAction = (typeof ADMIN_GOVERNANCE_ACTIONS)[number];

export const ADMIN_GOVERNANCE_STATUSES = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "EXPIRED",
  "APPLIED",
  "STALE",
] as const;
export type AdminGovernanceStatus = (typeof ADMIN_GOVERNANCE_STATUSES)[number];

export const ADMIN_GOVERNANCE_VOTE_DECISIONS = ["APPROVE", "REJECT"] as const;
export type AdminGovernanceVoteDecision = (typeof ADMIN_GOVERNANCE_VOTE_DECISIONS)[number];

export interface AdminGovernanceActor {
  readonly principalId: string;
  readonly membershipId: string;
  readonly organizationId: string;
  readonly roles: readonly AdminRole[];
}

export interface AdminGovernanceMandateIssueRequest {
  readonly userId: string;
  readonly agentId: string;
  readonly policyId: string;
  readonly expiresAt: string;
  readonly idempotencyKey: string;
}

export interface AdminGovernanceVoteRequest {
  readonly decision: AdminGovernanceVoteDecision;
  readonly comment?: string;
}

export interface AdminGovernanceFilter {
  readonly limit?: number;
  readonly cursor?: string;
  readonly status?: AdminGovernanceStatus;
  readonly action?: AdminGovernanceAction;
}

export interface AdminGovernanceVoteProjection {
  readonly principalId: string;
  readonly membershipId: string;
  readonly decision: AdminGovernanceVoteDecision;
  readonly createdAt: string;
  readonly comment?: string;
}

export interface AdminGovernanceRequestProjection {
  readonly id: string;
  readonly organizationId: string;
  readonly action: AdminGovernanceAction;
  readonly requiredPermission: AdminPermission;
  readonly proposerPrincipalId: string;
  readonly proposerMembershipId: string;
  readonly proposalDigest: string;
  readonly preconditionDigest: string;
  readonly targetType: "mandate" | "policy";
  readonly targetId?: string;
  readonly proposal: Readonly<Record<string, unknown>>;
  readonly status: AdminGovernanceStatus;
  readonly requiredApprovals: number;
  readonly voteCount: number;
  readonly approveCount: number;
  readonly rejectCount: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly approvedAt?: string;
  readonly resolvedAt?: string;
  readonly appliedAt?: string;
  readonly resultResourceType?: string;
  readonly resultResourceId?: string;
  readonly votes?: readonly AdminGovernanceVoteProjection[];
}

export interface AdminGovernancePage {
  readonly items: readonly AdminGovernanceRequestProjection[];
  readonly nextCursor?: string;
}

export type AdminGovernanceProposalResult =
  | {
      readonly outcome: "PENDING_GOVERNANCE";
      readonly requestId: string;
      readonly governanceRequest: AdminGovernanceRequestProjection;
      readonly audit: AdminAuditAppendResult;
    }
  | {
      readonly outcome: "REPLAYED";
      readonly requestId: string;
      readonly governanceRequest: AdminGovernanceRequestProjection;
    }
  | {
      readonly outcome: "ALREADY_APPLIED";
      readonly requestId: string;
      readonly resourceType: "mandate" | "policy";
      readonly resourceId: string;
    }
  | { readonly outcome: "CONFLICT"; readonly requestId: string }
  | { readonly outcome: "NOT_FOUND"; readonly requestId: string }
  | { readonly outcome: "INVALID_TARGET"; readonly requestId: string };

export type AdminGovernanceVoteResult =
  | {
      readonly outcome: "UPDATED";
      readonly requestId: string;
      readonly governanceRequest: AdminGovernanceRequestProjection;
      readonly audit: AdminAuditAppendResult;
    }
  | {
      readonly outcome: "REPLAYED";
      readonly requestId: string;
      readonly governanceRequest: AdminGovernanceRequestProjection;
    }
  | { readonly outcome: "NOT_FOUND"; readonly requestId: string }
  | { readonly outcome: "CONFLICT"; readonly requestId: string }
  | {
      readonly outcome: "ALREADY_RESOLVED";
      readonly requestId: string;
      readonly governanceRequest: AdminGovernanceRequestProjection;
    };

export type AdminGovernanceApplyResult =
  | {
      readonly outcome: "APPLIED";
      readonly action: "POLICY_ACTIVATE";
      readonly requestId: string;
      readonly governanceRequest: AdminGovernanceRequestProjection;
      readonly policy: AdminPolicyDetail;
      readonly mutationAudit: AdminAuditAppendResult;
      readonly governanceAudit: AdminAuditAppendResult;
    }
  | {
      readonly outcome: "APPLIED";
      readonly action: "MANDATE_ISSUE";
      readonly requestId: string;
      readonly governanceRequest: AdminGovernanceRequestProjection;
      readonly mandate: AdminMandateDetail;
      readonly mandateToken: string;
      readonly mutationAudit: AdminAuditAppendResult;
      readonly governanceAudit: AdminAuditAppendResult;
    }
  | {
      readonly outcome: "REPLAYED";
      readonly requestId: string;
      readonly governanceRequest: AdminGovernanceRequestProjection;
    }
  | {
      readonly outcome: "STALE" | "EXPIRED";
      readonly requestId: string;
      readonly governanceRequest: AdminGovernanceRequestProjection;
      readonly audit: AdminAuditAppendResult;
    }
  | { readonly outcome: "NOT_FOUND"; readonly requestId: string }
  | {
      readonly outcome: "NOT_APPROVED";
      readonly requestId: string;
      readonly governanceRequest: AdminGovernanceRequestProjection;
    };

export class AdminGovernanceValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AdminGovernanceValidationError";
  }
}

export class AdminGovernancePermissionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AdminGovernancePermissionError";
  }
}

interface GovernanceRow extends QueryResultRow {
  id: string;
  organizationId: string;
  action: AdminGovernanceAction;
  requiredPermission: string;
  proposalKeyHash: string;
  requestDigest: string;
  proposalDigest: string;
  preconditionDigest: string;
  targetType: string;
  targetId: string | null;
  proposalPayload: unknown;
  executionPayload: unknown;
  proposerPrincipalId: string;
  proposerMembershipId: string;
  status: AdminGovernanceStatus;
  requiredApprovals: number;
  createdAt: Date;
  expiresAt: Date;
  approvedAt: Date | null;
  resolvedAt: Date | null;
  appliedAt: Date | null;
  resultResourceType: string | null;
  resultResourceId: string | null;
  voteCount?: number;
  approveCount?: number;
  rejectCount?: number;
}

interface GovernanceVoteRow extends QueryResultRow {
  principalId: string;
  membershipId: string;
  decision: AdminGovernanceVoteDecision;
  comment: string | null;
  createdAt: Date;
}

interface ActorStateRow extends QueryResultRow {
  principalStatus: string;
  membershipStatus: string;
  roles: string[];
}

interface UserTargetRow extends QueryResultRow {
  id: string;
  status: string;
}

interface AgentTargetRow extends QueryResultRow {
  id: string;
  status: string;
  publicKey: string | null;
  keyId: string | null;
}

interface PolicyTargetRow extends QueryResultRow {
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
  approvalMode: "AUTO_APPROVE" | "DUAL_SIGNATURE_SLACK" | "HARD_BLOCK";
  maxTransactionsPerMinute: number;
  crossMerchantWindowSecs: number;
  maxDistinctMerchants: number;
  createdAt: Date;
  updatedAt: Date;
}

interface MandateExistingRow extends QueryResultRow {
  id: string;
}

interface MandateInsertRow extends QueryResultRow {
  id: string;
  organizationId: string;
  userId: string;
  agentId: string;
  policyId: string;
  tokenJtiHash: string;
  policyVersion: number;
  currency: string;
  maxBudgetMinor: string;
  rollingDailyLimitMinor: string;
  approvedMerchantDomains: string[];
  approvedVendorIds: string[];
  restrictedCategories: string[];
  approvalMode: "AUTO_APPROVE" | "DUAL_SIGNATURE_SLACK" | "HARD_BLOCK";
  maxTransactionsPerMinute: number;
  crossMerchantWindowSecs: number;
  maxDistinctMerchants: number;
  delegationPayloadHash: string;
  signingKeyId: string;
  status: "ACTIVE" | "REVOKED" | "EXPIRED";
  issuedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

interface MandateTargetSnapshot {
  readonly user: UserTargetRow;
  readonly agent: AgentTargetRow;
  readonly policy: PolicyTargetRow;
  readonly existingMandateId?: string;
}

interface GovernanceCursor {
  readonly createdAt: string;
  readonly id: string;
}

const DEFAULT_GOVERNANCE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GOVERNANCE_COLUMNS = `"id", "organizationId", "action"::text as "action",
  "requiredPermission", "proposalKeyHash", "requestDigest", "proposalDigest",
  "preconditionDigest", "targetType", "targetId", "proposalPayload", "executionPayload",
  "proposerPrincipalId", "proposerMembershipId", "status"::text as "status",
  "requiredApprovals", "createdAt", "expiresAt", "approvedAt", "resolvedAt", "appliedAt",
  "resultResourceType", "resultResourceId"`;

export class PostgresAdminHighRiskGovernanceService {
  public constructor(
    private readonly sql: AdminAuditSqlClient,
    private readonly audit: Pick<PostgresAdminChangeAuditLedger, "appendInTransaction">,
    private readonly mandateExecution: {
      readonly tokens: Pick<MandateTokenService, "issue">;
      readonly signingKey: MandateSigningKey;
      readonly issuer: string;
    } | undefined,
    private readonly generateId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async requiredPermission(
    organizationId: string,
    governanceRequestId: string,
  ): Promise<AdminPermission | undefined> {
    requireUuid(organizationId, "organizationId");
    requireUuid(governanceRequestId, "governanceRequestId");
    const row = (
      await this.sql.query<{ action: AdminGovernanceAction; requiredPermission: string } & QueryResultRow>(
        `select "action"::text as "action", "requiredPermission"
           from "AdminGovernanceRequest"
          where "organizationId" = $1::uuid and "id" = $2::uuid`,
        [organizationId, governanceRequestId],
      )
    ).rows[0];
    if (!row) return undefined;
    return validatedRequiredPermission(row.action, row.requiredPermission);
  }

  public async list(
    organizationId: string,
    filter: AdminGovernanceFilter = {},
  ): Promise<AdminGovernancePage> {
    requireUuid(organizationId, "organizationId");
    const limit = normalizeLimit(filter.limit);
    const cursor = filter.cursor ? decodeCursor(filter.cursor) : undefined;
    const values: unknown[] = [organizationId];
    const where = [`g."organizationId" = $1::uuid`];
    if (filter.status) {
      if (!ADMIN_GOVERNANCE_STATUSES.includes(filter.status)) {
        throw new AdminGovernanceValidationError("status is invalid");
      }
      values.push(filter.status);
      where.push(`(case when g."status" in ('PENDING','APPROVED') and g."expiresAt" <= now() then 'EXPIRED' else g."status"::text end) = $${values.length}`);
    }
    if (filter.action) {
      if (!ADMIN_GOVERNANCE_ACTIONS.includes(filter.action)) {
        throw new AdminGovernanceValidationError("action is invalid");
      }
      values.push(filter.action);
      where.push(`g."action"::text = $${values.length}`);
    }
    if (cursor) {
      values.push(cursor.createdAt, cursor.id);
      where.push(`(g."createdAt", g."id") < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
    }
    values.push(limit + 1);
    const result = await this.sql.query<GovernanceRow>(
      `select ${GOVERNANCE_COLUMNS},
          (select count(*)::int from "AdminGovernanceVote" v where v."governanceRequestId" = g."id") as "voteCount",
          (select count(*)::int from "AdminGovernanceVote" v where v."governanceRequestId" = g."id" and v."decision" = 'APPROVE') as "approveCount",
          (select count(*)::int from "AdminGovernanceVote" v where v."governanceRequestId" = g."id" and v."decision" = 'REJECT') as "rejectCount"
         from "AdminGovernanceRequest" g
        where ${where.join(" and ")}
        order by g."createdAt" desc, g."id" desc
        limit $${values.length}::int`,
      values,
    );
    const selected = result.rows.slice(0, limit);
    const items = selected.map((row) => governanceProjection(row, validNow(this.now())));
    const next = result.rows.length > limit ? selected[selected.length - 1] : undefined;
    return {
      items,
      ...(next ? { nextCursor: encodeCursor({ createdAt: next.createdAt.toISOString(), id: next.id }) } : {}),
    };
  }

  public async get(
    organizationId: string,
    governanceRequestId: string,
  ): Promise<AdminGovernanceRequestProjection | undefined> {
    requireUuid(organizationId, "organizationId");
    requireUuid(governanceRequestId, "governanceRequestId");
    const row = (
      await this.sql.query<GovernanceRow>(
        `select ${GOVERNANCE_COLUMNS},
          (select count(*)::int from "AdminGovernanceVote" v where v."governanceRequestId" = g."id") as "voteCount",
          (select count(*)::int from "AdminGovernanceVote" v where v."governanceRequestId" = g."id" and v."decision" = 'APPROVE') as "approveCount",
          (select count(*)::int from "AdminGovernanceVote" v where v."governanceRequestId" = g."id" and v."decision" = 'REJECT') as "rejectCount"
         from "AdminGovernanceRequest" g
        where g."organizationId" = $1::uuid and g."id" = $2::uuid`,
        [organizationId, governanceRequestId],
      )
    ).rows[0];
    if (!row) return undefined;
    const votes = await this.loadVotes(this.sql, row.id);
    return governanceProjection(row, validNow(this.now()), votes);
  }

  public async proposeMandateIssue(
    actor: AdminGovernanceActor,
    request: AdminGovernanceMandateIssueRequest,
  ): Promise<AdminGovernanceProposalResult> {
    const userId = requireUuid(request.userId, "userId");
    const agentId = requireUuid(request.agentId, "agentId");
    const policyId = requireUuid(request.policyId, "policyId");
    const idempotencyKey = normalizeIdempotencyKey(request.idempotencyKey);
    const timestamp = validNow(this.now());
    const expiresAt = normalizeFutureDate(request.expiresAt, timestamp, "expiresAt");
    const requestId = this.generateId();
    const action = "MANDATE_ISSUE" as const;
    const permission = requiredPermissionForAction(action);
    const proposalKeyHash = governanceKeyDigest(actor.organizationId, action, idempotencyKey);
    const requestDigest = sha256Base64Url(canonicalJson({
      type: "mino.admin.governance.mandate-issue.request.v1",
      organizationId: actor.organizationId,
      userId,
      agentId,
      policyId,
      expiresAt: expiresAt.toISOString(),
    }));
    const tx = await this.sql.connect();
    try {
      await tx.query("begin");
      await lockOrganization(tx, actor.organizationId);
      await assertActorAuthorized(tx, actor, permission);
      const replay = await this.findProposalByKey(tx, actor.organizationId, action, proposalKeyHash);
      if (replay) {
        await tx.query("rollback");
        if (replay.requestDigest !== requestDigest) return { outcome: "CONFLICT", requestId };
        return { outcome: "REPLAYED", requestId, governanceRequest: governanceProjection(replay, timestamp) };
      }

      const issuanceKeyHash = mandateIssuanceKeyDigest(actor.organizationId, idempotencyKey);
      const target = await loadMandateTarget(tx, actor.organizationId, userId, agentId, policyId, issuanceKeyHash, false);
      if (target.existingMandateId) {
        await tx.query("rollback");
        return {
          outcome: "ALREADY_APPLIED",
          requestId,
          resourceType: "mandate",
          resourceId: target.existingMandateId,
        };
      }
      if (!usableMandateTarget(target)) {
        await tx.query("rollback");
        return { outcome: "INVALID_TARGET", requestId };
      }

      const preconditionDigest = mandatePreconditionDigest(actor.organizationId, target, issuanceKeyHash);
      const proposalDigest = proposalDigestFor({
        organizationId: actor.organizationId,
        action,
        requestDigest,
        preconditionDigest,
      });
      const row = await this.insertProposal(tx, {
        actor,
        action,
        permission,
        proposalKeyHash,
        requestDigest,
        proposalDigest,
        preconditionDigest,
        targetType: "mandate",
        proposalPayload: { userId, agentId, policyId, expiresAt: expiresAt.toISOString() },
        executionPayload: { userId, agentId, policyId, expiresAt: expiresAt.toISOString(), idempotencyKey },
        timestamp,
      });
      const audit = await this.audit.appendInTransaction(tx, {
        requestId,
        organizationId: actor.organizationId,
        principalId: actor.principalId,
        membershipId: actor.membershipId,
        timestamp,
        permission,
        action: "governance.propose",
        resourceType: "admin_governance_request",
        resourceId: row.id,
        roles: actor.roles,
        afterState: governanceAuditState(row, timestamp),
        requestDigest,
        metadata: { governanceAction: action, proposalDigest },
      });
      await tx.query("commit");
      return {
        outcome: "PENDING_GOVERNANCE",
        requestId,
        governanceRequest: governanceProjection(row, timestamp),
        audit,
      };
    } catch (error) {
      await rollbackPreserving(tx);
      throw error;
    } finally {
      tx.release();
    }
  }

  public async proposePolicyActivation(
    actor: AdminGovernanceActor,
    policyIdInput: string,
    idempotencyKeyInput: string,
  ): Promise<AdminGovernanceProposalResult> {
    const policyId = requireUuid(policyIdInput, "policyId");
    const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyInput);
    const timestamp = validNow(this.now());
    const requestId = this.generateId();
    const action = "POLICY_ACTIVATE" as const;
    const permission = requiredPermissionForAction(action);
    const proposalKeyHash = governanceKeyDigest(actor.organizationId, action, idempotencyKey);
    const requestDigest = sha256Base64Url(canonicalJson({
      type: "mino.admin.governance.policy-activate.request.v1",
      organizationId: actor.organizationId,
      policyId,
    }));
    const tx = await this.sql.connect();
    try {
      await tx.query("begin");
      await lockOrganization(tx, actor.organizationId);
      await assertActorAuthorized(tx, actor, permission);
      const replay = await this.findProposalByKey(tx, actor.organizationId, action, proposalKeyHash);
      if (replay) {
        await tx.query("rollback");
        if (replay.requestDigest !== requestDigest) return { outcome: "CONFLICT", requestId };
        return { outcome: "REPLAYED", requestId, governanceRequest: governanceProjection(replay, timestamp) };
      }
      const policy = await loadPolicyTarget(tx, actor.organizationId, policyId, false);
      if (!policy) {
        await tx.query("rollback");
        return { outcome: "NOT_FOUND", requestId };
      }
      if (policy.active) {
        await tx.query("rollback");
        return { outcome: "ALREADY_APPLIED", requestId, resourceType: "policy", resourceId: policy.id };
      }
      const preconditionDigest = policyPreconditionDigest(policy);
      const proposalDigest = proposalDigestFor({
        organizationId: actor.organizationId,
        action,
        requestDigest,
        preconditionDigest,
      });
      const row = await this.insertProposal(tx, {
        actor,
        action,
        permission,
        proposalKeyHash,
        requestDigest,
        proposalDigest,
        preconditionDigest,
        targetType: "policy",
        targetId: policy.id,
        proposalPayload: { policyId: policy.id, name: policy.name, version: policy.version },
        executionPayload: { policyId: policy.id },
        timestamp,
      });
      const audit = await this.audit.appendInTransaction(tx, {
        requestId,
        organizationId: actor.organizationId,
        principalId: actor.principalId,
        membershipId: actor.membershipId,
        timestamp,
        permission,
        action: "governance.propose",
        resourceType: "admin_governance_request",
        resourceId: row.id,
        roles: actor.roles,
        afterState: governanceAuditState(row, timestamp),
        requestDigest,
        metadata: { governanceAction: action, proposalDigest, policyId: policy.id },
      });
      await tx.query("commit");
      return {
        outcome: "PENDING_GOVERNANCE",
        requestId,
        governanceRequest: governanceProjection(row, timestamp),
        audit,
      };
    } catch (error) {
      await rollbackPreserving(tx);
      throw error;
    } finally {
      tx.release();
    }
  }

  public async vote(
    actor: AdminGovernanceActor,
    governanceRequestIdInput: string,
    request: AdminGovernanceVoteRequest,
  ): Promise<AdminGovernanceVoteResult> {
    const governanceRequestId = requireUuid(governanceRequestIdInput, "governanceRequestId");
    const decision = requireVoteDecision(request.decision);
    const comment = normalizeComment(request.comment);
    const timestamp = validNow(this.now());
    const requestId = this.generateId();
    const tx = await this.sql.connect();
    try {
      await tx.query("begin");
      const row = await lockGovernanceRequest(tx, actor.organizationId, governanceRequestId);
      if (!row) {
        await tx.query("rollback");
        return { outcome: "NOT_FOUND", requestId };
      }
      const permission = validatedRequiredPermission(row.action, row.requiredPermission);
      await assertActorAuthorized(tx, actor, permission);
      if (await expireIfNeeded(tx, row, timestamp)) {
        const expired = await reloadGovernanceRequest(tx, row.organizationId, row.id);
        if (!expired) throw new Error("Expired governance request disappeared");
        const audit = await governanceTransitionAudit(this.audit, tx, actor, expired, permission, requestId, timestamp, "governance.expire");
        await tx.query("commit");
        return {
          outcome: "ALREADY_RESOLVED",
          requestId,
          governanceRequest: governanceProjection(expired, timestamp),
        };
      }
      if (row.status !== "PENDING") {
        await tx.query("rollback");
        return { outcome: "ALREADY_RESOLVED", requestId, governanceRequest: governanceProjection(row, timestamp) };
      }
      if (actor.principalId === row.proposerPrincipalId) {
        await tx.query("rollback");
        return { outcome: "CONFLICT", requestId };
      }
      const prior = (
        await tx.query<GovernanceVoteRow>(
          `select "principalId", "membershipId", "decision"::text as "decision", "comment", "createdAt"
             from "AdminGovernanceVote"
            where "governanceRequestId" = $1::uuid and "principalId" = $2::uuid`,
          [row.id, actor.principalId],
        )
      ).rows[0];
      if (prior) {
        await tx.query("rollback");
        if (prior.decision !== decision) return { outcome: "CONFLICT", requestId };
        const current = await this.get(row.organizationId, row.id);
        if (!current) return { outcome: "NOT_FOUND", requestId };
        return { outcome: "REPLAYED", requestId, governanceRequest: current };
      }

      await tx.query(
        `insert into "AdminGovernanceVote" (
           "id", "governanceRequestId", "principalId", "membershipId", "decision", "comment", "createdAt"
         ) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::"AdminGovernanceVoteDecision", $6, $7)`,
        [this.generateId(), row.id, actor.principalId, actor.membershipId, decision, comment ?? null, timestamp],
      );
      const nextStatus: AdminGovernanceStatus = decision === "REJECT" ? "REJECTED" : "APPROVED";
      await tx.query(
        `update "AdminGovernanceRequest"
            set "status" = $3::"AdminGovernanceStatus",
                "approvedAt" = case when $3 = 'APPROVED' then $4 else "approvedAt" end,
                "resolvedAt" = case when $3 = 'REJECTED' then $4 else "resolvedAt" end
          where "organizationId" = $1::uuid and "id" = $2::uuid`,
        [row.organizationId, row.id, nextStatus, timestamp],
      );
      const updated = await reloadGovernanceRequest(tx, row.organizationId, row.id);
      if (!updated) throw new Error("Governance vote update disappeared");
      const audit = await this.audit.appendInTransaction(tx, {
        requestId,
        organizationId: actor.organizationId,
        principalId: actor.principalId,
        membershipId: actor.membershipId,
        timestamp,
        permission,
        action: decision === "APPROVE" ? "governance.approve" : "governance.reject",
        resourceType: "admin_governance_request",
        resourceId: row.id,
        roles: actor.roles,
        beforeState: governanceAuditState(row, timestamp),
        afterState: governanceAuditState(updated, timestamp),
        requestDigest: sha256Base64Url(canonicalJson({
          type: "mino.admin.governance.vote.v1",
          organizationId: actor.organizationId,
          governanceRequestId: row.id,
          proposalDigest: row.proposalDigest,
          principalId: actor.principalId,
          decision,
          comment: comment ?? null,
        })),
        metadata: { governanceAction: row.action, proposalDigest: row.proposalDigest },
      });
      await tx.query("commit");
      return { outcome: "UPDATED", requestId, governanceRequest: governanceProjection(updated, timestamp), audit };
    } catch (error) {
      await rollbackPreserving(tx);
      throw error;
    } finally {
      tx.release();
    }
  }

  public async apply(
    actor: AdminGovernanceActor,
    governanceRequestIdInput: string,
  ): Promise<AdminGovernanceApplyResult> {
    const governanceRequestId = requireUuid(governanceRequestIdInput, "governanceRequestId");
    const timestamp = validNow(this.now());
    const requestId = this.generateId();
    const tx = await this.sql.connect();
    try {
      await tx.query("begin");
      const row = await lockGovernanceRequest(tx, actor.organizationId, governanceRequestId);
      if (!row) {
        await tx.query("rollback");
        return { outcome: "NOT_FOUND", requestId };
      }
      const permission = validatedRequiredPermission(row.action, row.requiredPermission);
      await assertActorAuthorized(tx, actor, permission);
      if (row.status === "APPLIED") {
        await tx.query("rollback");
        return { outcome: "REPLAYED", requestId, governanceRequest: governanceProjection(row, timestamp) };
      }
      if (await expireIfNeeded(tx, row, timestamp)) {
        const expired = await reloadGovernanceRequest(tx, row.organizationId, row.id);
        if (!expired) throw new Error("Expired governance request disappeared");
        const audit = await governanceTransitionAudit(this.audit, tx, actor, expired, permission, requestId, timestamp, "governance.expire");
        await tx.query("commit");
        return { outcome: "EXPIRED", requestId, governanceRequest: governanceProjection(expired, timestamp), audit };
      }
      if (row.status !== "APPROVED") {
        await tx.query("rollback");
        return { outcome: "NOT_APPROVED", requestId, governanceRequest: governanceProjection(row, timestamp) };
      }

      const proposerAuthorized = await identityStillAuthorized(
        tx,
        row.organizationId,
        row.proposerPrincipalId,
        row.proposerMembershipId,
        permission,
      );
      const approvingVotes = await this.loadVotes(tx, row.id);
      const distinctApproved = approvingVotes.filter(
        (vote) => vote.decision === "APPROVE" && vote.principalId !== row.proposerPrincipalId,
      );
      let approverAuthorized = distinctApproved.length >= row.requiredApprovals;
      for (const vote of distinctApproved) {
        if (!(await identityStillAuthorized(tx, row.organizationId, vote.principalId, vote.membershipId, permission))) {
          approverAuthorized = false;
          break;
        }
      }
      if (!proposerAuthorized || !approverAuthorized) {
        const stale = await this.markStale(tx, row, actor, permission, requestId, timestamp, "AUTHORIZATION_REVALIDATION_FAILED");
        await tx.query("commit");
        return stale;
      }

      if (row.action === "POLICY_ACTIVATE") {
        const payload = parsePolicyExecutionPayload(row.executionPayload);
        const policy = await loadPolicyTarget(tx, row.organizationId, payload.policyId, true);
        if (!policy || policy.active || policyPreconditionDigest(policy) !== row.preconditionDigest) {
          const stale = await this.markStale(tx, row, actor, permission, requestId, timestamp, "TARGET_STATE_CHANGED");
          await tx.query("commit");
          return stale;
        }
        const updated = (
          await tx.query<PolicyTargetRow>(
            `update "Policy"
                set "active" = true, "updatedAt" = $3
              where "organizationId" = $1::uuid and "id" = $2::uuid
              returning "id", "organizationId", "name", "version", "active", "baseCurrency",
                "maxBudgetMinor"::text as "maxBudgetMinor", "rollingDailyLimitMinor"::text as "rollingDailyLimitMinor",
                "approvedMerchantDomains", "approvedVendorIds", "restrictedCategories", "approvalMode"::text as "approvalMode",
                "maxTransactionsPerMinute", "crossMerchantWindowSecs", "maxDistinctMerchants", "createdAt", "updatedAt"`,
            [row.organizationId, policy.id, timestamp],
          )
        ).rows[0];
        if (!updated) throw new Error("Governed policy activation returned no row");
        const policyDetail = policyDetailFromRow(updated);
        const mutationAudit = await this.audit.appendInTransaction(tx, {
          requestId: this.generateId(),
          organizationId: actor.organizationId,
          principalId: actor.principalId,
          membershipId: actor.membershipId,
          timestamp,
          permission: "policy.activate",
          action: "policy.activate",
          resourceType: "policy",
          resourceId: policy.id,
          roles: actor.roles,
          beforeState: policyAuditState(policy),
          afterState: policyAuditState(updated),
          requestDigest: sha256Base64Url(canonicalJson({
            type: "mino.admin.policy.activation-transition.v1",
            organizationId: actor.organizationId,
            policyId: policy.id,
            targetActive: true,
          })),
          metadata: governanceMutationMetadata(row, distinctApproved),
        });
        const applied = await this.markApplied(tx, row, "policy", policy.id, timestamp);
        const governanceAudit = await governanceTransitionAudit(
          this.audit,
          tx,
          actor,
          applied,
          permission,
          requestId,
          timestamp,
          "governance.apply",
          row,
        );
        await tx.query("commit");
        return {
          outcome: "APPLIED",
          action: "POLICY_ACTIVATE",
          requestId,
          governanceRequest: governanceProjection(applied, timestamp),
          policy: policyDetail,
          mutationAudit,
          governanceAudit,
        };
      }

      if (!this.mandateExecution) {
        const stale = await this.markStale(tx, row, actor, permission, requestId, timestamp, "MANDATE_SIGNING_UNAVAILABLE");
        await tx.query("commit");
        return stale;
      }
      const payload = parseMandateExecutionPayload(row.executionPayload);
      const mandateExpiresAt = normalizeFutureDate(payload.expiresAt, timestamp, "expiresAt");
      const issuanceKeyHash = mandateIssuanceKeyDigest(row.organizationId, payload.idempotencyKey);
      const target = await loadMandateTarget(
        tx,
        row.organizationId,
        payload.userId,
        payload.agentId,
        payload.policyId,
        issuanceKeyHash,
        true,
      );
      if (
        !usableMandateTarget(target) ||
        target.existingMandateId ||
        mandatePreconditionDigest(row.organizationId, target, issuanceKeyHash) !== row.preconditionDigest
      ) {
        const stale = await this.markStale(tx, row, actor, permission, requestId, timestamp, "TARGET_STATE_CHANGED");
        await tx.query("commit");
        return stale;
      }
      const mandateId = this.generateId();
      const tokenJti = this.generateId();
      const tokenJtiHash = sha256Hex(tokenJti);
      const issuedAtSeconds = Math.floor(timestamp.getTime() / 1_000);
      const expiresAtSeconds = Math.floor(mandateExpiresAt.getTime() / 1_000);
      if (expiresAtSeconds <= issuedAtSeconds) {
        const stale = await this.markStale(tx, row, actor, permission, requestId, timestamp, "MANDATE_EXPIRY_NO_LONGER_USABLE");
        await tx.query("commit");
        return stale;
      }
      const authorityDigest = mandateAuthorityPayloadDigest({
        organizationId: row.organizationId,
        userId: payload.userId,
        agentId: payload.agentId,
        policy: target.policy,
        expiresAt: mandateExpiresAt,
      });
      const mandateToken = this.mandateExecution.tokens.issue(
        {
          iss: this.mandateExecution.issuer,
          sub: payload.agentId,
          aud: "mino",
          jti: tokenJti,
          organizationId: row.organizationId,
          userId: payload.userId,
          agentId: payload.agentId,
          mandateId,
          policyVersion: target.policy.version,
          iat: issuedAtSeconds,
          nbf: issuedAtSeconds,
          exp: expiresAtSeconds,
        },
        this.mandateExecution.signingKey,
      );
      const inserted = (
        await tx.query<MandateInsertRow>(
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
           ) returning "id", "organizationId", "userId", "agentId", "policyId",
             "tokenJtiHash", "policyVersion", "currency",
             "maxBudgetMinor"::text as "maxBudgetMinor", "rollingDailyLimitMinor"::text as "rollingDailyLimitMinor",
             "approvedMerchantDomains", "approvedVendorIds", "restrictedCategories", "approvalMode"::text as "approvalMode",
             "maxTransactionsPerMinute", "crossMerchantWindowSecs", "maxDistinctMerchants",
             "delegationPayloadHash", "signingKeyId", "status"::text as "status", "issuedAt", "expiresAt", "revokedAt"`,
          [
            mandateId,
            row.organizationId,
            payload.userId,
            payload.agentId,
            target.policy.id,
            issuanceKeyHash,
            tokenJtiHash,
            target.policy.version,
            target.policy.baseCurrency,
            target.policy.maxBudgetMinor,
            target.policy.rollingDailyLimitMinor,
            target.policy.approvedMerchantDomains,
            target.policy.approvedVendorIds,
            target.policy.restrictedCategories,
            target.policy.approvalMode,
            target.policy.maxTransactionsPerMinute,
            target.policy.crossMerchantWindowSecs,
            target.policy.maxDistinctMerchants,
            authorityDigest,
            this.mandateExecution.signingKey.keyId,
            timestamp,
            mandateExpiresAt,
          ],
        )
      ).rows[0];
      if (!inserted) throw new Error("Governed mandate issuance returned no row");
      const mandate = mandateDetailFromRow(inserted);
      const mutationAudit = await this.audit.appendInTransaction(tx, {
        requestId: this.generateId(),
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
        requestDigest: sha256Base64Url(canonicalJson({
          type: "mino.admin.mandate.issue-request.v1",
          organizationId: actor.organizationId,
          userId: payload.userId,
          agentId: payload.agentId,
          policyId: payload.policyId,
          expiresAt: mandateExpiresAt.toISOString(),
          issuanceKeyHash,
        })),
        metadata: {
          policyId: target.policy.id,
          policyVersion: target.policy.version,
          issuanceKeyHash,
          ...governanceMutationMetadata(row, distinctApproved),
        },
      });
      const applied = await this.markApplied(tx, row, "mandate", mandate.id, timestamp);
      const governanceAudit = await governanceTransitionAudit(
        this.audit,
        tx,
        actor,
        applied,
        permission,
        requestId,
        timestamp,
        "governance.apply",
        row,
      );
      await tx.query("commit");
      return {
        outcome: "APPLIED",
        action: "MANDATE_ISSUE",
        requestId,
        governanceRequest: governanceProjection(applied, timestamp),
        mandate,
        mandateToken,
        mutationAudit,
        governanceAudit,
      };
    } catch (error) {
      await rollbackPreserving(tx);
      throw error;
    } finally {
      tx.release();
    }
  }

  private async findProposalByKey(
    tx: AdminAuditSqlExecutor,
    organizationId: string,
    action: AdminGovernanceAction,
    proposalKeyHash: string,
  ): Promise<GovernanceRow | undefined> {
    return (
      await tx.query<GovernanceRow>(
        `select ${GOVERNANCE_COLUMNS},
          (select count(*)::int from "AdminGovernanceVote" v where v."governanceRequestId" = g."id") as "voteCount",
          (select count(*)::int from "AdminGovernanceVote" v where v."governanceRequestId" = g."id" and v."decision" = 'APPROVE') as "approveCount",
          (select count(*)::int from "AdminGovernanceVote" v where v."governanceRequestId" = g."id" and v."decision" = 'REJECT') as "rejectCount"
         from "AdminGovernanceRequest" g
        where g."organizationId" = $1::uuid and g."action" = $2::"AdminGovernanceAction" and g."proposalKeyHash" = $3`,
        [organizationId, action, proposalKeyHash],
      )
    ).rows[0];
  }

  private async insertProposal(
    tx: AdminAuditSqlExecutor,
    input: {
      readonly actor: AdminGovernanceActor;
      readonly action: AdminGovernanceAction;
      readonly permission: AdminPermission;
      readonly proposalKeyHash: string;
      readonly requestDigest: string;
      readonly proposalDigest: string;
      readonly preconditionDigest: string;
      readonly targetType: "mandate" | "policy";
      readonly targetId?: string;
      readonly proposalPayload: Readonly<Record<string, unknown>>;
      readonly executionPayload: Readonly<Record<string, unknown>>;
      readonly timestamp: Date;
    },
  ): Promise<GovernanceRow> {
    const governanceRequestId = this.generateId();
    const expiresAt = new Date(input.timestamp.getTime() + DEFAULT_GOVERNANCE_TTL_MS);
    const row = (
      await tx.query<GovernanceRow>(
        `insert into "AdminGovernanceRequest" (
           "id", "organizationId", "action", "requiredPermission", "proposalKeyHash",
           "requestDigest", "proposalDigest", "preconditionDigest", "targetType", "targetId",
           "proposalPayload", "executionPayload", "proposerPrincipalId", "proposerMembershipId",
           "status", "requiredApprovals", "createdAt", "expiresAt"
         ) values (
           $1::uuid, $2::uuid, $3::"AdminGovernanceAction", $4, $5,
           $6, $7, $8, $9, $10,
           $11::jsonb, $12::jsonb, $13::uuid, $14::uuid,
           'PENDING', 1, $15, $16
         ) returning ${GOVERNANCE_COLUMNS}`,
        [
          governanceRequestId,
          input.actor.organizationId,
          input.action,
          input.permission,
          input.proposalKeyHash,
          input.requestDigest,
          input.proposalDigest,
          input.preconditionDigest,
          input.targetType,
          input.targetId ?? null,
          JSON.stringify(input.proposalPayload),
          JSON.stringify(input.executionPayload),
          input.actor.principalId,
          input.actor.membershipId,
          input.timestamp,
          expiresAt,
        ],
      )
    ).rows[0];
    if (!row) throw new Error("Administrative governance proposal returned no row");
    row.voteCount = 0;
    row.approveCount = 0;
    row.rejectCount = 0;
    return row;
  }

  private async loadVotes(
    executor: AdminAuditSqlExecutor,
    governanceRequestId: string,
  ): Promise<AdminGovernanceVoteProjection[]> {
    const rows = (
      await executor.query<GovernanceVoteRow>(
        `select "principalId", "membershipId", "decision"::text as "decision", "comment", "createdAt"
           from "AdminGovernanceVote"
          where "governanceRequestId" = $1::uuid
          order by "createdAt" asc, "principalId" asc`,
        [governanceRequestId],
      )
    ).rows;
    return rows.map((row) => ({
      principalId: row.principalId,
      membershipId: row.membershipId,
      decision: row.decision,
      createdAt: row.createdAt.toISOString(),
      ...(row.comment ? { comment: row.comment } : {}),
    }));
  }

  private async markApplied(
    tx: AdminAuditSqlExecutor,
    row: GovernanceRow,
    resourceType: "mandate" | "policy",
    resourceId: string,
    timestamp: Date,
  ): Promise<GovernanceRow> {
    await tx.query(
      `update "AdminGovernanceRequest"
          set "status" = 'APPLIED', "resolvedAt" = $3, "appliedAt" = $3,
              "resultResourceType" = $4, "resultResourceId" = $5
        where "organizationId" = $1::uuid and "id" = $2::uuid`,
      [row.organizationId, row.id, timestamp, resourceType, resourceId],
    );
    const updated = await reloadGovernanceRequest(tx, row.organizationId, row.id);
    if (!updated) throw new Error("Applied governance request disappeared");
    return updated;
  }

  private async markStale(
    tx: AdminAuditSqlExecutor,
    row: GovernanceRow,
    actor: AdminGovernanceActor,
    permission: AdminPermission,
    requestId: string,
    timestamp: Date,
    reason: string,
  ): Promise<Extract<AdminGovernanceApplyResult, { outcome: "STALE" | "EXPIRED" }>> {
    await tx.query(
      `update "AdminGovernanceRequest"
          set "status" = 'STALE', "resolvedAt" = $3
        where "organizationId" = $1::uuid and "id" = $2::uuid`,
      [row.organizationId, row.id, timestamp],
    );
    const updated = await reloadGovernanceRequest(tx, row.organizationId, row.id);
    if (!updated) throw new Error("Stale governance request disappeared");
    const audit = await governanceTransitionAudit(
      this.audit,
      tx,
      actor,
      updated,
      permission,
      requestId,
      timestamp,
      "governance.stale",
      row,
      { reason },
    );
    return { outcome: "STALE", requestId, governanceRequest: governanceProjection(updated, timestamp), audit };
  }
}

function requiredPermissionForAction(action: AdminGovernanceAction): AdminPermission {
  switch (action) {
    case "MANDATE_ISSUE":
      return "mandate.issue";
    case "POLICY_ACTIVATE":
      return "policy.activate";
  }
}

function validatedRequiredPermission(action: AdminGovernanceAction, stored: string): AdminPermission {
  const expected = requiredPermissionForAction(action);
  if (stored !== expected) throw new Error("Governance request permission binding is invalid");
  return expected;
}

async function assertActorAuthorized(
  executor: AdminAuditSqlExecutor,
  actor: AdminGovernanceActor,
  permission: AdminPermission,
): Promise<void> {
  if (!(await identityStillAuthorized(executor, actor.organizationId, actor.principalId, actor.membershipId, permission))) {
    throw new AdminGovernancePermissionError("Administrative authority changed before governance operation");
  }
}

async function identityStillAuthorized(
  executor: AdminAuditSqlExecutor,
  organizationId: string,
  principalId: string,
  membershipId: string,
  permission: AdminPermission,
): Promise<boolean> {
  const row = (
    await executor.query<ActorStateRow>(
      `select p."status"::text as "principalStatus", m."status"::text as "membershipStatus",
          coalesce(array_agg(r."role"::text order by r."role"::text)
            filter (where r."role" is not null), array[]::text[]) as "roles"
         from "AdminPrincipal" p
         join "AdminOrganizationMembership" m
           on m."principalId" = p."id" and m."id" = $2::uuid and m."organizationId" = $3::uuid
         left join "AdminRoleAssignment" r on r."membershipId" = m."id"
        where p."id" = $1::uuid
        group by p."status", m."status"`,
      [principalId, membershipId, organizationId],
    )
  ).rows[0];
  if (!row || row.principalStatus !== "ACTIVE" || row.membershipStatus !== "ACTIVE") return false;
  const roles = row.roles.filter(isAdminRole);
  return roles.length === row.roles.length && hasPermission(roles, permission);
}

function isAdminRole(value: string): value is AdminRole {
  return ADMIN_ROLES.includes(value as AdminRole);
}

async function lockOrganization(executor: AdminAuditSqlExecutor, organizationId: string): Promise<void> {
  const result = await executor.query(
    `select "id" from "Organization" where "id" = $1::uuid for update`,
    [organizationId],
  );
  if (result.rowCount !== 1) throw new Error("Governance organization no longer exists");
}

async function lockGovernanceRequest(
  executor: AdminAuditSqlExecutor,
  organizationId: string,
  governanceRequestId: string,
): Promise<GovernanceRow | undefined> {
  return (
    await executor.query<GovernanceRow>(
      `select ${GOVERNANCE_COLUMNS},
          (select count(*)::int from "AdminGovernanceVote" v where v."governanceRequestId" = g."id") as "voteCount",
          (select count(*)::int from "AdminGovernanceVote" v where v."governanceRequestId" = g."id" and v."decision" = 'APPROVE') as "approveCount",
          (select count(*)::int from "AdminGovernanceVote" v where v."governanceRequestId" = g."id" and v."decision" = 'REJECT') as "rejectCount"
         from "AdminGovernanceRequest" g
        where g."organizationId" = $1::uuid and g."id" = $2::uuid
        for update`,
      [organizationId, governanceRequestId],
    )
  ).rows[0];
}

async function reloadGovernanceRequest(
  executor: AdminAuditSqlExecutor,
  organizationId: string,
  governanceRequestId: string,
): Promise<GovernanceRow | undefined> {
  return (
    await executor.query<GovernanceRow>(
      `select ${GOVERNANCE_COLUMNS},
          (select count(*)::int from "AdminGovernanceVote" v where v."governanceRequestId" = g."id") as "voteCount",
          (select count(*)::int from "AdminGovernanceVote" v where v."governanceRequestId" = g."id" and v."decision" = 'APPROVE') as "approveCount",
          (select count(*)::int from "AdminGovernanceVote" v where v."governanceRequestId" = g."id" and v."decision" = 'REJECT') as "rejectCount"
         from "AdminGovernanceRequest" g
        where g."organizationId" = $1::uuid and g."id" = $2::uuid`,
      [organizationId, governanceRequestId],
    )
  ).rows[0];
}

async function expireIfNeeded(
  executor: AdminAuditSqlExecutor,
  row: GovernanceRow,
  timestamp: Date,
): Promise<boolean> {
  if ((row.status !== "PENDING" && row.status !== "APPROVED") || row.expiresAt.getTime() > timestamp.getTime()) {
    return false;
  }
  await executor.query(
    `update "AdminGovernanceRequest"
        set "status" = 'EXPIRED', "resolvedAt" = coalesce("resolvedAt", $3)
      where "organizationId" = $1::uuid and "id" = $2::uuid`,
    [row.organizationId, row.id, timestamp],
  );
  return true;
}

async function loadPolicyTarget(
  executor: AdminAuditSqlExecutor,
  organizationId: string,
  policyId: string,
  forUpdate: boolean,
): Promise<PolicyTargetRow | undefined> {
  const lock = forUpdate ? " for update" : " for share";
  return (
    await executor.query<PolicyTargetRow>(
      `select "id", "organizationId", "name", "version", "active", "baseCurrency",
          "maxBudgetMinor"::text as "maxBudgetMinor", "rollingDailyLimitMinor"::text as "rollingDailyLimitMinor",
          "approvedMerchantDomains", "approvedVendorIds", "restrictedCategories", "approvalMode"::text as "approvalMode",
          "maxTransactionsPerMinute", "crossMerchantWindowSecs", "maxDistinctMerchants", "createdAt", "updatedAt"
         from "Policy"
        where "organizationId" = $1::uuid and "id" = $2::uuid${lock}`,
      [organizationId, policyId],
    )
  ).rows[0];
}

async function loadMandateTarget(
  executor: AdminAuditSqlExecutor,
  organizationId: string,
  userId: string,
  agentId: string,
  policyId: string,
  issuanceKeyHash: string,
  lockTargets: boolean,
): Promise<MandateTargetSnapshot> {
  const lock = lockTargets ? " for share" : " for share";
  const [user, agent, policy, existing] = await Promise.all([
    executor.query<UserTargetRow>(
      `select "id", "status"::text as "status" from "User"
        where "organizationId" = $1::uuid and "id" = $2::uuid${lock}`,
      [organizationId, userId],
    ),
    executor.query<AgentTargetRow>(
      `select "id", "status"::text as "status", "publicKey", "keyId" from "AgentIdentity"
        where "organizationId" = $1::uuid and "id" = $2::uuid${lock}`,
      [organizationId, agentId],
    ),
    executor.query<PolicyTargetRow>(
      `select "id", "organizationId", "name", "version", "active", "baseCurrency",
          "maxBudgetMinor"::text as "maxBudgetMinor", "rollingDailyLimitMinor"::text as "rollingDailyLimitMinor",
          "approvedMerchantDomains", "approvedVendorIds", "restrictedCategories", "approvalMode"::text as "approvalMode",
          "maxTransactionsPerMinute", "crossMerchantWindowSecs", "maxDistinctMerchants", "createdAt", "updatedAt"
         from "Policy"
        where "organizationId" = $1::uuid and "id" = $2::uuid${lock}`,
      [organizationId, policyId],
    ),
    executor.query<MandateExistingRow>(
      `select "id" from "AgentMandate"
        where "organizationId" = $1::uuid and "issuanceKeyHash" = $2 limit 1`,
      [organizationId, issuanceKeyHash],
    ),
  ]);
  return {
    user: user.rows[0] ?? ({ id: "", status: "MISSING" } as UserTargetRow),
    agent: agent.rows[0] ?? ({ id: "", status: "MISSING", publicKey: null, keyId: null } as AgentTargetRow),
    policy: policy.rows[0] ?? (missingPolicyTarget() as PolicyTargetRow),
    ...(existing.rows[0]?.id ? { existingMandateId: existing.rows[0].id } : {}),
  };
}

function missingPolicyTarget(): Partial<PolicyTargetRow> {
  return {
    id: "",
    organizationId: "",
    name: "",
    version: 0,
    active: false,
    baseCurrency: "",
    maxBudgetMinor: "0",
    rollingDailyLimitMinor: "0",
    approvedMerchantDomains: [],
    approvedVendorIds: [],
    restrictedCategories: [],
    approvalMode: "HARD_BLOCK",
    maxTransactionsPerMinute: 0,
    crossMerchantWindowSecs: 0,
    maxDistinctMerchants: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function usableMandateTarget(target: MandateTargetSnapshot): boolean {
  return (
    target.user.id.length > 0 && target.user.status === "ACTIVE" &&
    target.agent.id.length > 0 && target.agent.status === "ACTIVE" &&
    typeof target.agent.publicKey === "string" && target.agent.publicKey.length > 0 &&
    typeof target.agent.keyId === "string" && target.agent.keyId.length > 0 &&
    target.policy.id.length > 0 && target.policy.active
  );
}

function policyPreconditionDigest(policy: PolicyTargetRow): string {
  return sha256Base64Url(canonicalJson({
    type: "mino.admin.governance.policy-precondition.v1",
    id: policy.id,
    organizationId: policy.organizationId,
    name: policy.name,
    version: policy.version,
    active: policy.active,
    baseCurrency: policy.baseCurrency,
    maxBudgetMinor: policy.maxBudgetMinor,
    rollingDailyLimitMinor: policy.rollingDailyLimitMinor,
    approvedMerchantDomains: policy.approvedMerchantDomains,
    approvedVendorIds: policy.approvedVendorIds,
    restrictedCategories: policy.restrictedCategories,
    approvalMode: policy.approvalMode,
    maxTransactionsPerMinute: policy.maxTransactionsPerMinute,
    crossMerchantWindowSecs: policy.crossMerchantWindowSecs,
    maxDistinctMerchants: policy.maxDistinctMerchants,
    updatedAt: policy.updatedAt.toISOString(),
  }));
}

function mandatePreconditionDigest(
  organizationId: string,
  target: MandateTargetSnapshot,
  issuanceKeyHash: string,
): string {
  return sha256Base64Url(canonicalJson({
    type: "mino.admin.governance.mandate-precondition.v1",
    organizationId,
    user: { id: target.user.id, status: target.user.status },
    agent: {
      id: target.agent.id,
      status: target.agent.status,
      keyId: target.agent.keyId,
      publicKeyDigest: target.agent.publicKey ? sha256Base64Url(target.agent.publicKey) : null,
    },
    policy: {
      id: target.policy.id,
      version: target.policy.version,
      active: target.policy.active,
      baseCurrency: target.policy.baseCurrency,
      maxBudgetMinor: target.policy.maxBudgetMinor,
      rollingDailyLimitMinor: target.policy.rollingDailyLimitMinor,
      approvedMerchantDomains: target.policy.approvedMerchantDomains,
      approvedVendorIds: target.policy.approvedVendorIds,
      restrictedCategories: target.policy.restrictedCategories,
      approvalMode: target.policy.approvalMode,
      maxTransactionsPerMinute: target.policy.maxTransactionsPerMinute,
      crossMerchantWindowSecs: target.policy.crossMerchantWindowSecs,
      maxDistinctMerchants: target.policy.maxDistinctMerchants,
      updatedAt: target.policy.updatedAt.toISOString(),
    },
    issuanceKeyHash,
    existingMandateId: target.existingMandateId ?? null,
  }));
}

function proposalDigestFor(input: {
  readonly organizationId: string;
  readonly action: AdminGovernanceAction;
  readonly requestDigest: string;
  readonly preconditionDigest: string;
}): string {
  return sha256Base64Url(canonicalJson({
    type: "mino.admin.governance.proposal.v1",
    organizationId: input.organizationId,
    action: input.action,
    requestDigest: input.requestDigest,
    preconditionDigest: input.preconditionDigest,
  }));
}

function governanceKeyDigest(
  organizationId: string,
  action: AdminGovernanceAction,
  idempotencyKey: string,
): string {
  return sha256Base64Url(canonicalJson({
    type: "mino.admin.governance.idempotency.v1",
    organizationId,
    action,
    idempotencyKey,
  }));
}

function mandateIssuanceKeyDigest(organizationId: string, idempotencyKey: string): string {
  return sha256Base64Url(canonicalJson({
    type: "mino.admin.mandate.idempotency.v1",
    organizationId,
    idempotencyKey,
  }));
}

function governanceProjection(
  row: GovernanceRow,
  now: Date,
  votes?: readonly AdminGovernanceVoteProjection[],
): AdminGovernanceRequestProjection {
  const permission = validatedRequiredPermission(row.action, row.requiredPermission);
  const proposal = asRecord(row.proposalPayload);
  const effectiveStatus =
    (row.status === "PENDING" || row.status === "APPROVED") && row.expiresAt.getTime() <= now.getTime()
      ? "EXPIRED"
      : row.status;
  return {
    id: row.id,
    organizationId: row.organizationId,
    action: row.action,
    requiredPermission: permission,
    proposerPrincipalId: row.proposerPrincipalId,
    proposerMembershipId: row.proposerMembershipId,
    proposalDigest: row.proposalDigest,
    preconditionDigest: row.preconditionDigest,
    targetType: row.targetType === "policy" ? "policy" : "mandate",
    ...(row.targetId ? { targetId: row.targetId } : {}),
    proposal,
    status: effectiveStatus,
    requiredApprovals: row.requiredApprovals,
    voteCount: row.voteCount ?? votes?.length ?? 0,
    approveCount: row.approveCount ?? votes?.filter((vote) => vote.decision === "APPROVE").length ?? 0,
    rejectCount: row.rejectCount ?? votes?.filter((vote) => vote.decision === "REJECT").length ?? 0,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    ...(row.approvedAt ? { approvedAt: row.approvedAt.toISOString() } : {}),
    ...(row.resolvedAt ? { resolvedAt: row.resolvedAt.toISOString() } : {}),
    ...(row.appliedAt ? { appliedAt: row.appliedAt.toISOString() } : {}),
    ...(row.resultResourceType ? { resultResourceType: row.resultResourceType } : {}),
    ...(row.resultResourceId ? { resultResourceId: row.resultResourceId } : {}),
    ...(votes ? { votes } : {}),
  };
}

function governanceAuditState(row: GovernanceRow, now: Date) {
  const projection = governanceProjection(row, now);
  return {
    id: projection.id,
    organizationId: projection.organizationId,
    action: projection.action,
    requiredPermission: projection.requiredPermission,
    proposerPrincipalId: projection.proposerPrincipalId,
    proposerMembershipId: projection.proposerMembershipId,
    proposalDigest: projection.proposalDigest,
    preconditionDigest: projection.preconditionDigest,
    targetType: projection.targetType,
    targetId: projection.targetId ?? null,
    proposal: projection.proposal,
    status: projection.status,
    requiredApprovals: projection.requiredApprovals,
    voteCount: projection.voteCount,
    approveCount: projection.approveCount,
    rejectCount: projection.rejectCount,
    createdAt: projection.createdAt,
    expiresAt: projection.expiresAt,
    approvedAt: projection.approvedAt ?? null,
    resolvedAt: projection.resolvedAt ?? null,
    appliedAt: projection.appliedAt ?? null,
    resultResourceType: projection.resultResourceType ?? null,
    resultResourceId: projection.resultResourceId ?? null,
  };
}

async function governanceTransitionAudit(
  audit: Pick<PostgresAdminChangeAuditLedger, "appendInTransaction">,
  tx: AdminAuditSqlExecutor,
  actor: AdminGovernanceActor,
  after: GovernanceRow,
  permission: AdminPermission,
  requestId: string,
  timestamp: Date,
  action: string,
  before?: GovernanceRow,
  metadata?: Readonly<Record<string, unknown>>,
): Promise<AdminAuditAppendResult> {
  return audit.appendInTransaction(tx, {
    requestId,
    organizationId: actor.organizationId,
    principalId: actor.principalId,
    membershipId: actor.membershipId,
    timestamp,
    permission,
    action,
    resourceType: "admin_governance_request",
    resourceId: after.id,
    roles: actor.roles,
    ...(before ? { beforeState: governanceAuditState(before, timestamp) } : {}),
    afterState: governanceAuditState(after, timestamp),
    requestDigest: sha256Base64Url(canonicalJson({
      type: "mino.admin.governance.transition.v1",
      organizationId: actor.organizationId,
      governanceRequestId: after.id,
      proposalDigest: after.proposalDigest,
      action,
    })),
    metadata: {
      governanceAction: after.action,
      proposalDigest: after.proposalDigest,
      ...(metadata ?? {}),
    },
  });
}

function governanceMutationMetadata(
  row: GovernanceRow,
  approvedVotes: readonly AdminGovernanceVoteProjection[],
) {
  return {
    governanceRequestId: row.id,
    governanceProposalDigest: row.proposalDigest,
    governanceProposerPrincipalId: row.proposerPrincipalId,
    governanceApproverPrincipalIds: approvedVotes.map((vote) => vote.principalId),
  };
}

function policyDetailFromRow(row: PolicyTargetRow): AdminPolicyDetail {
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
    approvalMode: row.approvalMode,
    maxTransactionsPerMinute: row.maxTransactionsPerMinute,
    crossMerchantWindowSecs: row.crossMerchantWindowSecs,
    maxDistinctMerchants: row.maxDistinctMerchants,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function policyAuditState(row: PolicyTargetRow) {
  return {
    ...policyDetailFromRow(row),
  };
}

function mandateDetailFromRow(row: MandateInsertRow): AdminMandateDetail {
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

function mandateAuditState(row: MandateInsertRow) {
  return {
    ...mandateDetailFromRow(row),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    delegationPayloadHash: row.delegationPayloadHash,
  };
}

function mandateAuthorityPayloadDigest(input: {
  readonly organizationId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly policy: PolicyTargetRow;
  readonly expiresAt: Date;
}): string {
  const policy = input.policy;
  return sha256Base64Url(canonicalJson({
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
  }));
}

function parsePolicyExecutionPayload(value: unknown): { readonly policyId: string } {
  const record = asRecord(value);
  return { policyId: requireUuid(String(record.policyId ?? ""), "policyId") };
}

function parseMandateExecutionPayload(value: unknown): AdminGovernanceMandateIssueRequest {
  const record = asRecord(value);
  return {
    userId: requireUuid(String(record.userId ?? ""), "userId"),
    agentId: requireUuid(String(record.agentId ?? ""), "agentId"),
    policyId: requireUuid(String(record.policyId ?? ""), "policyId"),
    expiresAt: String(record.expiresAt ?? ""),
    idempotencyKey: normalizeIdempotencyKey(String(record.idempotencyKey ?? "")),
  };
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Governance payload is malformed");
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireVoteDecision(value: AdminGovernanceVoteDecision): AdminGovernanceVoteDecision {
  if (!ADMIN_GOVERNANCE_VOTE_DECISIONS.includes(value)) {
    throw new AdminGovernanceValidationError("decision is invalid");
  }
  return value;
}

function normalizeComment(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length > 1000) throw new AdminGovernanceValidationError("comment is too long");
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeIdempotencyKey(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new AdminGovernanceValidationError("idempotency key is invalid");
  }
  return value;
}

function normalizeFutureDate(value: string, now: Date, field: string): Date {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) {
    throw new AdminGovernanceValidationError(`${field} is invalid`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= now.getTime()) {
    throw new AdminGovernanceValidationError(`${field} must be in the future`);
  }
  return parsed;
}

function validNow(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new AdminGovernanceValidationError("current time is invalid");
  }
  return value;
}

function requireUuid(value: string, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new AdminGovernanceValidationError(`${field} must be a UUID`);
  }
  return value;
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new AdminGovernanceValidationError("limit is invalid");
  }
  return value;
}

function encodeCursor(cursor: GovernanceCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): GovernanceCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    const record = asRecord(parsed);
    const createdAt = String(record.createdAt ?? "");
    const id = String(record.id ?? "");
    if (!Number.isFinite(new Date(createdAt).getTime()) || !UUID_PATTERN.test(id)) throw new Error("bad cursor");
    return { createdAt, id };
  } catch {
    throw new AdminGovernanceValidationError("cursor is invalid");
  }
}

async function rollbackPreserving(tx: Awaited<ReturnType<AdminAuditSqlClient["connect"]>>): Promise<void> {
  try {
    await tx.query("rollback");
  } catch {
    // Preserve the original error.
  }
}
