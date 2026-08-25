-- Preserve pre-execution canonical authorization evidence on new payment outcomes.
-- Columns remain nullable so existing terminal outcomes can migrate safely; receipt
-- issuance fails closed for legacy rows that predate this evidence.
ALTER TABLE "PaymentOutcome"
  ADD COLUMN "intentDigest" TEXT,
  ADD COLUMN "authoritativeStateDigest" TEXT,
  ADD COLUMN "decisionId" UUID,
  ADD COLUMN "policyId" UUID,
  ADD COLUMN "policyVersion" INTEGER,
  ADD COLUMN "decisionReasonCodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "decisionEvaluatedAt" TIMESTAMPTZ(6),
  ADD COLUMN "protocol" TEXT,
  ADD COLUMN "operation" TEXT,
  ADD COLUMN "approvalRequestId" UUID;

CREATE INDEX "PaymentOutcome_intentDigest_idx"
  ON "PaymentOutcome"("intentDigest");

CREATE TABLE "AuthorizationReceipt" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "paymentOutcomeId" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "agentId" UUID NOT NULL,
  "mandateId" UUID NOT NULL,
  "intentDigest" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "receiptDigest" TEXT NOT NULL,
  "integritySignature" TEXT NOT NULL,
  "signingKeyId" TEXT NOT NULL,
  "issuedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AuthorizationReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AuthorizationReceipt_paymentOutcomeId_key"
  ON "AuthorizationReceipt"("paymentOutcomeId");
CREATE INDEX "AuthorizationReceipt_organizationId_issuedAt_idx"
  ON "AuthorizationReceipt"("organizationId", "issuedAt");
CREATE INDEX "AuthorizationReceipt_intentDigest_idx"
  ON "AuthorizationReceipt"("intentDigest");

ALTER TABLE "AuthorizationReceipt"
  ADD CONSTRAINT "AuthorizationReceipt_paymentOutcomeId_fkey"
  FOREIGN KEY ("paymentOutcomeId") REFERENCES "PaymentOutcome"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
