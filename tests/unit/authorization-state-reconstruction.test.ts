import { describe, expect, it, vi } from "vitest";
import type { AgentSpendMandate } from "../../src/domain/mandates/mandate.types.js";
import { ApprovalMode } from "../../src/domain/mandates/mandate.types.js";
import type {
  AuthorizationReservations,
  ReservationAttemptResult,
} from "../../src/modules/spending/authorization-reservation.service.js";
import { ReservationStatus } from "../../src/modules/spending/authorization-reservation.service.js";
import {
  AuthorizationStateUnavailableError,
  ReconstructingAuthorizationReservations,
  type RedisAuthorizationStateReconstructor,
} from "../../src/modules/spending/authorization-state-reconstruction.js";

const now = new Date("2026-08-15T01:30:00.000Z");
const mandate: AgentSpendMandate = {
  id: "reconstruction-unit-mandate",
  organizationId: "org",
  userId: "user",
  agentId: "agent",
  policyId: "policy",
  policyVersion: 1,
  currency: "USD",
  maxBudgetPerTransactionMinor: 10_000n,
  rollingDailyLimitMinor: 20_000n,
  approvedMerchantDomains: ["merchant.example"],
  approvedVendorIds: [],
  restrictedCategories: [],
  approvalMode: ApprovalMode.AUTO_APPROVE,
  velocity: {
    maxTransactionsPerMinute: 10,
    crossMerchantWindowSeconds: 60,
    maxDistinctMerchantsInWindow: 5,
  },
  issuedAt: new Date(now.getTime() - 60_000),
  expiresAt: new Date(now.getTime() + 60_000),
  signingKeyId: "k1",
  tokenJtiHash: "hash",
};

const reservationResult: ReservationAttemptResult = {
  status: ReservationStatus.RESERVED,
  reservationId: "reservation-1",
  spend: {
    committedDailySpend: { currency: "USD", minorUnits: 0n },
    reservedDailySpend: { currency: "USD", minorUnits: 0n },
  },
  velocity: {
    transactionsLastMinute: 0,
    distinctMerchantsInWindow: 0,
    attemptedAmountLastMinute: { currency: "USD", minorUnits: 0n },
    merchantDomainsInWindow: [],
  },
  replayed: false,
  dailyLimitOverridden: false,
};

describe("ReconstructingAuthorizationReservations", () => {
  it("fails closed when the reconstruction marker disappears during an authorization operation", async () => {
    const inner = fakeReservations();
    const reconstructor = {
      ensureMandateReady: vi.fn(async () => ({
        mandateId: mandate.id,
        committed: 0,
        unresolved: 0,
        attempts: 0,
      })),
      isMandateReady: vi.fn(async () => false),
      reconstructMandate: vi.fn(),
    } as unknown as RedisAuthorizationStateReconstructor;
    const guarded = new ReconstructingAuthorizationReservations(inner, reconstructor, () => now);

    await expect(
      guarded.tryReserve({
        mandate,
        amount: { currency: "USD", minorUnits: 100n },
        merchantDomain: "merchant.example",
        requestId: "request-1",
        reservationId: "reservation-1",
        idempotencyKey: "idem-1",
        requestDigest: "digest-1",
        now,
      }),
    ).rejects.toBeInstanceOf(AuthorizationStateUnavailableError);

    expect(inner.tryReserve).toHaveBeenCalledTimes(1);
  });

  it("force-reconstructs and retries a commit when Redis lost reservation detail", async () => {
    const inner = fakeReservations();
    vi.mocked(inner.commit).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const reconstructor = {
      ensureMandateReady: vi.fn(async () => ({
        mandateId: mandate.id,
        committed: 0,
        unresolved: 0,
        attempts: 0,
      })),
      reconstructMandate: vi.fn(async () => ({
        mandateId: mandate.id,
        committed: 1,
        unresolved: 0,
        attempts: 1,
      })),
      isMandateReady: vi.fn(async () => true),
    } as unknown as RedisAuthorizationStateReconstructor;
    const guarded = new ReconstructingAuthorizationReservations(inner, reconstructor, () => now);

    await expect(guarded.commit(mandate.id, "reservation-1", now)).resolves.toBe(true);
    expect(inner.commit).toHaveBeenCalledTimes(2);
    expect(reconstructor.reconstructMandate).toHaveBeenCalledWith(mandate.id, now, true);
  });
});

function fakeReservations(): AuthorizationReservations & {
  tryReserve: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
} {
  return {
    tryReserve: vi.fn(async () => reservationResult),
    commit: vi.fn(async () => true),
    release: vi.fn(async () => true),
    releaseForApproval: vi.fn(async () => true),
    holdForReconciliation: vi.fn(async () => true),
  } as AuthorizationReservations & {
    tryReserve: ReturnType<typeof vi.fn>;
    commit: ReturnType<typeof vi.fn>;
  };
}
