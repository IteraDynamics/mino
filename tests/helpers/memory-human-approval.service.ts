import { DecisionReason } from "../../src/domain/evaluation/decision-reasons.js";
import {
  ApprovalRequestConflictError,
  ApprovalRequestStatus,
  ApprovalVoteDecision,
  type ApprovalVoteInput,
  type DurableApprovalRequestInput,
  type HumanApprovalService,
} from "../../src/modules/approvals/durable-approval.service.js";
import type {
  ApprovalRequestRecord,
  ApprovalVoteRecord,
} from "../../src/modules/approvals/approval-request.store.js";

export class MemoryHumanApprovalService implements HumanApprovalService {
  private readonly byKey = new Map<string, ApprovalRequestRecord>();
  private latestId?: string;
  public notificationCount = 0;

  public constructor(private readonly generateId: () => string) {}

  public async requestApproval(input: DurableApprovalRequestInput): Promise<ApprovalRequestRecord> {
    const key = this.key(input.mandate.organizationId, input.idempotencyKey);
    const existing = this.byKey.get(key);
    if (existing) {
      const intentMatches =
        input.decision.intentDigest === undefined ||
        existing.intentDigest === input.decision.intentDigest;
      if (existing.requestDigest !== input.requestDigest || !intentMatches) {
        throw new ApprovalRequestConflictError();
      }
      this.notificationCount += 1;
      this.latestId = existing.id;
      return existing;
    }
    if (!input.decision.policyAmount || !input.decision.approval) {
      throw new Error("Pending approval test decision is missing amount/approval metadata");
    }

    const request: ApprovalRequestRecord = {
      id: this.generateId(),
      organizationId: input.mandate.organizationId,
      userId: input.mandate.userId,
      agentId: input.mandate.agentId,
      mandateId: input.mandate.id,
      decisionId: input.decision.decisionId,
      requestId: input.decision.requestId,
      idempotencyKey: input.idempotencyKey,
      requestDigest: input.requestDigest,
      ...(input.decision.intentDigest ? { intentDigest: input.decision.intentDigest } : {}),
      policyVersion: input.mandate.policyVersion,
      merchantId: input.merchantId,
      merchantDomain: input.merchantDomain,
      ...(input.checkoutSessionId ? { checkoutSessionId: input.checkoutSessionId } : {}),
      requestedPayload: input.requestedPayload,
      ...(input.sessionSnapshot !== undefined ? { sessionSnapshot: input.sessionSnapshot } : {}),
      ...(input.spend ? { spendSnapshot: serializeSpend(input.spend) } : {}),
      reasonCodes: input.decision.reasons,
      amountMinor: input.decision.policyAmount.minorUnits,
      currency: input.decision.policyAmount.currency,
      status: ApprovalRequestStatus.PENDING,
      requiredSignatures:
        input.decision.approval.approvalMode === "DUAL_SIGNATURE_SLACK" ? 2 : 1,
      ...(input.decision.intentDigest
        ? { approvalData: { intentDigest: input.decision.intentDigest } }
        : {}),
      createdAt: input.now,
      expiresAt: input.decision.approval.expiresAt,
      votes: [],
    };
    this.byKey.set(key, request);
    this.latestId = request.id;
    this.notificationCount += 1;
    return request;
  }

  public async getById(
    approvalRequestId: string,
    now: Date,
  ): Promise<ApprovalRequestRecord | undefined> {
    const request = [...this.byKey.values()].find((entry) => entry.id === approvalRequestId);
    return request ? this.expire(request, now) : undefined;
  }

  public async getByIdempotency(
    organizationId: string,
    idempotencyKey: string,
    requestDigest: string,
    now: Date,
  ): Promise<ApprovalRequestRecord | undefined> {
    const request = this.byKey.get(this.key(organizationId, idempotencyKey));
    if (!request) {
      return undefined;
    }
    if (request.requestDigest !== requestDigest) {
      throw new ApprovalRequestConflictError();
    }
    return this.expire(request, now);
  }

