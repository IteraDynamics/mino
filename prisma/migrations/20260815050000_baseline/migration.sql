-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DISABLED');

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "MandateStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ApprovalMode" AS ENUM ('AUTO_APPROVE', 'DUAL_SIGNATURE_SLACK', 'HARD_BLOCK');

-- CreateEnum
CREATE TYPE "DecisionVerdict" AS ENUM ('ALLOW', 'BLOCK', 'PENDING_HUMAN_APPROVAL');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ApprovalVoteDecision" AS ENUM ('APPROVE', 'REJECT');

-- CreateEnum
CREATE TYPE "SpendReservationStatus" AS ENUM ('RESERVED', 'COMMITTED', 'RELEASED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PaymentOutcomeStatus" AS ENUM ('FORWARDING', 'UNKNOWN', 'SUCCEEDED', 'FAILED_DEFINITIVE');

-- CreateTable
CREATE TABLE "Organization" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchantEndpoint" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "externalMerchantId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "vendorId" TEXT,
    "baseUrl" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "MerchantEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentIdentity" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "externalAgentId" TEXT NOT NULL,
    "displayName" TEXT,
    "status" "AgentStatus" NOT NULL DEFAULT 'ACTIVE',
    "publicKey" TEXT,
    "keyId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AgentIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Policy" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "baseCurrency" CHAR(3) NOT NULL DEFAULT 'USD',
    "maxBudgetMinor" BIGINT NOT NULL,
    "rollingDailyLimitMinor" BIGINT NOT NULL,
    "approvedMerchantDomains" TEXT[],
    "approvedVendorIds" TEXT[],
    "restrictedCategories" TEXT[],
    "approvalMode" "ApprovalMode" NOT NULL,
    "maxTransactionsPerMinute" INTEGER NOT NULL DEFAULT 10,
    "crossMerchantWindowSecs" INTEGER NOT NULL DEFAULT 60,
    "maxDistinctMerchants" INTEGER NOT NULL DEFAULT 5,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentMandate" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "policyId" UUID NOT NULL,
    "tokenJtiHash" TEXT NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "maxBudgetMinor" BIGINT NOT NULL,
    "rollingDailyLimitMinor" BIGINT NOT NULL,
    "approvedMerchantDomains" TEXT[],
    "approvedVendorIds" TEXT[],
    "restrictedCategories" TEXT[],
    "approvalMode" "ApprovalMode" NOT NULL,
    "maxTransactionsPerMinute" INTEGER NOT NULL DEFAULT 10,
    "crossMerchantWindowSecs" INTEGER NOT NULL DEFAULT 60,
    "maxDistinctMerchants" INTEGER NOT NULL DEFAULT 5,
    "delegationPayloadHash" TEXT NOT NULL,
    "signingKeyId" TEXT NOT NULL,
    "status" "MandateStatus" NOT NULL DEFAULT 'ACTIVE',
    "issuedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "revokedAt" TIMESTAMPTZ(6),
    "metadata" JSONB,

    CONSTRAINT "AgentMandate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpendReservation" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "mandateId" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "merchantDomain" TEXT NOT NULL,
    "merchantVendorId" TEXT,
    "currency" CHAR(3) NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "status" "SpendReservationStatus" NOT NULL DEFAULT 'RESERVED',
    "reservedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt" TIMESTAMPTZ(6),
    "releasedAt" TIMESTAMPTZ(6),
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "SpendReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentOutcome" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "mandateId" UUID NOT NULL,
    "reservationId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestDigest" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "merchantDomain" TEXT NOT NULL,
    "checkoutSessionId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "PaymentOutcomeStatus" NOT NULL DEFAULT 'FORWARDING',
    "upstreamStatus" INTEGER,
    "responseBody" JSONB,
    "responseHeaders" JSONB,
    "lastErrorCode" TEXT,
    "forwardedAt" TIMESTAMPTZ(6),
    "resolvedAt" TIMESTAMPTZ(6),
    "lastReconciledAt" TIMESTAMPTZ(6),
    "reconcileAttempts" INTEGER NOT NULL DEFAULT 0,
    "nextReconcileAt" TIMESTAMPTZ(6),
    "reconciliationLeaseOwner" TEXT,
    "reconciliationLeaseExpiresAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PaymentOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalRequest" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "mandateId" UUID NOT NULL,
    "decisionId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestDigest" TEXT NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "merchantId" TEXT NOT NULL,
    "merchantDomain" TEXT NOT NULL,
    "checkoutSessionId" TEXT,
    "requestedPayload" JSONB NOT NULL,
    "sessionSnapshot" JSONB,
    "spendSnapshot" JSONB,
    "reasonCodes" TEXT[],
    "amountMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "requiredSignatures" INTEGER NOT NULL DEFAULT 2,
    "approvalData" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "resolvedAt" TIMESTAMPTZ(6),

    CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalVote" (
    "id" UUID NOT NULL,
    "approvalRequestId" UUID NOT NULL,
    "approverId" TEXT NOT NULL,
    "decision" "ApprovalVoteDecision" NOT NULL,
    "comment" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditChainHead" (
    "organizationId" UUID NOT NULL,
    "chainSequence" BIGINT NOT NULL DEFAULT 0,
    "chainDigest" TEXT,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditChainHead_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" BIGSERIAL NOT NULL,
    "organizationId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "decisionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "mandateId" UUID,
    "timestamp" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "protocol" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "merchantDomain" TEXT NOT NULL,
    "merchantVendorId" TEXT,
    "requestedPayload" JSONB NOT NULL,
    "approvedPayload" JSONB,
    "decisionSnapshot" JSONB NOT NULL,
    "verdict" "DecisionVerdict" NOT NULL,
    "reasonCodes" TEXT[],
    "policyVersion" INTEGER,
    "evaluationLatencyMicros" INTEGER NOT NULL,
    "reservationId" TEXT,
    "upstreamStatus" INTEGER,
    "requestDigest" TEXT NOT NULL,
    "eventDigest" TEXT NOT NULL,
    "chainVersion" INTEGER NOT NULL DEFAULT 1,
    "chainSequence" BIGINT NOT NULL,
    "previousChainDigest" TEXT,
    "chainDigest" TEXT NOT NULL,
    "integritySignature" TEXT NOT NULL,
    "signingKeyId" TEXT NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MerchantEndpoint_organizationId_domain_active_idx" ON "MerchantEndpoint"("organizationId", "domain", "active");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantEndpoint_organizationId_externalMerchantId_key" ON "MerchantEndpoint"("organizationId", "externalMerchantId");

-- CreateIndex
CREATE INDEX "User_organizationId_status_idx" ON "User"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "User_organizationId_email_key" ON "User"("organizationId", "email");

-- CreateIndex
CREATE INDEX "AgentIdentity_organizationId_status_idx" ON "AgentIdentity"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AgentIdentity_organizationId_externalAgentId_key" ON "AgentIdentity"("organizationId", "externalAgentId");

-- CreateIndex
CREATE INDEX "Policy_organizationId_active_idx" ON "Policy"("organizationId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Policy_organizationId_name_version_key" ON "Policy"("organizationId", "name", "version");

-- CreateIndex
CREATE UNIQUE INDEX "AgentMandate_tokenJtiHash_key" ON "AgentMandate"("tokenJtiHash");

-- CreateIndex
CREATE INDEX "AgentMandate_organizationId_agentId_status_expiresAt_idx" ON "AgentMandate"("organizationId", "agentId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "AgentMandate_userId_status_idx" ON "AgentMandate"("userId", "status");

-- CreateIndex
CREATE INDEX "SpendReservation_mandateId_status_reservedAt_idx" ON "SpendReservation"("mandateId", "status", "reservedAt");

-- CreateIndex
CREATE INDEX "SpendReservation_userId_reservedAt_idx" ON "SpendReservation"("userId", "reservedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SpendReservation_organizationId_idempotencyKey_key" ON "SpendReservation"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentOutcome_reservationId_key" ON "PaymentOutcome"("reservationId");

-- CreateIndex
CREATE INDEX "PaymentOutcome_organizationId_status_updatedAt_idx" ON "PaymentOutcome"("organizationId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "PaymentOutcome_mandateId_status_updatedAt_idx" ON "PaymentOutcome"("mandateId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "PaymentOutcome_checkoutSessionId_status_idx" ON "PaymentOutcome"("checkoutSessionId", "status");

-- CreateIndex
CREATE INDEX "PaymentOutcome_status_nextReconcileAt_reconciliationLeaseEx_idx" ON "PaymentOutcome"("status", "nextReconcileAt", "reconciliationLeaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentOutcome_organizationId_idempotencyKey_key" ON "PaymentOutcome"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalRequest_decisionId_key" ON "ApprovalRequest"("decisionId");

-- CreateIndex
CREATE INDEX "ApprovalRequest_organizationId_status_createdAt_idx" ON "ApprovalRequest"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ApprovalRequest_mandateId_status_idx" ON "ApprovalRequest"("mandateId", "status");

-- CreateIndex
CREATE INDEX "ApprovalRequest_expiresAt_status_idx" ON "ApprovalRequest"("expiresAt", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalRequest_organizationId_idempotencyKey_key" ON "ApprovalRequest"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "ApprovalVote_approvalRequestId_decision_createdAt_idx" ON "ApprovalVote"("approvalRequestId", "decision", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalVote_approvalRequestId_approverId_key" ON "ApprovalVote"("approvalRequestId", "approverId");

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_timestamp_idx" ON "AuditLog"("organizationId", "timestamp");

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_chainSequence_idx" ON "AuditLog"("organizationId", "chainSequence");

-- CreateIndex
CREATE INDEX "AuditLog_agentId_timestamp_idx" ON "AuditLog"("agentId", "timestamp");

-- CreateIndex
CREATE INDEX "AuditLog_userId_timestamp_idx" ON "AuditLog"("userId", "timestamp");

-- CreateIndex
CREATE INDEX "AuditLog_merchantDomain_timestamp_idx" ON "AuditLog"("merchantDomain", "timestamp");

-- CreateIndex
CREATE INDEX "AuditLog_decisionId_idx" ON "AuditLog"("decisionId");

-- CreateIndex
CREATE INDEX "AuditLog_requestId_idx" ON "AuditLog"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "AuditLog_organizationId_chainSequence_key" ON "AuditLog"("organizationId", "chainSequence");

-- AddForeignKey
ALTER TABLE "MerchantEndpoint" ADD CONSTRAINT "MerchantEndpoint_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentIdentity" ADD CONSTRAINT "AgentIdentity_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Policy" ADD CONSTRAINT "Policy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentMandate" ADD CONSTRAINT "AgentMandate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentMandate" ADD CONSTRAINT "AgentMandate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentMandate" ADD CONSTRAINT "AgentMandate_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentIdentity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentMandate" ADD CONSTRAINT "AgentMandate_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "Policy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpendReservation" ADD CONSTRAINT "SpendReservation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpendReservation" ADD CONSTRAINT "SpendReservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpendReservation" ADD CONSTRAINT "SpendReservation_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentIdentity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpendReservation" ADD CONSTRAINT "SpendReservation_mandateId_fkey" FOREIGN KEY ("mandateId") REFERENCES "AgentMandate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentOutcome" ADD CONSTRAINT "PaymentOutcome_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentOutcome" ADD CONSTRAINT "PaymentOutcome_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentOutcome" ADD CONSTRAINT "PaymentOutcome_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentIdentity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentOutcome" ADD CONSTRAINT "PaymentOutcome_mandateId_fkey" FOREIGN KEY ("mandateId") REFERENCES "AgentMandate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentIdentity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_mandateId_fkey" FOREIGN KEY ("mandateId") REFERENCES "AgentMandate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalVote" ADD CONSTRAINT "ApprovalVote_approvalRequestId_fkey" FOREIGN KEY ("approvalRequestId") REFERENCES "ApprovalRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditChainHead" ADD CONSTRAINT "AuditChainHead_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentIdentity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_mandateId_fkey" FOREIGN KEY ("mandateId") REFERENCES "AgentMandate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
