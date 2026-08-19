import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  ADMIN_AUDIT_TRANSACTION_VERDICTS,
  AdminAuditOperationsValidationError,
  type AdminChangeAuditFilter,
  type AdminTransactionAuditFilter,
  type PostgresAdminAuditOperations,
} from "../modules/admin/admin-audit-operations.js";
import {
  presentAdminEconomicPage,
} from "../modules/admin/provider-neutral-economic-presentation.js";
import { ADMIN_PERMISSIONS } from "../modules/admin/admin-authorizer.js";
import type {
  AdminAuditChainCheckpoint,
  PostgresRetainedAdminAuditVerifier,
} from "../modules/admin/admin-audit-checkpoint-retention.js";
import type { PostgresAdminChangeAuditVerifier } from "../modules/admin/admin-change-audit-ledger.js";
import type {
  AuditChainCheckpoint,
  PostgresAuditVerifier,
} from "../modules/audit/postgres-audit-ledger.js";
import {
  requireAdminPermission,
  type AdminHttpAuthorizationDependencies,
} from "./admin-http-authorization.js";

const organizationParamsSchema = z.object({ organizationId: z.string().uuid() }).strict();
const commonAuditQueryFields = {
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(256).optional(),
  createdAfter: z.string().datetime({ offset: true }).optional(),
  createdBefore: z.string().datetime({ offset: true }).optional(),
};
const transactionAuditQuerySchema = z
  .object({
    ...commonAuditQueryFields,
    verdict: z.enum(ADMIN_AUDIT_TRANSACTION_VERDICTS).optional(),
    operation: z.string().min(1).max(256).optional(),
    userId: z.string().uuid().optional(),
    agentId: z.string().uuid().optional(),
    mandateId: z.string().uuid().optional(),
    merchantDomain: z.string().min(1).max(256).optional(),
  })
  .strict();
const adminAuditQuerySchema = z
  .object({
    ...commonAuditQueryFields,
    principalId: z.string().uuid().optional(),
    permission: z.enum(ADMIN_PERMISSIONS).optional(),
    action: z.string().min(1).max(256).optional(),
    resourceType: z.string().min(1).max(256).optional(),
    resourceId: z.string().min(1).max(256).optional(),
  })
  .strict();

const checkpointSchema = z
  .object({
    version: z.literal(1),
    organizationId: z.string().uuid(),
    chainSequence: z.string().regex(/^(0|[1-9][0-9]*)$/).max(40),
    chainDigest: z.string().min(1).max(256).nullable(),
    issuedAt: z.string().datetime({ offset: true }),
    signingKeyId: z.string().min(1).max(256),
    signature: z.string().min(1).max(2048),
  })
  .strict();
const verificationBodySchema = z
  .object({ retainedCheckpoint: checkpointSchema.optional() })
  .strict()
  .default({});

export interface AdminAuditOperationsRouteDependencies
  extends AdminHttpAuthorizationDependencies {
  readonly operations: Pick<
    PostgresAdminAuditOperations,
    "listTransactionAudit" | "listAdministrativeAudit" | "operationalSnapshot"
  >;
  readonly transactionVerifier: Pick<PostgresAuditVerifier, "verifyOrganization">;
  readonly administrativeVerifier: Pick<PostgresAdminChangeAuditVerifier, "verifyOrganization">;
  readonly retainedAdministrativeVerifier: Pick<
    PostgresRetainedAdminAuditVerifier,
    "verifyOrganization"
  >;
}

