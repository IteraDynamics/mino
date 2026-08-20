import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../../src/generated/prisma/client.js";
import { PrismaAdminAuthorizationContextRepository } from "../../src/infrastructure/prisma/admin-authorization.repository.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";

integration("Prisma admin authorization repository", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("loads exact organization authority plus safe human-readable presentation metadata", async () => {
    const organizationId = randomUUID();
    const principalId = randomUUID();
    const issuer = `https://idp.example/${randomUUID()}`;
    const subject = `subject-${randomUUID()}`;

    try {
      await prisma.organization.create({ data: { id: organizationId, name: "RBAC test org" } });
      await prisma.adminPrincipal.create({
        data: {
          id: principalId,
          issuer,
          subject,
          email: "alice@example.test",
          displayName: "Alice Admin",
        },
      });
      const membership = await prisma.adminOrganizationMembership.create({
        data: {
          organizationId,
          principalId,
          roleAssignments: {
            create: [{ role: "FINANCE_MANAGER" }, { role: "AUDITOR" }],
          },
        },
      });

      const repository = new PrismaAdminAuthorizationContextRepository(prisma);
      await expect(
        repository.findForIdentity({ issuer, subject, organizationId }),
      ).resolves.toEqual({
        principalId,
        principalDisplayName: "Alice Admin",
        principalEmail: "alice@example.test",
        principalStatus: "ACTIVE",
        membership: {
          membershipId: membership.id,
          organizationId,
          organizationName: "RBAC test org",
          status: "ACTIVE",
          roles: ["FINANCE_MANAGER", "AUDITOR"],
        },
      });
    } finally {
      await prisma.organization.deleteMany({ where: { id: organizationId } });
      await prisma.adminPrincipal.deleteMany({ where: { id: principalId } });
    }
  });

  it("does not substitute a membership from another organization", async () => {
    const organizationId = randomUUID();
    const otherOrganizationId = randomUUID();
    const principalId = randomUUID();
    const issuer = `https://idp.example/${randomUUID()}`;
    const subject = `subject-${randomUUID()}`;

    try {
      await prisma.organization.createMany({
        data: [
          { id: organizationId, name: "Authorized org" },
          { id: otherOrganizationId, name: "Other org" },
        ],
      });
      await prisma.adminPrincipal.create({ data: { id: principalId, issuer, subject } });
      await prisma.adminOrganizationMembership.create({
        data: {
          organizationId,
          principalId,
          roleAssignments: { create: [{ role: "ORGANIZATION_OWNER" }] },
        },
      });

      const repository = new PrismaAdminAuthorizationContextRepository(prisma);
      await expect(
        repository.findForIdentity({ issuer, subject, organizationId: otherOrganizationId }),
      ).resolves.toEqual({
        principalId,
        principalStatus: "ACTIVE",
      });
    } finally {
      await prisma.organization.deleteMany({
        where: { id: { in: [organizationId, otherOrganizationId] } },
      });
      await prisma.adminPrincipal.deleteMany({ where: { id: principalId } });
    }
  });

  it("preserves suspended principal and membership state for fail-closed authorization", async () => {
    const organizationId = randomUUID();
    const principalId = randomUUID();
    const issuer = `https://idp.example/${randomUUID()}`;
    const subject = `subject-${randomUUID()}`;

    try {
      await prisma.organization.create({ data: { id: organizationId, name: "Suspended org" } });
      await prisma.adminPrincipal.create({
        data: { id: principalId, issuer, subject, status: "SUSPENDED" },
      });
      const membership = await prisma.adminOrganizationMembership.create({
        data: {
          organizationId,
          principalId,
          status: "SUSPENDED",
          roleAssignments: { create: [{ role: "ORGANIZATION_OWNER" }] },
        },
      });

      const repository = new PrismaAdminAuthorizationContextRepository(prisma);
      await expect(
        repository.findForIdentity({ issuer, subject, organizationId }),
      ).resolves.toEqual({
        principalId,
        principalStatus: "SUSPENDED",
        membership: {
          membershipId: membership.id,
          organizationId,
          organizationName: "Suspended org",
          status: "SUSPENDED",
          roles: ["ORGANIZATION_OWNER"],
        },
      });
    } finally {
      await prisma.organization.deleteMany({ where: { id: organizationId } });
      await prisma.adminPrincipal.deleteMany({ where: { id: principalId } });
    }
  });
});
