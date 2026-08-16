import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  AdminMerchantValidationError,
  type AdminMerchantCreateResult,
  type AdminMerchantLifecycleResult,
  type AdminMerchantUpdateResult,
  type PostgresAdminMerchantAdministrationService,
} from "../modules/admin/admin-merchant-administration.js";
import {
  requireAdminPermission,
  type AdminHttpAuthorizationDependencies,
  type AuthorizedAdminHttpContext,
} from "./admin-http-authorization.js";

const organizationParamsSchema = z.object({ organizationId: z.string().uuid() });
const merchantParamsSchema = z.object({
  organizationId: z.string().uuid(),
  merchantId: z.string().uuid(),
});

const createMerchantBodySchema = z
  .object({
    externalMerchantId: z.string().min(1).max(256),
    domain: z.string().min(1).max(253),
    vendorId: z.string().min(1).max(256).optional(),
    baseUrl: z.string().min(1).max(2048),
  })
  .strict();

const updateMerchantBodySchema = z
  .object({
    domain: z.string().min(1).max(253),
    vendorId: z.string().min(1).max(256).nullable(),
    baseUrl: z.string().min(1).max(2048),
  })
  .strict();

export interface AdminMerchantAdministrationRouteDependencies
  extends AdminHttpAuthorizationDependencies {
  readonly merchantAdministration: Pick<
    PostgresAdminMerchantAdministrationService,
    "getMerchant" | "createMerchant" | "updateConfiguration" | "activate" | "deactivate"
  >;
}

export async function registerAdminMerchantAdministrationRoutes(
  app: FastifyInstance,
  dependencies: AdminMerchantAdministrationRouteDependencies,
): Promise<void> {
  app.get(
    "/v1/admin/organizations/:organizationId/merchants/:merchantId",
    async (request, reply) => {
      const params = merchantParamsSchema.safeParse(request.params);
      if (!params.success) {
        reply.header("cache-control", "no-store");
        return reply.code(400).send({ error: "invalid_request" });
      }
      const authorization = await requireAdminPermission(
        request,
        reply,
        dependencies,
        params.data.organizationId,
        "merchant.read",
      );
      if (!authorization) {
        return;
      }
      const merchant = await dependencies.merchantAdministration.getMerchant(
        params.data.organizationId,
        params.data.merchantId,
      );
      if (!merchant) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.code(200).send({ merchant });
    },
  );

  app.post("/v1/admin/organizations/:organizationId/merchants", async (request, reply) => {
    const params = organizationParamsSchema.safeParse(request.params);
    const body = createMerchantBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      reply.header("cache-control", "no-store");
      return reply.code(400).send({ error: "invalid_request" });
    }
    const authorization = await requireAdminPermission(
      request,
      reply,
      dependencies,
      params.data.organizationId,
      "merchant.manage",
    );
    if (!authorization) {
      return;
    }
    try {
      return sendCreateResult(
        reply,
        await dependencies.merchantAdministration.createMerchant(authorization, body.data),
      );
    } catch (error) {
      if (error instanceof AdminMerchantValidationError) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      throw error;
    }
  });

  app.post(
    "/v1/admin/organizations/:organizationId/merchants/:merchantId/configuration",
    async (request, reply) => {
      const params = merchantParamsSchema.safeParse(request.params);
      const body = updateMerchantBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        reply.header("cache-control", "no-store");
        return reply.code(400).send({ error: "invalid_request" });
      }
      const authorization = await requireAdminPermission(
        request,
        reply,
        dependencies,
        params.data.organizationId,
        "merchant.manage",
      );
      if (!authorization) {
        return;
      }
      try {
        return sendUpdateResult(
          reply,
          await dependencies.merchantAdministration.updateConfiguration(
            authorization,
            params.data.merchantId,
            body.data,
          ),
        );
      } catch (error) {
        if (error instanceof AdminMerchantValidationError) {
          return reply.code(400).send({ error: "invalid_request" });
        }
        throw error;
      }
    },
  );

  app.post(
    "/v1/admin/organizations/:organizationId/merchants/:merchantId/activate",
    async (request, reply) => {
      const input = await authorizeLifecycleMutation(request, reply, dependencies);
      if (!input) {
        return;
      }
      return sendLifecycleResult(
        reply,
        await dependencies.merchantAdministration.activate(input.authorization, input.merchantId),
      );
    },
  );

  app.post(
    "/v1/admin/organizations/:organizationId/merchants/:merchantId/deactivate",
    async (request, reply) => {
      const input = await authorizeLifecycleMutation(request, reply, dependencies);
      if (!input) {
        return;
      }
      return sendLifecycleResult(
        reply,
        await dependencies.merchantAdministration.deactivate(input.authorization, input.merchantId),
      );
    },
  );
}

async function authorizeLifecycleMutation(
  request: Parameters<typeof requireAdminPermission>[0],
  reply: Parameters<typeof requireAdminPermission>[1],
  dependencies: AdminMerchantAdministrationRouteDependencies,
): Promise<
  | {
      readonly authorization: AuthorizedAdminHttpContext;
      readonly merchantId: string;
    }
  | undefined
> {
  const params = merchantParamsSchema.safeParse(request.params);
  if (!params.success) {
    reply.header("cache-control", "no-store");
    await reply.code(400).send({ error: "invalid_request" });
    return undefined;
  }
  const authorization = await requireAdminPermission(
    request,
    reply,
    dependencies,
    params.data.organizationId,
    "merchant.manage",
  );
  if (!authorization) {
    return undefined;
  }
  return { authorization, merchantId: params.data.merchantId };
}

function sendCreateResult(reply: FastifyReply, result: AdminMerchantCreateResult) {
  switch (result.outcome) {
    case "CREATED":
      return reply.code(201).send({
        outcome: result.outcome,
        changed: true,
        requestId: result.requestId,
        merchant: result.merchant,
        auditReceipt: result.audit,
      });
    case "REPLAYED":
      return reply.code(200).send({
        outcome: result.outcome,
        changed: false,
        requestId: result.requestId,
        merchant: result.merchant,
      });
    case "CONFLICT":
      return reply.code(409).send({ error: "conflict", requestId: result.requestId });
  }
}

function sendUpdateResult(reply: FastifyReply, result: AdminMerchantUpdateResult) {
  switch (result.outcome) {
    case "UPDATED":
      return reply.code(200).send({
        outcome: result.outcome,
        changed: true,
        requestId: result.requestId,
        merchant: result.merchant,
        auditReceipt: result.audit,
      });
    case "REPLAYED":
      return reply.code(200).send({
        outcome: result.outcome,
        changed: false,
        requestId: result.requestId,
        merchant: result.merchant,
      });
    case "NOT_FOUND":
      return reply.code(404).send({ error: "not_found", requestId: result.requestId });
    case "CONFLICT":
      return reply.code(409).send({ error: "conflict", requestId: result.requestId });
  }
}

function sendLifecycleResult(reply: FastifyReply, result: AdminMerchantLifecycleResult) {
  switch (result.outcome) {
    case "UPDATED":
      return reply.code(200).send({
        outcome: result.outcome,
        changed: true,
        requestId: result.requestId,
        merchant: result.merchant,
        auditReceipt: result.audit,
      });
    case "REPLAYED":
      return reply.code(200).send({
        outcome: result.outcome,
        changed: false,
        requestId: result.requestId,
        merchant: result.merchant,
      });
    case "NOT_FOUND":
      return reply.code(404).send({ error: "not_found", requestId: result.requestId });
  }
}
