import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { createClient } from "redis";
import { registerPersonalAuthorityRoutes } from "../api/personal-authority.routes.js";
import { registerPersonalRoutes } from "../api/personal.routes.js";
import type { ProductionConfig } from "../infrastructure/config/production-config.js";
import { StaticMandateVerificationKeyResolver } from "../infrastructure/crypto/static-key-providers.js";
import { PgSqlAdapter } from "../infrastructure/postgres/pg-sql-adapter.js";
import { MandateTokenService } from "../modules/mandates/mandate-token.service.js";
import {
  PostgresPersonalAuthorityService,
  RedisPersonalCredentialNonceGuard,
} from "../modules/personal/personal-authority.service.js";
import { PersonalOwnerJwtAuthenticator, type PersonalJwtIssuerConfig } from "../modules/personal/personal-owner-authenticator.js";
import { PostgresPersonalPairingService } from "../modules/personal/personal-pairing.service.js";

export interface PersonalProductionSurface {
  close(): Promise<void>;
}

/**
 * Compose the opt-in Personal control surface onto the already-created Mino Fastify
 * instance. It can bind human authority into Policy/AgentMandate state, but still
 * receives no merchant credentials and cannot dispatch an economic transaction.
 */
export async function registerPersonalProductionSurface(
  app: FastifyInstance,
  config: ProductionConfig,
  jwtIssuers: readonly PersonalJwtIssuerConfig[],
  now: () => Date = () => new Date(),
): Promise<PersonalProductionSurface | undefined> {
  if (jwtIssuers.length === 0) return undefined;
  if (!config.mandateSigningKey) {
    throw new Error("Mino Personal authority requires the configured mandate signing key");
  }

  const pool = new Pool({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 5_000,
    max: 3,
  });
  const redis = createClient({ url: config.redisUrl });
  redis.on("error", () => undefined);

  try {
    await pool.query("select 1");
    await redis.connect();
    await redis.ping();

    const sql = new PgSqlAdapter(pool);
    const personal = new PostgresPersonalPairingService(sql, undefined, now);
    const authenticator = new PersonalOwnerJwtAuthenticator(jwtIssuers, now);
    const mandateTokens = new MandateTokenService(
      new StaticMandateVerificationKeyResolver(config.mandateVerificationKeys),
      { issuer: config.issuer },
    );
    const authority = new PostgresPersonalAuthorityService(
      sql,
      mandateTokens,
      config.mandateSigningKey,
      config.issuer,
      new RedisPersonalCredentialNonceGuard({
        set: (key, value, options) => redis.set(key, value, options),
      }),
      undefined,
      now,
    );

    await registerPersonalRoutes(app, { personal, authenticator });
    await registerPersonalAuthorityRoutes(app, { authority, authenticator });
    return {
      async close(): Promise<void> {
        if (redis.isOpen) await redis.quit();
        await pool.end();
      },
    };
  } catch (error) {
    if (redis.isOpen) await redis.quit().catch(() => undefined);
    await pool.end().catch(() => undefined);
    throw error;
  }
}
