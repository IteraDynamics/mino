import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  authorityReferenceFromMandate,
  bindEconomicIntent,
} from "../../src/domain/economic/canonical-economic-intent.js";
import type { AgentSpendMandate } from "../../src/domain/mandates/mandate.types.js";
import { ApprovalMode } from "../../src/domain/mandates/mandate.types.js";
import { DecisionVerdict } from "../../src/domain/evaluation/evaluation.types.js";
import { sha256Hex } from "../../src/infrastructure/crypto/canonical-json.js";
import { AuthorizationGrantService } from "../../src/modules/authorization/authorization-grant.service.js";
import { MandateTokenService } from "../../src/modules/mandates/mandate-token.service.js";
import {
  BeginPaymentOutcomeKind,
  PaymentOutcomeStatus,
  type PaymentOutcomeRecord,
} from "../../src/modules/payments/payment-outcome.store.js";
import { PersonalStripeExecutionService } from "../../src/modules/personal/personal-stripe-execution.service.js";
import type { StripePaymentIntentClient } from "../../src/modules/providers/stripe/stripe-payment-intent-client.js";
import { ReservationStatus } from "../../src/modules/spending/authorization-reservation.service.js";

const NOW = new Date("2026-08-26T18:30:00.000Z");
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const MANDATE_ID = "44444444-4444-4444-8444-444444444444";
const POLICY_ID = "55555555-5555-4555-8555-555555555555";
const PAYMENT_INTENT_ID = "pi_test51";
const RESERVATION_ID = "reservation-51";
const OUTCOME_ID = "66666666-6666-4666-8666-666666666666";
const IDEMPOTENCY_KEY = "personal-stripe-idem-51";
const TOKEN_JTI = "mandate-token-jti-51";

const target = {
  id: "stripe-target-51",
  organizationId: ORG_ID,
  domain: "supplier.example",
  accountId: "acct_123",
  expectedLivemode: false,
  active: true,
} as const;

function mandate(): AgentSpendMandate {
  return {
    id: MANDATE_ID,
    organizationId: ORG_ID,
    userId: USER_ID,
    agentId: AGENT_ID,
    policyId: POLICY_ID,
    policyVersion: 1,
    currency: "USD",
    maxBudgetPerTransactionMinor: 500n,
    rollingDailyLimitMinor: 1_000n,
    approvedMerchantDomains: ["supplier.example"],
    approvedVendorIds: [],
    restrictedCategories: [],
    approvalMode: ApprovalMode.AUTO_APPROVE,
    velocity: {
      maxTransactionsPerMinute: 10,
      crossMerchantWindowSeconds: 60,
      maxDistinctMerchantsInWindow: 5,
    },
    issuedAt: new Date("2026-08-26T18:00:00.000Z"),
    expiresAt: new Date("2026-08-26T20:00:00.000Z"),
    signingKeyId: "mandate-k1",
    tokenJtiHash: sha256Hex(TOKEN_JTI),
  };
}

function stripeBody(status: "requires_confirmation" | "succeeded", paymentMethod = "pm_test51") {
  return {
    id: PAYMENT_INTENT_ID,
    object: "payment_intent",
    amount: 125,
    currency: "usd",
    status,
    capture_method: "automatic",
    confirmation_method: "manual",
    livemode: false,
    payment_method: paymentMethod,
    on_behalf_of: null,
    transfer_data: null,
    application_fee_amount: null,
  };
}

