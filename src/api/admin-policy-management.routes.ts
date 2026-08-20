import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  AdminGovernancePermissionError,
  AdminGovernanceValidationError,
  type AdminGovernanceProposalResult,
  type PostgresAdminHighRiskGovernanceService,
} from "../modules/admin/admin-high-risk-governance.js";
import {
  AdminPolicyValidationError,
  type AdminPolicyCreateResult,
  type AdminPolicyLifecycleResult,
  type PostgresAdminPolicyManagementService,
} from "../modules/admin/admin-policy-management.js";
import {
  requireAdminPermission,
  type AdminHttpAuthorizationDependencies,
  type AuthorizedAdminHttpContext,
} from "./admin-http-authorization.js";

const policyParamsSchema = z.object({
  organizationId: z.string().uuid(),
  policyId: z.string().uuid(),
});
const organizationParamsSchema = z.object({ organizationId: z.string().uuid() });
const idempotencyKeySchema = z.string().min(1).max(256).refine(
  (value) => !/[\u0000-\u001f\u007f]/.test(value),
  "idempotency key must not contain control characters",
);

const policyConfigurationShape = {
  baseCurrency: z.string().min(3).max(3),
  maxBudgetMinor: z.string().min(1).max(19),
  rollingDailyLimitMinor: z.string().min(1).max(19),
  approvedMerchantDomains: z.array(z.string().min(1).max(253)).max(100),
  approvedVendorIds: z.array(z.string().min(1).max(256)).max(100),
  restrictedCategories: z.array(z.string().min(1).max(128)).max(100),
  approvalMode: z.enum(["AUTO_APPROVE", "DUAL_SIGNATURE_SLACK", "HARD_BLOCK"]),
  maxTransactionsPerMinute: z.number().int().min(0).max(100_000),
  crossMerchantWindowSecs: z.number().int().min(1).max(86_400),
  maxDistinctMerchants: z.number().int().min(0).max(100_000),
} as const;

const createPolicyBodySchema = z
  .object({
    name: z.string().min(1).max(256),
    ...policyConfigurationShape,
  })
  .strict();

const createPolicyVersionBodySchema = z
  .object({
    version: z.number().int().min(1).max(2_147_483_647),
    ...policyConfigurationShape,
  })
  .strict();

export interface AdminPolicyManagementRouteDependencies
  extends AdminHttpAuthorizationDependencies {
  readonly policyManagement: Pick<
    PostgresAdminPolicyManagementService,
    "getPolicy" | "createPolicy" | "createVersion" | "activate" | "deactivate"
  >;
  readonly highRiskGovernance?: Pick<
    PostgresAdminHighRiskGovernanceService,
    "proposePolicyActivation"
  >;
}

export async function registerAdminPolicyManagementRoutes(
  app: FastifyInstance,
  dependencies: AdminPolicyManagementRouteDependencies,
): Promise<void> {
  app.get("/v1/admin/organizations/:organizationId/policies/:policyId", async (request, reply) => {
    const params = policyParamsSchema.safeParse(request.params);
    if (!params.success) {
      reply.header("cache-control", "no-store");
      return reply.code(400).send({ error: "invalid_request" });
    }
    const authorization = await requireAdminPermission(
      request,
      reply,
      dependencies,
      params.data.organizationId,
      "policy.read",
    );
    if (!authorization) return;
    const policy = await dependencies.policyManagement.getPolicy(
      params.data.organizationId,
      params.data.policyId,
    );
    if (!policy) return reply.code(404).send({ error: "not_found" });
    return reply.code(200).send({ policy });
  });

  app.post("/v1/admin/organizations/:organizationId/policies", async (request, reply) => {
    const params = organizationParamsSchema.safeParse(request.params);
    const body = createPolicyBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      reply.header("cache-control", "no-store");
      return reply.code(400).send({ error: "invalid_request" });
    }
    const authorization = await requireAdminPermission(
      request,
      reply,
      dependencies,
      params.data.organizationId,
      "policy.create",
    );
    if (!authorization) return;
    try {
      return sendCreateResult(
        reply,
        await dependencies.policyManagement.createPolicy(authorization, body.data),
      );
    } catch (error) {
      if (error instanceof AdminPolicyValidationError) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      throw error;
    }
  });

  app.post(
    "/v1/admin/organizations/:organizationId/policies/:policyId/versions",
    async (request, reply) => {
      const params = policyParamsSchema.safeParse(request.params);
      const body = createPolicyVersionBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        reply.header("cache-control", "no-store");
        return reply.code(400).send({ error: "invalid_request" });
      }
      const authorization = await requireAdminPermission(
        request,
        reply,
        dependencies,
        params.data.organizationId,
        "policy.create",
      );
      if (!authorization) return;
      try {
        return sendCreateResult(
          reply,
          await dependencies.policyManagement.createVersion(
            authorization,
            params.data.policyId,
            body.data,
          ),
        );
      } catch (error) {
        if (error instanceof AdminPolicyValidationError) {
          return reply.code(400).send({ error: "invalid_request" });
        }
        throw error;
      }
    },
  );

  app.post(
    "/v1/admin/organizations/:organizationId/policies/:policyId/activate",
    async (request, reply) => {
      const input = await authorizeLifecycleMutation(
        request,
        reply,
        dependencies,
        "policy.activate",
      );
      if (!input) return;
      if (dependencies.highRiskGovernance) {
        const idempotency = idempotencyKeySchema.safeParse(request.headers["idempotency-key"]);
        if (!idempotency.success) {
          reply.header("cache-control", "no-store");
          return reply.code(400).send({ error: "invalid_request" });
        }
        try {
          return sendGovernanceProposalResult(
            reply,
            await dependencies.highRiskGovernance.proposePolicyActivation(
              input.authorization,
              input.policyId,
              idempotency.data,
            ),
          );
        } catch (error) {
          if (error instanceof AdminGovernanceValidationError) {
            return reply.code(400).send({ error: "invalid_request" });
          }
          if (error instanceof AdminGovernancePermissionError) {
            return reply.code(403).send({ error: "forbidden" });
          }
          throw error;
        }
      }
      return sendLifecycleResult(
        reply,
        await dependencies.policyManagement.activate(input.authorization, input.policyId),
      );
    },
  );

  app.post(
    "/v1/admin/organizations/:organizationId/policies/:policyId/deactivate",
    async (request, reply) => {
      const input = await authorizeLifecycleMutation(
        request,
        reply,
        dependencies,
        "policy.deactivate",
      );
      if (!input) return;
      return sendLifecycleResult(
        reply,
        await dependencies.policyManagement.deactivate(input.authorization, input.policyId),
      );
    },
  );
}

