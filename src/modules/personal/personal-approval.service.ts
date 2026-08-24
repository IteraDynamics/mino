import type { QueryResultRow } from "pg";
import type {
  ApprovalRequestRecord,
  ApprovalVoteDecision,
} from "../approvals/approval-request.store.js";
import type { HumanApprovalService } from "../approvals/durable-approval.service.js";
import type {
  PersonalAuthenticatedIdentity,
  PersonalSqlClient,
} from "./personal-pairing.service.js";

const PERSONAL_POLICY_PREFIX = "__mino_personal_agent__:";

interface OwnerRow extends QueryResultRow {
  id: string;
  organizationId: string;
  userId: string;
  status: string;
  organizationKind: string;
  userStatus: string;
}

interface MandatePolicyRow extends QueryResultRow {
  status: string;
  expiresAt: Date;
  approvalMode: string;
  policyName: string;
}

export interface PersonalApprovalDetail {
  readonly id: string;
  readonly agentId: string;
  readonly mandateId: string;
  readonly status: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";
  readonly merchantId: string;
  readonly merchantDomain: string;
  readonly checkoutSessionId?: string;
  readonly amountMinor: string;
  readonly currency: string;
  readonly reasonCodes: readonly string[];
  readonly requestedPayload: unknown;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly resolvedAt?: string;
}

export type PersonalApprovalDecisionResult =
  | { readonly outcome: "UPDATED" | "REPLAYED"; readonly approval: PersonalApprovalDetail }
  | { readonly outcome: "OWNER_NOT_FOUND" | "APPROVAL_NOT_FOUND" | "NOT_PERSONAL_APPROVAL" };

/**
 * Owner-authenticated view/resolution wrapper around the existing durable approval
 * service. It only exposes approval requests that belong to the Personal owner's
 * beneficiary and were created from a Personal OWNER_APPROVAL mandate.
 */
export class PostgresPersonalApprovalService {
  public constructor(
    private readonly sql: PersonalSqlClient,
    private readonly approvals: Pick<HumanApprovalService, "getById" | "castVote">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async getApproval(
    identity: PersonalAuthenticatedIdentity,
    approvalRequestId: string,
  ): Promise<PersonalApprovalDetail | undefined> {
    const owner = await ownerByIdentity(this.sql, identity);
    if (!ownerIsActive(owner)) return undefined;
    const approval = await this.approvals.getById(approvalRequestId, this.now());
    if (!approval) return undefined;
    if (!(await approvalBelongsToPersonalOwner(this.sql, owner, approval, this.now()))) {
      return undefined;
    }
    return approvalResponse(approval);
  }

  public async decide(
    identity: PersonalAuthenticatedIdentity,
    approvalRequestId: string,
    decision: ApprovalVoteDecision,
    comment?: string,
  ): Promise<PersonalApprovalDecisionResult> {
    const owner = await ownerByIdentity(this.sql, identity);
    if (!ownerIsActive(owner)) return { outcome: "OWNER_NOT_FOUND" };

    const prior = await this.approvals.getById(approvalRequestId, this.now());
    if (!prior) return { outcome: "APPROVAL_NOT_FOUND" };
    if (!(await approvalBelongsToPersonalOwner(this.sql, owner, prior, this.now()))) {
      return { outcome: "NOT_PERSONAL_APPROVAL" };
    }

    const sameOwnerVote = prior.votes.find(
      (vote) => vote.approverId === personalApproverId(owner.id),
    );
    const updated = await this.approvals.castVote({
      approvalRequestId,
      approverId: personalApproverId(owner.id),
      decision,
      ...(comment ? { comment } : {}),
      metadata: { surface: "MINO_PERSONAL_OWNER" },
      now: this.now(),
    });

    return {
      outcome: sameOwnerVote?.decision === decision ? "REPLAYED" : "UPDATED",
      approval: approvalResponse(updated),
    };
  }
}

async function ownerByIdentity(
  sql: Pick<PersonalSqlClient, "query">,
  identity: PersonalAuthenticatedIdentity,
): Promise<OwnerRow | undefined> {
  const issuer = identity.issuer.trim();
  const subject = identity.subject.trim();
  if (!issuer || !subject) return undefined;
  return (
    await sql.query<OwnerRow>(
      `select p."id", p."organizationId", p."userId", p."status",
              o."kind"::text as "organizationKind", u."status"::text as "userStatus"
         from "PersonalOwner" p
         join "Organization" o on o."id" = p."organizationId"
         join "User" u on u."id" = p."userId" and u."organizationId" = p."organizationId"
        where p."issuer" = $1 and p."subject" = $2`,
      [issuer, subject],
    )
  ).rows[0];
}

function ownerIsActive(owner: OwnerRow | undefined): owner is OwnerRow {
  return Boolean(
    owner &&
      owner.status === "ACTIVE" &&
      owner.organizationKind === "PERSONAL" &&
      owner.userStatus === "ACTIVE",
  );
}

async function approvalBelongsToPersonalOwner(
  sql: Pick<PersonalSqlClient, "query">,
  owner: OwnerRow,
  approval: ApprovalRequestRecord,
  now: Date,
): Promise<boolean> {
  if (
    approval.organizationId !== owner.organizationId ||
    approval.userId !== owner.userId ||
    approval.requiredSignatures !== 1
  ) {
    return false;
  }

  const row = (
    await sql.query<MandatePolicyRow>(
      `select m."status"::text as "status", m."expiresAt",
              m."approvalMode"::text as "approvalMode", p."name" as "policyName"
         from "AgentMandate" m
         join "Policy" p on p."id" = m."policyId" and p."organizationId" = m."organizationId"
        where m."id" = $1::uuid and m."organizationId" = $2::uuid
          and m."userId" = $3::uuid and m."agentId" = $4::uuid`,
      [approval.mandateId, owner.organizationId, owner.userId, approval.agentId],
    )
  ).rows[0];

  return Boolean(
    row &&
      row.status === "ACTIVE" &&
      row.expiresAt.getTime() > now.getTime() &&
      row.approvalMode === "OWNER_APPROVAL" &&
      row.policyName.startsWith(PERSONAL_POLICY_PREFIX),
  );
}

function approvalResponse(approval: ApprovalRequestRecord): PersonalApprovalDetail {
  return {
    id: approval.id,
    agentId: approval.agentId,
    mandateId: approval.mandateId,
    status: approval.status,
    merchantId: approval.merchantId,
    merchantDomain: approval.merchantDomain,
    ...(approval.checkoutSessionId ? { checkoutSessionId: approval.checkoutSessionId } : {}),
    amountMinor: approval.amountMinor.toString(10),
    currency: approval.currency,
    reasonCodes: [...approval.reasonCodes],
    requestedPayload: approval.requestedPayload,
    createdAt: approval.createdAt.toISOString(),
    expiresAt: approval.expiresAt.toISOString(),
    ...(approval.resolvedAt ? { resolvedAt: approval.resolvedAt.toISOString() } : {}),
  };
}

function personalApproverId(ownerId: string): string {
  return `personal-owner:${ownerId}`;
}
