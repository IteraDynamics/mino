-- CreateEnum
CREATE TYPE "AdminGovernanceAction" AS ENUM ('MANDATE_ISSUE', 'POLICY_ACTIVATE');

-- CreateEnum
CREATE TYPE "AdminGovernanceStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'APPLIED', 'STALE');

-- CreateEnum
CREATE TYPE "AdminGovernanceVoteDecision" AS ENUM ('APPROVE', 'REJECT');

-- CreateTable
CREATE TABLE "AdminGovernanceRequest" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "action" "AdminGovernanceAction" NOT NULL,
    "requiredPermission" TEXT NOT NULL,
    "proposalKeyHash" TEXT NOT NULL,
    "requestDigest" TEXT NOT NULL,
    "proposalDigest" TEXT NOT NULL,
    "preconditionDigest" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "proposalPayload" JSONB NOT NULL,
    "executionPayload" JSONB NOT NULL,
    "proposerPrincipalId" UUID NOT NULL,
    "proposerMembershipId" UUID NOT NULL,
    "status" "AdminGovernanceStatus" NOT NULL DEFAULT 'PENDING',
    "requiredApprovals" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "approvedAt" TIMESTAMPTZ(6),
    "resolvedAt" TIMESTAMPTZ(6),
    "appliedAt" TIMESTAMPTZ(6),
    "resultResourceType" TEXT,
    "resultResourceId" TEXT,

    CONSTRAINT "AdminGovernanceRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminGovernanceVote" (
    "id" UUID NOT NULL,
    "governanceRequestId" UUID NOT NULL,
    "principalId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "decision" "AdminGovernanceVoteDecision" NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminGovernanceVote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminGovernanceRequest_organizationId_action_proposalKeyHas_key"
ON "AdminGovernanceRequest"("organizationId", "action", "proposalKeyHash");

-- CreateIndex
CREATE INDEX "AdminGovernanceRequest_organizationId_status_createdAt_idx"
ON "AdminGovernanceRequest"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AdminGovernanceRequest_organizationId_action_createdAt_idx"
ON "AdminGovernanceRequest"("organizationId", "action", "createdAt");

-- CreateIndex
CREATE INDEX "AdminGovernanceRequest_expiresAt_status_idx"
ON "AdminGovernanceRequest"("expiresAt", "status");

-- CreateIndex
CREATE INDEX "AdminGovernanceRequest_proposerPrincipalId_createdAt_idx"
ON "AdminGovernanceRequest"("proposerPrincipalId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdminGovernanceVote_governanceRequestId_principalId_key"
ON "AdminGovernanceVote"("governanceRequestId", "principalId");

-- CreateIndex
CREATE INDEX "AdminGovernanceVote_governanceRequestId_decision_createdAt_idx"
ON "AdminGovernanceVote"("governanceRequestId", "decision", "createdAt");

-- CreateIndex
CREATE INDEX "AdminGovernanceVote_principalId_createdAt_idx"
ON "AdminGovernanceVote"("principalId", "createdAt");

-- AddForeignKey
ALTER TABLE "AdminGovernanceVote"
ADD CONSTRAINT "AdminGovernanceVote_governanceRequestId_fkey"
FOREIGN KEY ("governanceRequestId") REFERENCES "AdminGovernanceRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
