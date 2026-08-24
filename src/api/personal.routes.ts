import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  PersonalPairingValidationError,
  type PersonalAuthenticatedIdentity,
  type PersonalBootstrapRequest,
  type PersonalPairingCreateRequest,
  type PostgresPersonalPairingService,
} from "../modules/personal/personal-pairing.service.js";
import type { PersonalOwnerBearerAuthenticator } from "../modules/personal/personal-owner-authenticator.js";

const bootstrapBodySchema = z
  .object({
    beneficiaryEmail: z.string().min(3).max(320),
    displayName: z.string().min(1).max(256).optional(),
    accountName: z.string().min(1).max(256).optional(),
  })
  .strict();

const pairingCreateBodySchema = z
  .object({
    externalAgentId: z.string().min(1).max(256),
    displayName: z.string().min(1).max(256).optional(),
    keyId: z.string().min(1).max(256),
    publicKey: z.string().min(1).max(16 * 1024),
  })
  .strict();

const pairingParamsSchema = z.object({ pairingRequestId: z.string().uuid() });
const pairingClaimBodySchema = z.object({ claimSecret: z.string().min(32).max(256) }).strict();

export interface PersonalRouteDependencies {
  readonly authenticator: PersonalOwnerBearerAuthenticator;
  readonly personal: Pick<
    PostgresPersonalPairingService,
    "bootstrap" | "getOwner" | "createPairingRequest" | "getPairingRequest" | "claimPairingRequest"
  >;
}

export async function registerPersonalRoutes(
  app: FastifyInstance,
  dependencies: PersonalRouteDependencies,
): Promise<void> {
  app.post("/v1/personal/bootstrap", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const identity = authenticateOwner(request, dependencies.authenticator);
    if (!identity) return reply.code(401).send({ error: "unauthorized" });

    const parsed = bootstrapBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });

    const bootstrapRequest: PersonalBootstrapRequest = {
      beneficiaryEmail: parsed.data.beneficiaryEmail,
      ...(parsed.data.displayName ? { displayName: parsed.data.displayName } : {}),
      ...(parsed.data.accountName ? { accountName: parsed.data.accountName } : {}),
    };

    try {
      const result = await dependencies.personal.bootstrap(identity, bootstrapRequest);
      if (result.outcome === "CONFLICT") {
        return reply.code(409).send({ outcome: result.outcome, error: "owner_conflict" });
      }
      return reply.code(result.outcome === "CREATED" ? 201 : 200).send({
        outcome: result.outcome,
        owner: result.owner,
      });
    } catch (error) {
      if (error instanceof PersonalPairingValidationError) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      throw error;
    }
  });

  app.get("/v1/personal/me", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const identity = authenticateOwner(request, dependencies.authenticator);
    if (!identity) return reply.code(401).send({ error: "unauthorized" });
    const owner = await dependencies.personal.getOwner(identity);
    if (!owner) return reply.code(404).send({ error: "personal_owner_not_found" });
    return reply.send({ owner });
  });

  app.post("/v1/personal/pairing-requests", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const parsed = pairingCreateBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });

    const pairingRequest: PersonalPairingCreateRequest = {
      externalAgentId: parsed.data.externalAgentId,
      keyId: parsed.data.keyId,
      publicKey: parsed.data.publicKey,
      ...(parsed.data.displayName ? { displayName: parsed.data.displayName } : {}),
    };

    try {
      const pairing = await dependencies.personal.createPairingRequest(pairingRequest);
      return reply.code(201).send({ pairing });
    } catch (error) {
      if (error instanceof PersonalPairingValidationError) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      throw error;
    }
  });

  app.get("/v1/personal/pairing-requests/:pairingRequestId", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const parsed = pairingParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const pairing = await dependencies.personal.getPairingRequest(parsed.data.pairingRequestId);
    if (!pairing) return reply.code(404).send({ error: "pairing_not_found" });
    return reply.send({ pairing });
  });

  app.post("/v1/personal/pairing-requests/:pairingRequestId/claim", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const identity = authenticateOwner(request, dependencies.authenticator);
    if (!identity) return reply.code(401).send({ error: "unauthorized" });

    const parsedParams = pairingParamsSchema.safeParse(request.params);
    const parsedBody = pairingClaimBodySchema.safeParse(request.body);
    if (!parsedParams.success || !parsedBody.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }

    const result = await dependencies.personal.claimPairingRequest(
      identity,
      parsedParams.data.pairingRequestId,
      parsedBody.data.claimSecret,
    );
    switch (result.outcome) {
      case "CLAIMED":
        return reply.code(200).send(result);
      case "REPLAYED":
        return reply.code(200).send(result);
      case "OWNER_NOT_FOUND":
        return reply.code(403).send({ outcome: result.outcome, error: "personal_owner_required" });
      case "NOT_FOUND":
        return reply.code(404).send({ outcome: result.outcome, error: "pairing_not_found" });
      case "INVALID_SECRET":
        return reply.code(403).send({ outcome: result.outcome, error: "pairing_secret_invalid" });
      case "EXPIRED":
        return reply.code(410).send({ outcome: result.outcome, error: "pairing_expired" });
      case "CONFLICT":
        return reply.code(409).send({ outcome: result.outcome, error: "pairing_conflict" });
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
