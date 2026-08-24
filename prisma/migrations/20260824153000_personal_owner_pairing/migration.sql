CREATE TYPE "PersonalOwnerStatus" AS ENUM ('ACTIVE', 'DISABLED');
CREATE TYPE "PersonalPairingStatus" AS ENUM ('PENDING', 'CLAIMED', 'EXPIRED');

CREATE TABLE "PersonalOwner" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "issuer" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "displayName" TEXT,
  "status" "PersonalOwnerStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "PersonalOwner_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PersonalPairingRequest" (
  "id" UUID NOT NULL,
  "claimSecretHash" TEXT NOT NULL,
  "proofNonceHash" TEXT NOT NULL,
  "externalAgentId" TEXT NOT NULL,
  "displayName" TEXT,
  "keyId" TEXT NOT NULL,
  "publicKey" TEXT NOT NULL,
  "publicKeyFingerprint" TEXT NOT NULL,
  "status" "PersonalPairingStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "claimedAt" TIMESTAMPTZ(6),
  "claimedByOwnerId" UUID,
  "claimedOrganizationId" UUID,
  "agentId" UUID,
  CONSTRAINT "PersonalPairingRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PersonalOwner_organizationId_key" ON "PersonalOwner"("organizationId");
CREATE UNIQUE INDEX "PersonalOwner_userId_key" ON "PersonalOwner"("userId");
CREATE UNIQUE INDEX "PersonalOwner_issuer_subject_key" ON "PersonalOwner"("issuer", "subject");
CREATE INDEX "PersonalOwner_status_idx" ON "PersonalOwner"("status");

CREATE UNIQUE INDEX "PersonalPairingRequest_claimSecretHash_key" ON "PersonalPairingRequest"("claimSecretHash");
CREATE UNIQUE INDEX "PersonalPairingRequest_proofNonceHash_key" ON "PersonalPairingRequest"("proofNonceHash");
CREATE UNIQUE INDEX "PersonalPairingRequest_agentId_key" ON "PersonalPairingRequest"("agentId");
CREATE INDEX "PersonalPairingRequest_status_expiresAt_idx" ON "PersonalPairingRequest"("status", "expiresAt");
CREATE INDEX "PersonalPairingRequest_claimedByOwnerId_claimedAt_idx" ON "PersonalPairingRequest"("claimedByOwnerId", "claimedAt");
CREATE INDEX "PersonalPairingRequest_claimedOrganizationId_claimedAt_idx" ON "PersonalPairingRequest"("claimedOrganizationId", "claimedAt");
