import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { registerPersonalRoutes } from "../api/personal.routes.js";
import { PgSqlAdapter } from "../infrastructure/postgres/pg-sql-adapter.js";
import { PersonalOwnerJwtAuthenticator, type PersonalJwtIssuerConfig } from "../modules/personal/personal-owner-authenticator.js";
import { PostgresPersonalPairingService } from "../modules/personal/personal-pairing.service.js";

export interface PersonalProductionSurface {
  close(): Promise<void>;
}

/**
 * Compose the opt-in Personal control surface onto the already-created Mino Fastify
 * instance. This surface has no merchant/payment credentials and cannot execute an
 * economic action; it owns only Personal human identity/bootstrap/pairing state.
 */
export async function registerPersonalProductionSurface(
  app: FastifyInstance,
  databaseUrl: string,
  jwtIssuers: readonly PersonalJwtIssuerConfig[],
  now: () => Date = () => new Date(),
): Promise<PersonalProductionSurface | undefined> {
  if (jwtIssuers.length === 0) return undefined;

  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5_000,
    max: 3,
  });

  try {
    await pool.query("select 1");
    const personal = new PostgresPersonalPairingService(new PgSqlAdapter(pool), undefined, now);
    const authenticator = new PersonalOwnerJwtAuthenticator(jwtIssuers, now);
    await registerPersonalRoutes(app, { personal, authenticator });
    return {
      async close(): Promise<void> {
        await pool.end();
      },
    };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}
