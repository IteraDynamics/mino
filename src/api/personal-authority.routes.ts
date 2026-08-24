import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PersonalAuthenticatedIdentity } from "../modules/personal/personal-pairing.service.js";
import type { PersonalOwnerBearerAuthenticator } from "../modules/personal/personal-owner-authenticator.js";
import type { PostgresPersonalAuthorityService } from "../modules/personal/personal-authority.service.js";
import { PersonalAuthorityValidationError } from "../modules/personal/personal-authority-compiler.js";

const agentParamsSchema = z.object({ agentId: z.string().uuid() });
const authorityBodySchema = z
  .object({
    currency: z.string().min(3).max(3),
    perTransactionLimit: z.string().min(1).max(64),
    dailyLimit: z.string().min(1).max(64),
    allowedMerchantDomains: z.array(z.string().min(1).max(253)).min(1).max(256),
    restrictedCategories: z.array(z.string().min(1).max(128)).max(256).optional(),
    overLimitBehavior: z.enum(["ASK_OWNER", "BLOCK"]).optional(),
    velocity: z
      .object({
        maxTransactionsPerMinute: z.number().int().optional(),
        crossMerchantWindowSeconds: z.number().int().optional(),
        maxDistinctMerchantsInWindow: z.number().int().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const mandateProofSchema = z
  .object({
    keyId: z.string().min(1).max(256),
    timestamp: z.number().int().positive(),
    nonce: z.string().min(16).max(128),
    signature: z.string().min(80).max(100),
  })
  .strict();

export interface PersonalAuthorityRouteDependencies {
  readonly authenticator: PersonalOwnerBearerAuthenticator;
  readonly authority: Pick<
    PostgresPersonalAuthorityService,
    "getAuthority" | "setAuthority" | "revokeAuthority" | "issueMandate"
  >;
}

export async function registerPersonalAuthorityRoutes(
  app: FastifyInstance,
  dependencies: PersonalAuthorityRouteDependencies,
): Promise<void> {
  app.get("/v1/personal/agents/:agentId/authority", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const identity = authenticateOwner(request, dependencies.authenticator);
    if (!identity) return reply.code(401).send({ error: "unauthorized" });
    const params = agentParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request" });
    const authority = await dependencies.authority.getAuthority(identity, params.data.agentId);
    if (!authority) return reply.code(404).send({ error: "authority_not_found" });
    return reply.send({ authority });
  });

  app.put("/v1/personal/agents/:agentId/authority", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const identity = authenticateOwner(request, dependencies.authenticator);
    if (!identity) return reply.code(401).send({ error: "unauthorized" });
    const params = agentParamsSchema.safeParse(request.params);
    const body = authorityBodySchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_request" });

    const velocity = body.data.velocity
      ? {
          ...(body.data.velocity.maxTransactionsPerMinute === undefined
            ? {}
            : { maxTransactionsPerMinute: body.data.velocity.maxTransactionsPerMinute }),
          ...(body.data.velocity.crossMerchantWindowSeconds === undefined
            ? {}
            : { crossMerchantWindowSeconds: body.data.velocity.crossMerchantWindowSeconds }),
          ...(body.data.velocity.maxDistinctMerchantsInWindow === undefined
            ? {}
            : { maxDistinctMerchantsInWindow: body.data.velocity.maxDistinctMerchantsInWindow }),
        }
      : undefined;

    try {
      const result = await dependencies.authority.setAuthority(identity, params.data.agentId, {
        currency: body.data.currency,
        perTransactionLimit: body.data.perTransactionLimit,
        dailyLimit: body.data.dailyLimit,
        allowedMerchantDomains: body.data.allowedMerchantDomains,
        ...(body.data.restrictedCategories ? { restrictedCategories: body.data.restrictedCategories } : {}),
        ...(body.data.overLimitBehavior ? { overLimitBehavior: body.data.overLimitBehavior } : {}),
        ...(velocity ? { velocity } : {}),
      });
      switch (result.outcome) {
        case "CREATED":
          return reply.code(201).send(result);
        case "UPDATED":
        case "REPLAYED":
          return reply.code(200).send(result);
        case "OWNER_NOT_FOUND":
          return reply.code(403).send({ outcome: result.outcome, error: "personal_owner_required" });
        case "AGENT_NOT_FOUND":
          return reply.code(404).send({ outcome: result.outcome, error: "agent_not_found" });
        case "AGENT_NOT_PAIRED":
          return reply.code(409).send({ outcome: result.outcome, error: "agent_not_paired" });
      }
    } catch (error) {
      if (error instanceof PersonalAuthorityValidationError) {
        return reply.code(400).send({ error: "invalid_authority" });
      }
      throw error;
    }
  });

  app.delete("/v1/personal/agents/:agentId/authority", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const identity = authenticateOwner(request, dependencies.authenticator);
    if (!identity) return reply.code(401).send({ error: "unauthorized" });
    const params = agentParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request" });
    const result = await dependencies.authority.revokeAuthority(identity, params.data.agentId);
    switch (result.outcome) {
      case "REVOKED":
      case "REPLAYED":
        return reply.code(200).send(result);
      case "OWNER_NOT_FOUND":
        return reply.code(403).send({ outcome: result.outcome, error: "personal_owner_required" });
      case "AGENT_NOT_FOUND":
        return reply.code(404).send({ outcome: result.outcome, error: "agent_not_found" });
    }
  });

  app.post("/v1/personal/agents/:agentId/mandate", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const params = agentParamsSchema.safeParse(request.params);
    const proof = mandateProofSchema.safeParse(request.body);
    if (!params.success || !proof.success) return reply.code(400).send({ error: "invalid_request" });
    const result = await dependencies.authority.issueMandate(params.data.agentId, proof.data);
    switch (result.outcome) {
      case "ISSUED":
        return reply.code(201).send(result);
      case "AGENT_NOT_FOUND":
        return reply.code(404).send({ outcome: result.outcome, error: "agent_not_found" });
      case "AUTHORITY_NOT_GRANTED":
        return reply.code(409).send({ outcome: result.outcome, error: "authority_not_granted" });
      case "INVALID_PROOF":
        return reply.code(401).send({ outcome: result.outcome, error: "agent_proof_invalid" });
      case "PROOF_REPLAYED":
        return reply.code(409).send({ outcome: result.outcome, error: "agent_proof_replayed" });
    }
  });
}

function authenticateOwner(
  request: FastifyRequest,
  authenticator: PersonalOwnerBearerAuthenticator,
): PersonalAuthenticatedIdentity | undefined {
  const authentication = authenticator.authenticateAuthorizationHeader(request.headers.authorization);
  if (!authentication.authenticated) return undefined;
  return { issuer: authentication.issuer, subject: authentication.subject };
}
