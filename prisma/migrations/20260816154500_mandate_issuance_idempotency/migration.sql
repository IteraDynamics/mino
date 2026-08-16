ALTER TABLE "AgentMandate"
ADD COLUMN "issuanceKeyHash" TEXT;

CREATE UNIQUE INDEX "AgentMandate_organizationId_issuanceKeyHash_key"
ON "AgentMandate"("organizationId", "issuanceKeyHash");
