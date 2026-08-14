import type { AgentSpendMandate } from "../../domain/mandates/mandate.types.js";
import { DecisionReason } from "../../domain/evaluation/decision-reasons.js";
import type { PolicyDecision, SpendState } from "../../domain/evaluation/evaluation.types.js";
import { DecisionVerdict } from "../../domain/evaluation/evaluation.types.js";
import { redactSensitivePayload } from "../audit/audit-sink.js";
import type { HumanApprovalEmitter } from "./approval-emitter.js";
import {
  ApprovalRequestStatus,
  ApprovalVoteDecision,
  BeginApprovalRequestKind,
  type ApprovalRequestRecord,
  type ApprovalRequestStore,
} from "./approval-request.store.js";

export interface DurableApprovalRequestInput {
  readonly decision: PolicyDecision;
  readonly mandate: AgentSpendMandate;
  readonly merchantId: string;
  readonly merchantDomain: string;
  readonly checkoutSessionId?: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly requestedPayload: unknown;
  readonly sessionSnapshot?: unknown;
  readonly spend?: SpendState;
  readonly now: Date;
}

export interface ApprovalVoteInput {
  readonly approvalRequestId: string;
  readonly approverId: string;
  readonly decision: ApprovalVoteDecision;
  readonly comment?: string;
  readonly metadata?: unknown;
  readonly now: Date;
}

export class ApprovalRequestConflictError extends Error {
  public constructor() {
    super("Approval idempotency key was reused for a different request");
    this.name = "ApprovalRequestConflictError";
  }
}

export interface HumanApprovalService {
  requestApproval(input: DurableApprovalRequestInput): Promise<ApprovalRequestRecord>;
  getById(approvalRequestId: string, now: Date): Promise<ApprovalRequestRecord | undefined>;
  getByIdempotency(
    organizationId: string,
    idempotencyKey: string,
    requestDigest: string,
    now: Date,
  ): Promise<ApprovalRequestRecord | undefined>;
  castVote(input: ApprovalVoteInput): Promise<ApprovalRequestRecord>;
}

export class DurableHumanApprovalService implements HumanApprovalService {
  public constructor(
    private readonly store: ApprovalRequestStore,
    private readonly emitter: HumanApprovalEmitter,
    private readonly generateId: () => string,
  ) {}

  public async requestApproval(
    input: DurableApprovalRequestInput,
  ): Promise<ApprovalRequestRecord> {
    if (
      input.decision.verdict !== DecisionVerdict.PENDING_HUMAN_APPROVAL ||
      !input.decision.approval ||
      !input.decision.policyAmount
    ) {
      throw new Error("Only a pending human-approval decision can create an approval request");
    }

    const begun = await this.store.begin({
      id: this.generateId(),
      organizationId: input.mandate.organizationId,
      userId: input.mandate.userId,
      agentId: input.mandate.agentId,
      mandateId: input.mandate.id,
      decisionId: input.decision.decisionId,
      requestId: input.decision.requestId,
      idempotencyKey: input.idempotencyKey,
      requestDigest: input.requestDigest,
      policyVersion: input.mandate.policyVersion,
      merchantId: input.merchantId,
      merchantDomain: input.merchantDomain,
      ...(input.checkoutSessionId ? { checkoutSessionId: input.checkoutSessionId } : {}),
      requestedPayload: redactSensitivePayload(input.requestedPayload),
      ...(input.sessionSnapshot !== undefined
        ? { sessionSnapshot: redactSensitivePayload(input.sessionSnapshot) }
        : {}),
      ...(input.spend ? { spendSnapshot: serializeSpend(input.spend) } : {}),
      reasonCodes: input.decision.reasons,
      amountMinor: input.decision.policyAmount.minorUnits,
      currency: input.decision.policyAmount.currency,
      requiredSignatures: requiredSignatures(input.decision.approval.approvalMode),
      expiresAt: input.decision.approval.expiresAt,
      now: input.now,
    });

    if (begun.kind === BeginApprovalRequestKind.CONFLICT) {
      throw new ApprovalRequestConflictError();
    }

    const request = begun.request;
    if (request.status === ApprovalRequestStatus.PENDING && input.now < request.expiresAt) {
      await this.emitter.emit({
        eventId: request.id,
        approvalRequestId: request.id,
        type: "mino.approval.required",
        createdAt: request.createdAt.toISOString(),
        decisionId: request.decisionId,
        requestId: request.requestId,
        organizationId: request.organizationId,
        userId: request.userId,
        agentId: request.agentId,
        mandateId: request.mandateId,
        merchantDomain: request.merchantDomain,
        ...(request.checkoutSessionId
          ? { checkoutSessionId: request.checkoutSessionId }
          : {}),
        amountMinor: request.amountMinor.toString(10),
        currency: request.currency,
        approvalMode: input.decision.approval.approvalMode,
        expiresAt: request.expiresAt.toISOString(),
      });
    }

    return request;
  }

  public async getById(
    approvalRequestId: string,
    now: Date,
  ): Promise<ApprovalRequestRecord | undefined> {
    const request = await this.store.getById(approvalRequestId);
    return request ? this.expireIfNeeded(request, now) : undefined;
  }

