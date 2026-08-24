-- Mino Personal reuses the existing organization/user/policy/mandate tables.
-- The tenant discriminator keeps Personal semantics explicit without creating a second control plane.
CREATE TYPE "OrganizationKind" AS ENUM ('ENTERPRISE', 'PERSONAL');

ALTER TABLE "Organization"
ADD COLUMN "kind" "OrganizationKind" NOT NULL DEFAULT 'ENTERPRISE';

-- Personal soft-limit exceptions are approved by the account owner rather than
-- by the enterprise dual-signature workflow.
ALTER TYPE "ApprovalMode" ADD VALUE 'OWNER_APPROVAL';
