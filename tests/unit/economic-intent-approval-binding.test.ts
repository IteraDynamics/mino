import { describe, expect, it } from "vitest";
import { DecisionReason } from "../../src/domain/evaluation/decision-reasons.js";
import { DecisionVerdict, type PolicyDecision } from "../../src/domain/evaluation/evaluation.types.js";
import { approvalCoversDecision } from "../../src/modules/approvals/durable-approval.service.js";
import { ApprovalRequestStatus, type ApprovalRequestRecord } from "../../src/modules/approvals/approval-request.store.js";

const now = new Date("2026-08-25T13:00:00.000Z");
const approvedIntent = "A".repeat(43);

function decision(intentDigest: string): PolicyDecision {
  return {
    decisionId: "decision-retry",
    requestId: "request-retry",
    verdict: DecisionVerdict.PENDING_HUMAN_APPROVAL,
    reasons: [
      DecisionReason.TRANSACTION_LIMIT_EXCEEDED,
      DecisionReason.HUMAN_APPROVAL_REQUIRED,
    ],
    requestedAmount: { currency: "USD", minorUnits: 5_000n },
    policyAmount: { currency: "USD", minorUnits: 5_000n },
    mandateId: "mandate-1",
    policyId: "policy-1",
    policyVersion: 3,
    intentDigest,
    eligibleForDelegationAssertion: false,
    approval: {
      required: true,
      approvalMode: "OWNER_APPROVAL",
      expiresAt: new Date(now.getTime() + 300_000),
    },
    evaluationLatencyMicros: 10,
    evaluatedAt: now,
  };
}

const approval: ApprovalRequestRecord = {
  id: "approval-1",
  organizationId: "org-1",
  userId: "user-1",
  agentId: "agent-1",
  mandateId: "mandate-1",
  decisionId: "decision-original",
  requestId: "request-original",
  idempotencyKey: "idem-1",
  requestDigest: "request-digest",
  intentDigest: approvedIntent,
  policyVersion: 3,
  merchantId: "merchant-1",
  merchantDomain: "merchant.example",
  checkoutSessionId: "cs-1",
  requestedPayload: {},
  reasonCodes: [
    DecisionReason.TRANSACTION_LIMIT_EXCEEDED,
    DecisionReason.HUMAN_APPROVAL_REQUIRED,
  ],
  amountMinor: 5_000n,
  currency: "USD",
  status: ApprovalRequestStatus.APPROVED,
  requiredSignatures: 1,
  createdAt: now,
  expiresAt: new Date(now.getTime() + 300_000),
  resolvedAt: now,
  votes: [],
};

describe("EconomicIntent approval binding", () => {
  it("covers an exact retry of the approved canonical intent", () => {
    expect(approvalCoversDecision(approval, decision(approvedIntent))).toBe(true);
  });

  it("makes approval stale when authoritative state produces a new intent digest", () => {
    expect(approvalCoversDecision(approval, decision("B".repeat(43)))).toBe(false);
  });

  it("fails closed when only one side of an approval is intent-bound", () => {
    const { intentDigest: _omitted, ...legacyApproval } = approval;
    const { intentDigest: _decisionOmitted, ...legacyDecision } = decision(approvedIntent);

    expect(approvalCoversDecision(legacyApproval, decision(approvedIntent))).toBe(false);
    expect(approvalCoversDecision(approval, legacyDecision)).toBe(false);
  });
});
