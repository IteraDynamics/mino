import { describe, expect, it } from "vitest";
import { DecisionReason } from "../../src/domain/evaluation/decision-reasons.js";
import { DecisionVerdict, type PolicyDecision, type SpendState } from "../../src/domain/evaluation/evaluation.types.js";
import {
  ApprovalRequestStatus,
  approvalCoversDecision,
  blockApprovalDecision,
  grantApprovedDecision,
} from "../../src/modules/approvals/durable-approval.service.js";
import type { ApprovalRequestRecord } from "../../src/modules/approvals/approval-request.store.js";

const now = new Date("2026-08-14T16:00:00.000Z");

function pendingDecision(reasons: readonly DecisionReason[]): PolicyDecision {
  return {
    decisionId: "decision-1",
    requestId: "request-1",
    verdict: DecisionVerdict.PENDING_HUMAN_APPROVAL,
    reasons,
    requestedAmount: { currency: "USD", minorUnits: 5_000n },
    policyAmount: { currency: "USD", minorUnits: 5_000n },
    mandateId: "mandate-1",
    policyId: "policy-1",
    policyVersion: 3,
    eligibleForDelegationAssertion: false,
    approval: {
      required: true,
      approvalMode: "DUAL_SIGNATURE_SLACK",
      expiresAt: new Date(now.getTime() + 300_000),
    },
    evaluationLatencyMicros: 50,
    evaluatedAt: now,
  };
}

function approval(args: {
  reasons?: readonly string[];
  status?: ApprovalRequestStatus;
  spendSnapshot?: unknown;
  amountMinor?: bigint;
  policyVersion?: number;
} = {}): ApprovalRequestRecord {
  return {
    id: "approval-1",
    organizationId: "org-1",
    userId: "user-1",
    agentId: "agent-1",
    mandateId: "mandate-1",
    decisionId: "decision-original",
    requestId: "request-original",
    idempotencyKey: "idem-1",
    requestDigest: "digest-1",
    policyVersion: args.policyVersion ?? 3,
    merchantId: "merchant-1",
    merchantDomain: "merchant.example",
    checkoutSessionId: "cs_1",
    requestedPayload: {},
    sessionSnapshot: {},
    ...(args.spendSnapshot !== undefined ? { spendSnapshot: args.spendSnapshot } : {}),
    reasonCodes: args.reasons ?? [DecisionReason.TRANSACTION_LIMIT_EXCEEDED],
    amountMinor: args.amountMinor ?? 5_000n,
    currency: "USD",
    status: args.status ?? ApprovalRequestStatus.APPROVED,
    requiredSignatures: 2,
    createdAt: now,
    expiresAt: new Date(now.getTime() + 300_000),
    resolvedAt: now,
    votes: [],
  };
}

function spend(committedMinor: bigint, reservedMinor = 0n): SpendState {
  return {
    committedDailySpend: { currency: "USD", minorUnits: committedMinor },
    reservedDailySpend: { currency: "USD", minorUnits: reservedMinor },
  };
}

describe("durable human approval revalidation", () => {
  it("grants only the same approved soft transaction-limit breach", () => {
    const decision = pendingDecision([
      DecisionReason.TRANSACTION_LIMIT_EXCEEDED,
      DecisionReason.HUMAN_APPROVAL_REQUIRED,
    ]);

    expect(approvalCoversDecision(approval(), decision, spend(0n))).toBe(true);

    const granted = grantApprovedDecision(decision);
    expect(granted.verdict).toBe(DecisionVerdict.ALLOW);
    expect(granted.reasons).toContain(DecisionReason.HUMAN_APPROVAL_GRANTED);
    expect(granted.reasons).not.toContain(DecisionReason.HUMAN_APPROVAL_REQUIRED);
    expect(granted.approvedAmount?.minorUnits).toBe(5_000n);
    expect(granted.approval).toBeUndefined();
  });

  it("does not let an old transaction-limit approval cover a newly discovered daily-limit breach", () => {
    const decision = pendingDecision([
      DecisionReason.TRANSACTION_LIMIT_EXCEEDED,
      DecisionReason.DAILY_LIMIT_EXCEEDED,
      DecisionReason.HUMAN_APPROVAL_REQUIRED,
    ]);

    expect(approvalCoversDecision(approval(), decision, spend(19_000n))).toBe(false);
  });

  it("makes a daily-limit approval stale when prior spend increases after review", () => {
    const decision = pendingDecision([
      DecisionReason.DAILY_LIMIT_EXCEEDED,
      DecisionReason.HUMAN_APPROVAL_REQUIRED,
    ]);
    const approved = approval({
      reasons: [DecisionReason.DAILY_LIMIT_EXCEEDED, DecisionReason.HUMAN_APPROVAL_REQUIRED],
      spendSnapshot: {
        currency: "USD",
        committedMinor: "18000",
        reservedMinor: "0",
      },
    });

    expect(approvalCoversDecision(approved, decision, spend(18_000n))).toBe(true);
    expect(approvalCoversDecision(approved, decision, spend(18_001n))).toBe(false);
  });

  it("fails closed for changed amount, policy version, or non-approved status", () => {
    const decision = pendingDecision([
      DecisionReason.TRANSACTION_LIMIT_EXCEEDED,
      DecisionReason.HUMAN_APPROVAL_REQUIRED,
    ]);

    expect(approvalCoversDecision(approval({ amountMinor: 5_001n }), decision)).toBe(false);
    expect(approvalCoversDecision(approval({ policyVersion: 4 }), decision)).toBe(false);
    expect(
      approvalCoversDecision(approval({ status: ApprovalRequestStatus.REJECTED }), decision),
    ).toBe(false);
  });

  it("converts rejection/expiry/staleness into hard non-delegable blocks", () => {
    const decision = pendingDecision([
      DecisionReason.TRANSACTION_LIMIT_EXCEEDED,
      DecisionReason.HUMAN_APPROVAL_REQUIRED,
    ]);

    for (const reason of [
      DecisionReason.HUMAN_APPROVAL_REJECTED,
      DecisionReason.HUMAN_APPROVAL_EXPIRED,
      DecisionReason.HUMAN_APPROVAL_STALE,
    ] as const) {
      const blocked = blockApprovalDecision(decision, reason);
      expect(blocked.verdict).toBe(DecisionVerdict.BLOCK);
      expect(blocked.reasons).toContain(reason);
      expect(blocked.eligibleForDelegationAssertion).toBe(false);
      expect(blocked.approval).toBeUndefined();
    }
  });
});