  public async castVote(input: ApprovalVoteInput): Promise<ApprovalRequestRecord> {
    const request = await this.getById(input.approvalRequestId, input.now);
    if (!request) {
      throw new Error("Unknown approval request");
    }
    if (request.status !== ApprovalRequestStatus.PENDING) {
      return request;
    }
    const existing = request.votes.find((vote) => vote.approverId === input.approverId);
    if (existing) {
      return request;
    }
    const vote: ApprovalVoteRecord = {
      id: this.generateId(),
      approvalRequestId: request.id,
      approverId: input.approverId,
      decision: input.decision,
      ...(input.comment ? { comment: input.comment } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      createdAt: input.now,
    };
    const votes = [...request.votes, vote];
    const status =
      input.decision === ApprovalVoteDecision.REJECT
        ? ApprovalRequestStatus.REJECTED
        : votes.filter((entry) => entry.decision === ApprovalVoteDecision.APPROVE).length >=
            request.requiredSignatures
          ? ApprovalRequestStatus.APPROVED
          : ApprovalRequestStatus.PENDING;
    const updated: ApprovalRequestRecord = {
      ...request,
      votes,
      status,
      ...(status !== ApprovalRequestStatus.PENDING ? { resolvedAt: input.now } : {}),
    };
    this.byKey.set(this.key(request.organizationId, request.idempotencyKey), updated);
    return updated;
  }

  public async approveLatest(now: Date): Promise<ApprovalRequestRecord> {
    const request = this.latest();
    let current = request;
    for (let index = current.votes.length; index < current.requiredSignatures; index += 1) {
      current = await this.castVote({
        approvalRequestId: current.id,
        approverId: `approver-${index + 1}@example.test`,
        decision: ApprovalVoteDecision.APPROVE,
        now: new Date(now.getTime() + index),
      });
    }
    return current;
  }

  public async rejectLatest(now: Date): Promise<ApprovalRequestRecord> {
    const request = this.latest();
    return this.castVote({
      approvalRequestId: request.id,
      approverId: "rejector@example.test",
      decision: ApprovalVoteDecision.REJECT,
      now,
    });
  }

  public latest(): ApprovalRequestRecord {
    const id = this.latestId;
    const request = id ? [...this.byKey.values()].find((entry) => entry.id === id) : undefined;
    if (!request) {
      throw new Error("No approval request has been created");
    }
    return request;
  }

  public worsenLatestDailySpend(committedMinor: bigint): void {
    const request = this.latest();
    if (!request.reasonCodes.includes(DecisionReason.DAILY_LIMIT_EXCEEDED)) {
      throw new Error("Latest approval is not a daily-limit approval");
    }
    const updated = {
      ...request,
      spendSnapshot: {
        currency: request.currency,
        committedMinor: committedMinor.toString(10),
        reservedMinor: "0",
      },
    };
    this.byKey.set(this.key(request.organizationId, request.idempotencyKey), updated);
  }

  private expire(request: ApprovalRequestRecord, now: Date): ApprovalRequestRecord {
    if (request.status !== ApprovalRequestStatus.PENDING || now < request.expiresAt) {
      return request;
    }
    const updated: ApprovalRequestRecord = {
      ...request,
      status: ApprovalRequestStatus.EXPIRED,
      resolvedAt: now,
    };
    this.byKey.set(this.key(request.organizationId, request.idempotencyKey), updated);
    return updated;
  }

  private key(organizationId: string, idempotencyKey: string): string {
    return `${organizationId}|${idempotencyKey}`;
  }
}

function serializeSpend(spend: {
  readonly committedDailySpend: { readonly currency: string; readonly minorUnits: bigint };
  readonly reservedDailySpend: { readonly currency: string; readonly minorUnits: bigint };
}) {
  return {
    currency: spend.committedDailySpend.currency,
    committedMinor: spend.committedDailySpend.minorUnits.toString(10),
    reservedMinor: spend.reservedDailySpend.minorUnits.toString(10),
  };
}