function outcome(requestDigest: string): PaymentOutcomeRecord {
  return {
    id: OUTCOME_ID,
    organizationId: ORG_ID,
    userId: USER_ID,
    agentId: AGENT_ID,
    mandateId: MANDATE_ID,
    reservationId: RESERVATION_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    requestDigest,
    merchantId: target.id,
    merchantDomain: target.domain,
    checkoutSessionId: PAYMENT_INTENT_ID,
    amountMinor: 125n,
    currency: "USD",
    status: PaymentOutcomeStatus.FORWARDING,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("PersonalStripeExecutionService", () => {
  it("uses only the server credential, durably records authorization before confirm, and never confirms twice on exact replay", async () => {
    const events: string[] = [];
    let retrieves = 0;
    let confirms = 0;
    const providerAuthorizations: string[] = [];
    let storedOutcome: PaymentOutcomeRecord | undefined;

    const { privateKey: mandatePrivateKey, publicKey: mandatePublicKey } =
      generateKeyPairSync("ed25519");
    const mandateTokens = new MandateTokenService(
      {
        async resolvePublicKey(keyId) {
          return keyId === "mandate-k1" ? mandatePublicKey : undefined;
        },
      },
      { issuer: "https://mino.example" },
    );
    const mandateToken = mandateTokens.issue(
      {
        iss: "https://mino.example",
        sub: AGENT_ID,
        aud: "mino",
        jti: TOKEN_JTI,
        organizationId: ORG_ID,
        userId: USER_ID,
        agentId: AGENT_ID,
        mandateId: MANDATE_ID,
        policyVersion: 1,
        iat: Math.floor(NOW.getTime() / 1000) - 10,
        nbf: Math.floor(NOW.getTime() / 1000) - 10,
        exp: Math.floor(NOW.getTime() / 1000) + 600,
      },
      { keyId: "mandate-k1", privateKey: mandatePrivateKey },
    );

    const stripeClient: StripePaymentIntentClient = {
      async retrievePaymentIntent(input) {
        retrieves += 1;
        providerAuthorizations.push(input.authorization);
        events.push(`retrieve:${retrieves}`);
        return { status: 200, body: stripeBody("requires_confirmation") };
      },
      async confirmPaymentIntent(input) {
        confirms += 1;
        providerAuthorizations.push(input.authorization);
        events.push("confirm");
        expect(input.idempotencyKey).toBe(IDEMPOTENCY_KEY);
        return { status: 200, body: stripeBody("succeeded") };
      },
    };

    const { privateKey: grantPrivateKey } = generateKeyPairSync("ed25519");
    let generated = 0;
    const service = new PersonalStripeExecutionService({
      mandateTokens,
      mandates: {
        async getById(id) {
          return id === MANDATE_ID ? mandate() : undefined;
        },
      },
      agentRequests: {
        async verify() {
          events.push("agent-proof");
        },
      },
      evaluator: {
        evaluate(context) {
          const amount = context.checkout.economicValue?.amount;
          if (!amount) throw new Error("test requires provider-neutral economics");
          const bound = bindEconomicIntent(
            context.checkout,
            authorityReferenceFromMandate(context.mandate),
          );
          return {
            decisionId: `77777777-7777-4777-8777-${String(++generated).padStart(12, "0")}`,
            requestId: context.checkout.requestId,
            verdict: DecisionVerdict.ALLOW,
            reasons: [],
            requestedAmount: amount,
            policyAmount: amount,
            approvedAmount: amount,
            mandateId: context.mandate.id,
            policyId: context.mandate.policyId,
            policyVersion: context.mandate.policyVersion,
            intentDigest: bound.intentDigest,
            eligibleForDelegationAssertion: true,
            evaluationLatencyMicros: 1,
            evaluatedAt: context.now,
          };
        },
      },
      reservations: {
        async tryReserve() {
          events.push("reserve");
          return {
            status: ReservationStatus.RESERVED,
            reservationId: RESERVATION_ID,
            spend: {
              committedDailySpend: { currency: "USD", minorUnits: 0n },
              reservedDailySpend: { currency: "USD", minorUnits: 125n },
            },
            velocity: {
              transactionsLastMinute: 1,
              distinctMerchantsInWindow: 1,
              attemptedAmountLastMinute: { currency: "USD", minorUnits: 125n },
              merchantDomainsInWindow: [target.domain],
              distinctCounterpartiesInWindow: 1,
              counterpartyKeysInWindow: [`MERCHANT|DOMAIN::${target.domain}`],
            },
            replayed: false,
            dailyLimitOverridden: false,
          };
        },
        async commit() {
          events.push("commit");
          return true;
        },
        async release() {
          events.push("release");
          return true;
        },
        async releaseForApproval() {
          events.push("release-for-approval");
          return true;
        },
        async holdForReconciliation() {
          events.push("hold");
          return true;
        },
      },
      paymentOutcomes: {
        async getByIdempotency(_organizationId, idempotencyKey) {
          return idempotencyKey === IDEMPOTENCY_KEY ? storedOutcome : undefined;
        },
        async begin(input) {
          events.push("outcome-begin");
          storedOutcome = outcome(input.requestDigest);
          return { kind: BeginPaymentOutcomeKind.CREATED, outcome: storedOutcome };
        },
        async markUnknown(_outcomeId, args) {
          if (!storedOutcome) throw new Error("outcome missing");
          storedOutcome = {
            ...storedOutcome,
            status: PaymentOutcomeStatus.UNKNOWN,
            ...(args.upstreamStatus !== undefined ? { upstreamStatus: args.upstreamStatus } : {}),
            ...(args.errorCode ? { lastErrorCode: args.errorCode } : {}),
            updatedAt: args.now,
          };
          return storedOutcome;
        },
        async markSucceeded(_outcomeId, response, now) {
          events.push("outcome-succeeded");
          if (!storedOutcome) throw new Error("outcome missing");
          storedOutcome = {
            ...storedOutcome,
            status: PaymentOutcomeStatus.SUCCEEDED,
            upstreamStatus: response.status,
            response,
            resolvedAt: now,
            updatedAt: now,
          };
          return storedOutcome;
        },
        async markDefinitiveFailure(_outcomeId, response, now) {
          if (!storedOutcome) throw new Error("outcome missing");
          storedOutcome = {
            ...storedOutcome,
            status: PaymentOutcomeStatus.FAILED_DEFINITIVE,
            upstreamStatus: response.status,
            response,
            resolvedAt: now,
            updatedAt: now,
          };
          return storedOutcome;
        },
        async markReconciled(_outcomeId, now) {
          if (!storedOutcome) throw new Error("outcome missing");
          storedOutcome = { ...storedOutcome, lastReconciledAt: now, updatedAt: now };
          return storedOutcome;
        },
      },
      approvals: {
        async requestApproval() {
          throw new Error("approval should not be requested");
        },
        async getById() {
          return undefined;
        },
        async getByIdempotency() {
          return undefined;
        },
        async castVote() {
          throw new Error("vote should not be cast");
        },
      },
      audit: {
        async record(event) {
          expect(event.protocol).toBe("STRIPE");
          expect(event.decision.verdict).toBe(DecisionVerdict.ALLOW);
          events.push("audit-allow");
        },
      },
      grants: new AuthorizationGrantService(
        { keyId: "grant-k1", privateKey: grantPrivateKey },
        () => "grant-user-1",
        { issuer: "https://mino.example" },
      ),
      stripeClient,
      stripeTarget: target,
      credentials: {
        async getAuthorization(organizationId, providerTargetId) {
          return organizationId === ORG_ID && providerTargetId === target.id
            ? "Bearer rk_test_server_only"
            : undefined;
        },
      },
      generateId: () =>
        generated++ === 0
          ? RESERVATION_ID
          : "88888888-8888-4888-8888-888888888888",
    });

    const request = {
      paymentIntentId: PAYMENT_INTENT_ID,
      requestId: "99999999-9999-4999-8999-999999999999",
      idempotencyKey: IDEMPOTENCY_KEY,
      path: `/v1/personal/stripe/payment_intents/${PAYMENT_INTENT_ID}/confirm`,
      body: {},
      security: {
        mandateToken,
        apiVersion: "2026-08-26",
        agentProof: {
          agentId: AGENT_ID,
          keyId: "agent-k1",
          timestamp: String(Math.floor(NOW.getTime() / 1000)),
          nonce: "nonce_nonce_nonce_51",
          signature: "test-signature",
        },
      },
      now: NOW,
    };

    const first = await service.confirmPaymentIntent(request);
    expect(first.upstream?.body).toMatchObject({ status: "succeeded" });
    expect(retrieves).toBe(2);
    expect(confirms).toBe(1);
    expect(providerAuthorizations).toEqual([
      "Bearer rk_test_server_only",
      "Bearer rk_test_server_only",
      "Bearer rk_test_server_only",
    ]);
    expect(events.indexOf("outcome-begin")).toBeLessThan(events.indexOf("confirm"));
    expect(events.indexOf("audit-allow")).toBeLessThan(events.indexOf("confirm"));
    expect(events.indexOf("confirm")).toBeLessThan(events.indexOf("outcome-succeeded"));
    expect(events.indexOf("outcome-succeeded")).toBeLessThan(events.indexOf("commit"));

    const second = await service.confirmPaymentIntent({
      ...request,
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      security: {
        ...request.security,
        agentProof: {
          ...request.security.agentProof,
          nonce: "fresh_nonce_nonce_52",
          signature: "fresh-test-signature",
        },
      },
    });

    expect(second.replayed).toBe(true);
    expect(second.paymentOutcomeId).toBe(OUTCOME_ID);
    expect(retrieves).toBe(2);
    expect(confirms).toBe(1);
  });
});