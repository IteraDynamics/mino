-- CreateTable
CREATE TABLE "AdminAuditChainHead" (
    "organizationId" UUID NOT NULL,
    "chainSequence" BIGINT NOT NULL DEFAULT 0,
    "chainDigest" TEXT,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAuditChainHead_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable
CREATE TABLE "AdminAuditLog" (
    "id" BIGSERIAL NOT NULL,
    "organizationId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "principalId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "permission" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "roles" TEXT[],
    "beforeState" JSONB,
    "afterState" JSONB,
    "metadata" JSONB,
    "requestDigest" TEXT NOT NULL,
    "eventDigest" TEXT NOT NULL,
    "chainVersion" INTEGER NOT NULL DEFAULT 1,
    "chainSequence" BIGINT NOT NULL,
    "previousChainDigest" TEXT,
    "chainDigest" TEXT NOT NULL,
    "integritySignature" TEXT NOT NULL,
    "signingKeyId" TEXT NOT NULL,

    CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminAuditLog_organizationId_timestamp_idx" ON "AdminAuditLog"("organizationId", "timestamp");

-- CreateIndex
CREATE INDEX "AdminAuditLog_organizationId_chainSequence_idx" ON "AdminAuditLog"("organizationId", "chainSequence");

-- CreateIndex
CREATE INDEX "AdminAuditLog_principalId_timestamp_idx" ON "AdminAuditLog"("principalId", "timestamp");

-- CreateIndex
CREATE INDEX "AdminAuditLog_requestId_idx" ON "AdminAuditLog"("requestId");

-- CreateIndex
CREATE INDEX "AdminAuditLog_resourceType_resourceId_timestamp_idx" ON "AdminAuditLog"("resourceType", "resourceId", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "AdminAuditLog_organizationId_chainSequence_key" ON "AdminAuditLog"("organizationId", "chainSequence");

-- AddForeignKey
ALTER TABLE "AdminAuditChainHead" ADD CONSTRAINT "AdminAuditChainHead_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAuditLog" ADD CONSTRAINT "AdminAuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
