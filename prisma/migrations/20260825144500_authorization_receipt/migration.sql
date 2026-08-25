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