async function authorizeLifecycleMutation(
  request: Parameters<typeof requireAdminPermission>[0],
  reply: Parameters<typeof requireAdminPermission>[1],
  dependencies: AdminPolicyManagementRouteDependencies,
  permission: "policy.activate" | "policy.deactivate",
): Promise<
  | {
      readonly authorization: AuthorizedAdminHttpContext;
      readonly policyId: string;
    }
  | undefined
> {
  const params = policyParamsSchema.safeParse(request.params);
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
    permission,
  );
  if (!authorization) return undefined;
  return { authorization, policyId: params.data.policyId };
}

function sendGovernanceProposalResult(
  reply: FastifyReply,
  result: AdminGovernanceProposalResult,
) {
  switch (result.outcome) {
    case "PENDING_GOVERNANCE":
      return reply.code(202).send({
        outcome: result.outcome,
        changed: false,
        requestId: result.requestId,
        governanceRequest: result.governanceRequest,
        auditReceipt: result.audit,
      });
    case "REPLAYED":
      return reply.code(200).send({
        outcome: result.outcome,
        changed: false,
        requestId: result.requestId,
        governanceRequest: result.governanceRequest,
      });
    case "ALREADY_APPLIED":
      return reply.code(200).send({
        outcome: result.outcome,
        changed: false,
        requestId: result.requestId,
        resourceType: result.resourceType,
        resourceId: result.resourceId,
      });
    case "CONFLICT":
      return reply.code(409).send({ error: "conflict", requestId: result.requestId });
    case "NOT_FOUND":
      return reply.code(404).send({ error: "not_found", requestId: result.requestId });
    case "INVALID_TARGET":
      return reply.code(409).send({ error: "invalid_target", requestId: result.requestId });
  }
}

function sendCreateResult(reply: FastifyReply, result: AdminPolicyCreateResult) {
  switch (result.outcome) {
    case "CREATED":
      return reply.code(201).send({
        outcome: result.outcome,
        changed: true,
        requestId: result.requestId,
        policy: result.policy,
        auditReceipt: result.audit,
      });
    case "REPLAYED":
      return reply.code(200).send({
        outcome: result.outcome,
        changed: false,
        requestId: result.requestId,
        policy: result.policy,
      });
    case "NOT_FOUND":
      return reply.code(404).send({ error: "not_found", requestId: result.requestId });
    case "CONFLICT":
      return reply.code(409).send({ error: "conflict", requestId: result.requestId });
  }
}

function sendLifecycleResult(reply: FastifyReply, result: AdminPolicyLifecycleResult) {
  switch (result.outcome) {
    case "UPDATED":
      return reply.code(200).send({
        outcome: result.outcome,
        changed: true,
        requestId: result.requestId,
        policy: result.policy,
        auditReceipt: result.audit,
      });
    case "REPLAYED":
      return reply.code(200).send({
        outcome: result.outcome,
        changed: false,
        requestId: result.requestId,
        policy: result.policy,
      });
    case "NOT_FOUND":
      return reply.code(404).send({ error: "not_found", requestId: result.requestId });
  }
}