export async function registerAdminAuditOperationsRoutes(
  app: FastifyInstance,
  dependencies: AdminAuditOperationsRouteDependencies,
): Promise<void> {
  app.get(
    "/v1/admin/organizations/:organizationId/audit/transactions",
    async (request, reply) => {
      const params = organizationParamsSchema.safeParse(request.params);
      const query = transactionAuditQuerySchema.safeParse(request.query);
      if (!params.success || !query.success) {
        return invalidRequest(reply);
      }
      if (
        !(await requireAdminPermission(
          request,
          reply,
          dependencies,
          params.data.organizationId,
          "audit.read",
        ))
      ) {
        return;
      }
      try {
        return reply.code(200).send(
          presentAdminEconomicPage(
            await dependencies.operations.listTransactionAudit(
              params.data.organizationId,
              query.data as AdminTransactionAuditFilter,
            ),
          ),
        );
      } catch (error) {
        return sendValidationError(reply, error);
      }
    },
  );

  app.get(
    "/v1/admin/organizations/:organizationId/audit/administrative",
    async (request, reply) => {
      const params = organizationParamsSchema.safeParse(request.params);
      const query = adminAuditQuerySchema.safeParse(request.query);
      if (!params.success || !query.success) {
        return invalidRequest(reply);
      }
      if (
        !(await requireAdminPermission(
          request,
          reply,
          dependencies,
          params.data.organizationId,
          "audit.read",
        ))
      ) {
        return;
      }
      try {
        return reply.code(200).send(
          await dependencies.operations.listAdministrativeAudit(
            params.data.organizationId,
            query.data as AdminChangeAuditFilter,
          ),
        );
      } catch (error) {
        return sendValidationError(reply, error);
      }
    },
  );

  app.post(
    "/v1/admin/organizations/:organizationId/audit/transactions/verify",
    async (request, reply) => {
      const params = organizationParamsSchema.safeParse(request.params);
      const body = verificationBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return invalidRequest(reply);
      }
      if (
        !(await requireAdminPermission(
          request,
          reply,
          dependencies,
          params.data.organizationId,
          "audit.verify",
        ))
      ) {
        return;
      }

      const databaseVerification = await dependencies.transactionVerifier.verifyOrganization(
        params.data.organizationId,
      );
      const retainedCheckpoint = body.data.retainedCheckpoint as AuditChainCheckpoint | undefined;
      const retainedCheckpointVerification = retainedCheckpoint
        ? await dependencies.transactionVerifier.verifyOrganization(
            params.data.organizationId,
            retainedCheckpoint,
          )
        : undefined;
      return reply.code(200).send({
        chain: "transaction",
        databaseVerification,
        ...(retainedCheckpointVerification ? { retainedCheckpointVerification } : {}),
      });
    },
  );

  app.post(
    "/v1/admin/organizations/:organizationId/audit/administrative/verify",
    async (request, reply) => {
      const params = organizationParamsSchema.safeParse(request.params);
      const body = verificationBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return invalidRequest(reply);
      }
      if (
        !(await requireAdminPermission(
          request,
          reply,
          dependencies,
          params.data.organizationId,
          "audit.verify",
        ))
      ) {
        return;
      }

      const databaseVerification = await dependencies.administrativeVerifier.verifyOrganization(
        params.data.organizationId,
      );
      const retainedCheckpoint = body.data.retainedCheckpoint as
        | AdminAuditChainCheckpoint
        | undefined;
      const retainedCheckpointVerification = retainedCheckpoint
        ? await dependencies.retainedAdministrativeVerifier.verifyOrganization(
            params.data.organizationId,
            retainedCheckpoint,
          )
        : undefined;
      return reply.code(200).send({
        chain: "administrative",
        databaseVerification,
        ...(retainedCheckpointVerification ? { retainedCheckpointVerification } : {}),
      });
    },
  );

  app.get(
    "/v1/admin/organizations/:organizationId/operations",
    async (request, reply) => {
      const params = organizationParamsSchema.safeParse(request.params);
      if (!params.success) {
        return invalidRequest(reply);
      }
      if (
        !(await requireAdminPermission(
          request,
          reply,
          dependencies,
          params.data.organizationId,
          "audit.read",
        ))
      ) {
        return;
      }
      try {
        return reply.code(200).send({
          operations: await dependencies.operations.operationalSnapshot(params.data.organizationId),
        });
      } catch (error) {
        return sendValidationError(reply, error);
      }
    },
  );
}

function invalidRequest(reply: FastifyReply) {
  reply.header("cache-control", "no-store");
  return reply.code(400).send({ error: "invalid_request" });
}

function sendValidationError(reply: FastifyReply, error: unknown) {
  if (error instanceof AdminAuditOperationsValidationError) {
    return reply.code(400).send({ error: "invalid_request" });
  }
  throw error;
}
