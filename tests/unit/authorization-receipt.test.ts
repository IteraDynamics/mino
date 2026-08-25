import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AuthorizationReceiptPayload } from "../../src/domain/economic/authorization-receipt.js";
import {
  receiptPayloadDigest,
  signAuthorizationReceipt,
  verifyAuthorizationReceipt,
} from "../../src/modules/receipts/authorization-receipt.service.js";

const payload: AuthorizationReceiptPayload = {
  schemaVersion: 1,
  receiptId: "receipt-1",
  intentDigest: "a".repeat(43),
  authority: {
    organizationId: "org-1",
    userId: "user-1",
    agentId: "agent-1",
    mandateId: "mandate-1",
    policyId: "policy-1",
    policyVersion: 7,
  },
  decision: {
    decisionId: "decision-1",
    verdict: "ALLOW",
    reasonCodes: ["WITHIN_POLICY"],
    evaluatedAt: "2026-08-25T14:30:00.000Z",
  },
  approval: {
    approvalRequestId: "approval-1",
    approvedAt: "2026-08-25T14:30:05.000Z",
    approvers: [
      {
        approverId: "owner@example.test",
        approvedAt: "2026-08-25T14:30:05.000Z",
      },
    ],
  },
  execution: {
    paymentOutcomeId: "outcome-1",
    protocol: "ACP",
    operation: "COMPLETE_CHECKOUT",
    status: "SUCCEEDED",
    providerReference: "cs_1",
    amountMinor: "5000",
    currency: "USD",
    upstreamStatus: 200,
    resolvedAt: "2026-08-25T14:30:07.000Z",
  },
  evidence: {
    executionRequestDigest: "request-digest-1",
    audit: {
      chainSequence: "42",
      eventDigest: "event-digest-1",
      chainDigest: "chain-digest-1",
    },
  },
  issuedAt: "2026-08-25T14:30:07.000Z",
};

describe("AuthorizationReceipt", () => {
  it("signs a deterministic canonical receipt and verifies it independently", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signed = signAuthorizationReceipt(payload, {
      keyId: "audit-k1",
      privateKey,
    });

    expect(signed.receiptDigest).toBe(receiptPayloadDigest(payload));
    expect(
      await verifyAuthorizationReceipt(signed, {
        async resolvePublicKey(keyId) {
          return keyId === "audit-k1" ? publicKey : undefined;
        },
      }),
    ).toBe(true);
  });

  it("fails verification when any signed economic fact is changed", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signed = signAuthorizationReceipt(payload, {
      keyId: "audit-k1",
      privateKey,
    });
    const tampered = {
      ...signed,
      payload: {
        ...signed.payload,
        execution: {
          ...signed.payload.execution,
          amountMinor: "5001",
        },
      },
    };

    expect(
      await verifyAuthorizationReceipt(tampered, {
        async resolvePublicKey() {
          return publicKey;
        },
      }),
    ).toBe(false);
  });

  it("fails verification when the signing key cannot be resolved", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const signed = signAuthorizationReceipt(payload, {
      keyId: "retired-k1",
      privateKey,
    });

    expect(
      await verifyAuthorizationReceipt(signed, {
        async resolvePublicKey() {
          return undefined;
        },
      }),
    ).toBe(false);
  });
});
