-- CreateEnum
CREATE TYPE "AdminPrincipalStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DISABLED');

-- CreateEnum
CREATE TYPE "AdminMembershipStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'REMOVED');

-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('ORGANIZATION_OWNER', 'SECURITY_ADMIN', 'FINANCE_MANAGER', 'AGENT_MANAGER', 'APPROVER', 'AUDITOR');

-- CreateTable
CREATE TABLE "AdminPrincipal" (
    "id" UUID NOT NULL,
    "issuer" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "email" TEXT,
    "displayName" TEXT,
    "status" "AdminPrincipalStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AdminPrincipal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminOrganizationMembership" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "principalId" UUID NOT NULL,
    "status" "AdminMembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AdminOrganizationMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminRoleAssignment" (
    "id" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "role" "AdminRole" NOT NULL,
    "assignedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminRoleAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminPrincipal_status_idx" ON "AdminPrincipal"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AdminPrincipal_issuer_subject_key" ON "AdminPrincipal"("issuer", "subject");

-- CreateIndex
CREATE INDEX "AdminOrganizationMembership_organizationId_status_idx" ON "AdminOrganizationMembership"("organizationId", "status");

-- CreateIndex
CREATE INDEX "AdminOrganizationMembership_principalId_status_idx" ON "AdminOrganizationMembership"("principalId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AdminOrganizationMembership_organizationId_principalId_key" ON "AdminOrganizationMembership"("organizationId", "principalId");

-- CreateIndex
CREATE INDEX "AdminRoleAssignment_role_idx" ON "AdminRoleAssignment"("role");

-- CreateIndex
CREATE UNIQUE INDEX "AdminRoleAssignment_membershipId_role_key" ON "AdminRoleAssignment"("membershipId", "role");

-- AddForeignKey
ALTER TABLE "AdminOrganizationMembership" ADD CONSTRAINT "AdminOrganizationMembership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminOrganizationMembership" ADD CONSTRAINT "AdminOrganizationMembership_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "AdminPrincipal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminRoleAssignment" ADD CONSTRAINT "AdminRoleAssignment_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "AdminOrganizationMembership"("id") ON DELETE CASCADE ON UPDATE CASCADE;
