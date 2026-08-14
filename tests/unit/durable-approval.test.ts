import { describe, expect, it } from "vitest";
import { ApprovalMode, type AgentSpendMandate } from "../../src/domain/mandates/mandate.types.js";
import { DecisionReason } from "../../src/domain/evaluation/decision-reasons.js";
import { DecisionVerdict, type PolicyDecision, type SpendState } from "../../src/domain/evaluation/evaluation.types.js";
import {
  ApprovalRequestStatus,
  DurableHumanApprovalService,
  approvalCoversDecision,
  blockApprovalDecision,
  grantApprovedDecision,
} from "../../src/modules/approvals/durable-approval.service.js";
import {
  BeginApprovalRequestKind,
  type ApprovalRequestRecord,
  type ApprovalRequestStore,
  type BeginApprovalRequestInput,
  type CastApprovalVoteInput,
} from "../../src/modules/approvals/approval-request.store.js";

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

function mandate(): AgentSpendMandate {
  return {
    id: "mandate-1",
    organizationId: "org-1",
    userId: "user-1",
    agentId: "agent-1",
    policyId: "policy-1",
    policyVersion: 3,
    currency: "USD",
    maxBudgetPerTransactionMinor: 4_000n,
    rollingDailyLimitMinor: 20_000n,
    approvedMerchantDomains: ["merchant.example"],
    approvedVendorIds: [],
    restrictedCategories: [],
    approvalMode: ApprovalMode.DUAL_SIGNATURE_SLACK,
    velocity: {
      maxTransactionsPerMinute: 10,
      crossMerchantWindowSeconds: 60,
      maxDistinctMerchantsInWindow: 5,
    },
    issuedAt: new Date(now.getTime() - 60_000),
    expiresAt: new Date(now.getTime() + 3_600_000),
    signingKeyId: "mino-k1",
    tokenJtiHash: "a".repeat(64),
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

  it("persists the durable request before notification and keeps it after emitter failure", async () => {
    const order: string[] = [];
    let stored: ApprovalRequestRecord | undefined;

    const store: ApprovalRequestStore = {
      async getById(id) {
        return stored?.id === id ? stored : undefined;
      },
      async getByIdempotency(organizationId, idempotencyKey) {
        return stored?.organizationId === organizationId && stored.idempotencyKey === idempotencyKey
          ? stored
          : undefined;
      },
      async begin(input: BeginApprovalRequestInput) {
        order.push("persist");
        stored = {
          id: input.id,
          organizationId: input.organizationId,
          userId: input.userId,
          agentId: input.agentId,
          mandateId: input.mandateId,
          decisionId: input.decisionId,
          requestId: input.requestId,
          idempotencyKey: input.idempotencyKey,
          requestDigest: input.requestDigest,
          policyVersion: input.policyVersion,
          merchantId: input.merchantId,
          merchantDomain: input.merchantDomain,
          ...(input.checkoutSessionId ? { checkoutSessionId: input.checkoutSessionId } : {}),
          requestedPayload: input.requestedPayload,
          ...(input.sessionSnapshot !== undefined ? { sessionSnapshot: input.sessionSnapshot } : {}),
          ...(input.spendSnapshot !== undefined ? { spendSnapshot: input.spendSnapshot } : {}),
          reasonCodes: input.reasonCodes,
          amountMinor: input.amountMinor,
          currency: input.currency,
          status: ApprovalRequestStatus.PENDING,
          requiredSignatures: input.requiredSignatures,
          createdAt: input.now,
          expiresAt: input.expiresAt,
          votes: [],
        };
        return { kind: BeginApprovalRequestKind.CREATED, request: stored };
      },
      async castVote(_input: CastApprovalVoteInput) {
        throw new Error("not used");
      },
      async expirePending() {
        if (!stored) {
          throw new Error("not stored");
        }
        return stored;
      },
    };

    const service = new DurableHumanApprovalService(
      store,
      {
        async emit(event) {
          expect(stored?.id).toBe(event.approvalRequestId);
          order.push("emit");
          throw new Error("simulated approval notification outage");
        },
      },
      () => "approval-persisted-before-notify",
    );

    await expect(
      service.requestApproval({
        decision: pendingDecision([
          DecisionReason.TRANSACTION_LIMIT_EXCEEDED,
          DecisionReason.HUMAN_APPROVAL_REQUIRED,
        ]),
        mandate: mandate(),
        merchantId: "merchant-1",
        merchantDomain: "merchant.example",
        checkoutSessionId: "cs_1",
        idempotencyKey: "idem-persist-first",
        requestDigest: "digest-persist-first",
        requestedPayload: { payment_data: { token: "secret" } },
        sessionSnapshot: { id: "cs_1", status: "ready_for_payment" },
        spend: spend(0n),
        now,
      }),
    ).rejects.toThrow(/notification outage/);

    expect(order).toEqual(["persist", "emit"]);
    expect(stored?.status).toBe(ApprovalRequestStatus.PENDING);
    expect(stored?.idempotencyKey).toBe("idem-persist-first");
  });
});