  public async getByIdempotency(
    organizationId: string,
    idempotencyKey: string,
    requestDigest: string,
    now: Date,
  ): Promise<ApprovalRequestRecord | undefined> {
    const request = await this.store.getByIdempotency(organizationId, idempotencyKey);
    if (!request) {
      return undefined;
    }
    if (request.requestDigest !== requestDigest) {
      throw new ApprovalRequestConflictError();
    }
    return this.expireIfNeeded(request, now);
  }

  public async castVote(input: ApprovalVoteInput): Promise<ApprovalRequestRecord> {
    if (!input.approverId.trim()) {
      throw new Error("Approver identity is required");
    }
    return this.store.castVote({
      approvalRequestId: input.approvalRequestId,
      approverId: input.approverId.trim(),
      decision: input.decision,
      ...(input.comment ? { comment: input.comment } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      now: input.now,
    });
  }

  private async expireIfNeeded(
    request: ApprovalRequestRecord,
    now: Date,
  ): Promise<ApprovalRequestRecord> {
    if (request.status === ApprovalRequestStatus.PENDING && now >= request.expiresAt) {
      return this.store.expirePending(request.id, now);
    }
    return request;
  }
}

export function approvalCoversDecision(
  request: ApprovalRequestRecord,
  decision: PolicyDecision,
  currentSpend?: SpendState,
): boolean {
  if (request.status !== ApprovalRequestStatus.APPROVED) {
    return false;
  }
  if (request.policyVersion !== decision.policyVersion || request.mandateId !== decision.mandateId) {
    return false;
  }
  if (!decision.policyAmount || request.currency !== decision.policyAmount.currency) {
    return false;
  }
  if (request.amountMinor !== decision.policyAmount.minorUnits) {
    return false;
  }

  const approvedReasons = new Set(request.reasonCodes);
  const currentEscalationReasons = decision.reasons.filter(
    (reason) =>
      reason === DecisionReason.TRANSACTION_LIMIT_EXCEEDED ||
      reason === DecisionReason.DAILY_LIMIT_EXCEEDED,
  );
  if (currentEscalationReasons.length === 0) {
    return false;
  }
  if (!currentEscalationReasons.every((reason) => approvedReasons.has(reason))) {
    return false;
  }

  if (currentEscalationReasons.includes(DecisionReason.DAILY_LIMIT_EXCEEDED)) {
    const approvedSpend = parseSpendSnapshot(request.spendSnapshot);
    if (!approvedSpend || !currentSpend) {
      return false;
    }
    const approvedPrior = approvedSpend.committedMinor + approvedSpend.reservedMinor;
    const currentPrior =
      currentSpend.committedDailySpend.minorUnits + currentSpend.reservedDailySpend.minorUnits;
    if (currentPrior > approvedPrior) {
      return false;
    }
  }

  return true;
}

export function grantApprovedDecision(decision: PolicyDecision): PolicyDecision {
  if (decision.verdict !== DecisionVerdict.PENDING_HUMAN_APPROVAL || !decision.policyAmount) {
    return decision;
  }
  const { approval: _approval, approvedAmount: _priorApprovedAmount, ...rest } = decision;
  return {
    ...rest,
    verdict: DecisionVerdict.ALLOW,
    reasons: [
      ...decision.reasons.filter((reason) => reason !== DecisionReason.HUMAN_APPROVAL_REQUIRED),
      DecisionReason.HUMAN_APPROVAL_GRANTED,
    ],
    approvedAmount: decision.policyAmount,
    eligibleForDelegationAssertion: true,
  };
}

export function blockApprovalDecision(
  decision: PolicyDecision,
  reason:
    | DecisionReason.HUMAN_APPROVAL_REJECTED
    | DecisionReason.HUMAN_APPROVAL_EXPIRED
    | DecisionReason.HUMAN_APPROVAL_STALE,
): PolicyDecision {
  if (decision.verdict !== DecisionVerdict.PENDING_HUMAN_APPROVAL) {
    return decision;
  }
  const { approval: _approval, approvedAmount: _approvedAmount, ...rest } = decision;
  return {
    ...rest,
    verdict: DecisionVerdict.BLOCK,
    reasons: [
      ...decision.reasons.filter((entry) => entry !== DecisionReason.HUMAN_APPROVAL_REQUIRED),
      reason,
    ],
    eligibleForDelegationAssertion: false,
  };
}

function requiredSignatures(approvalMode: string): number {
  return approvalMode === "DUAL_SIGNATURE_SLACK" ? 2 : 1;
}

function serializeSpend(spend: SpendState): Record<string, string> {
  return {
    currency: spend.committedDailySpend.currency,
    committedMinor: spend.committedDailySpend.minorUnits.toString(10),
    reservedMinor: spend.reservedDailySpend.minorUnits.toString(10),
  };
}

function parseSpendSnapshot(
  value: unknown,
): { readonly committedMinor: bigint; readonly reservedMinor: bigint } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.committedMinor !== "string" || typeof record.reservedMinor !== "string") {
    return undefined;
  }
  try {
    return {
      committedMinor: BigInt(record.committedMinor),
      reservedMinor: BigInt(record.reservedMinor),
    };
  } catch {
    return undefined;
  }
}

export { ApprovalRequestStatus, ApprovalVoteDecision };
