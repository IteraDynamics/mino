import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  AdminBeneficiaryValidationError,
  type AdminBeneficiaryCreateResult,
  type AdminBeneficiarySuspendResult,
  type PostgresAdminBeneficiaryAdministrationService,
} from "../modules/admin/admin-beneficiary-administration.js";
import {
  requireAdminPermission,
  type AdminHttpAuthorizationDependencies,
} from "./admin-http-authorization.js";

const organizationParamsSchema = z.object({ organizationId: z.string().uuid() }).strict();
const beneficiaryParamsSchema = z
  .object({ organizationId: z.string().uuid(), beneficiaryId: z.string().uuid() })
  .strict();
const inventoryQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().uuid().optional(),
  })
  .strict();
const createBodySchema = z
  .object({ email: z.string().trim().min(3).max(320).email() })
  .strict();

export interface AdminBeneficiaryAdministrationRouteDependencies
  extends AdminHttpAuthorizationDependencies {
  readonly beneficiaries: Pick<
    PostgresAdminBeneficiaryAdministrationService,
    "listBeneficiaries" | "getBeneficiary" | "createBeneficiary" | "suspendBeneficiary"
  >;
}

export async function registerAdminBeneficiaryAdministrationRoutes(
  app: FastifyInstance,
  dependencies: AdminBeneficiaryAdministrationRouteDependencies,
): Promise<void> {
  app.get("/v1/admin/organizations/:organizationId/beneficiaries", async (request, reply) => {
    const params = organizationParamsSchema.safeParse(request.params);
    const query = inventoryQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return invalidRequest(reply);
    const authorization = await requireAdminPermission(
      request,
      reply,
      dependencies,
      params.data.organizationId,
      "beneficiary.read",
    );
    if (!authorization) return;
    try {
      return reply.code(200).send(
        await dependencies.beneficiaries.listBeneficiaries({
          organizationId: params.data.organizationId,
          limit: query.data.limit,
          ...(query.data.cursor ? { cursor: query.data.cursor } : {}),
        }),
      );
    } catch (error) {
      if (error instanceof AdminBeneficiaryValidationError) return invalidRequest(reply);
      throw error;
    }
  });

  app.get(
    "/v1/admin/organizations/:organizationId/beneficiaries/:beneficiaryId",
    async (request, reply) => {
      const params = beneficiaryParamsSchema.safeParse(request.params);
      if (!params.success) return invalidRequest(reply);
      const authorization = await requireAdminPermission(
        request,
        reply,
        dependencies,
        params.data.organizationId,
        "beneficiary.read",
      );
      if (!authorization) return;
      const beneficiary = await dependencies.beneficiaries.getBeneficiary(
        params.data.organizationId,
        params.data.beneficiaryId,
      );
      return beneficiary
        ? reply.code(200).send({ beneficiary })
        : reply.code(404).send({ error: "not_found" });
    },
  );

  app.post("/v1/admin/organizations/:organizationId/beneficiaries", async (request, reply) => {
    const params = organizationParamsSchema.safeParse(request.params);
    const body = createBodySchema.safeParse(request.body);
    if (!params.success || !body.success) return invalidRequest(reply);
    const authorization = await requireAdminPermission(
      request,
      reply,
      dependencies,
      params.data.organizationId,
      "beneficiary.create",
    );
    if (!authorization) return;
    try {
      return sendCreateResult(
        reply,
        await dependencies.beneficiaries.createBeneficiary(authorization, body.data),
      );
    } catch (error) {
      if (error instanceof AdminBeneficiaryValidationError) return invalidRequest(reply);
      throw error;
    }
  });

  app.post(
    "/v1/admin/organizations/:organizationId/beneficiaries/:beneficiaryId/suspend",
    async (request, reply) => {
      const params = beneficiaryParamsSchema.safeParse(request.params);
      if (!params.success) return invalidRequest(reply);
      const authorization = await requireAdminPermission(
        request,
        reply,
        dependencies,
        params.data.organizationId,
        "beneficiary.suspend",
      );
      if (!authorization) return;
      return sendSuspendResult(
        reply,
        await dependencies.beneficiaries.suspendBeneficiary(
          authorization,
          params.data.beneficiaryId,
        ),
      );
    },
  );
}

function sendCreateResult(reply: FastifyReply, result: AdminBeneficiaryCreateResult) {
  switch (result.outcome) {
    case "CREATED":
      return reply.code(201).send({
        outcome: result.outcome,
        changed: true,
        requestId: result.requestId,
        beneficiary: result.beneficiary,
        auditReceipt: result.audit,
      });
    case "REPLAYED":
      return reply.code(200).send({
        outcome: result.outcome,
        changed: false,
        requestId: result.requestId,
        beneficiary: result.beneficiary,
      });
    case "CONFLICT":
      return reply.code(409).send({ error: "conflict", requestId: result.requestId });
  }
}

function sendSuspendResult(reply: FastifyReply, result: AdminBeneficiarySuspendResult) {
  switch (result.outcome) {
    case "UPDATED":
      return reply.code(200).send({
        outcome: result.outcome,
        changed: true,
        requestId: result.requestId,
        beneficiary: result.beneficiary,
        auditReceipt: result.audit,
      });
    case "REPLAYED":
      return reply.code(200).send({
        outcome: result.outcome,
        changed: false,
        requestId: result.requestId,
        beneficiary: result.beneficiary,
      });
    case "NOT_FOUND":
      return reply.code(404).send({ error: "not_found", requestId: result.requestId });
    case "CONFLICT":
      return reply.code(409).send({ error: "conflict", requestId: result.requestId });
  }
}

function invalidRequest(reply: FastifyReply) {
  reply.header("cache-control", "no-store");
  return reply.code(400).send({ error: "invalid_request" });
}
