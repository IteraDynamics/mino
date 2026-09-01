-- Persist the immutable provider-side execution projection needed to verify
-- terminal observations after ambiguous outcomes.
ALTER TABLE "PaymentOutcome"
ADD COLUMN "providerBindingDigest" TEXT;

-- A single external provider consequence may have only one durable Mino outcome,
-- even when callers race it under different Mino idempotency keys.
CREATE UNIQUE INDEX "PaymentOutcome_organizationId_merchantId_checkoutSessionId_key"
ON "PaymentOutcome"("organizationId", "merchantId", "checkoutSessionId");
