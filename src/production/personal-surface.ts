import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { createClient } from "redis";
import { getAppRuntimeDependencies } from "../app.js";
import { registerPersonalApprovalRoutes } from "../api/personal-approval.routes.js";
import { registerPersonalAuthorityRoutes } from "../api/personal-authority.routes.js";
import { registerPersonalExecutionRoutes } from "../api/personal-execution.routes.js";
import { registerPersonalRoutes } from "../api/personal.routes.js";
import { registerPersonalStripeExecutionRoutes } from "../api/personal-stripe-execution.routes.js";
import { loadPersonalStripeConfig } from "../infrastructure/config/personal-stripe-config.js";
import type { ProductionConfig } from "../infrastructure/config/production-config.js";
import { StaticMandateVerificationKeyResolver } from "../infrastructure/crypto/static-key-providers.js";
import { StaticMerchantCredentialProvider } from "../infrastructure/merchant/static-merchant-credential-provider.js";
import { PgSqlAdapter } from "../infrastructure/postgres/pg-sql-adapter.js";
import { MandateTokenService } from "../modules/mandates/mandate-token.service.js";
import { PostgresPersonalApprovalService } from "../modules/personal/personal-approval.service.js";
import {
  PostgresPersonalAuthorityService,
  RedisPersonalCredentialNonceGuard,
} from "../modules/personal/personal-authority.service.js";
import { PersonalACPExecutionService } from "../modules/personal/personal-execution.service.js";
import {
  PersonalOwnerJwtAuthenticator,
  type PersonalJwtIssuerConfig,
} from "../modules/personal/personal-owner-authenticator.js";
import { PostgresPersonalPairingService } from "../modules/personal/personal-pairing.service.js";
import { PersonalStripeExecutionService } from "../modules/personal/personal-stripe-execution.service.js";
import { FetchStripePaymentIntentClient } from "../modules/providers/stripe/stripe-payment-intent-client.js";

export interface PersonalProductionSurface {
  close(): Promise<void>;
}

/**
 * Compose the opt-in Personal control + execution adapter surface onto the already
 * created Mino application. Personal ACP reuses the production proxy; Personal Stripe
 * reuses the exact production authorization/reservation/audit graph. Provider
 * credentials remain server-side and are never exposed to OpenClaw.
 */
export async function registerPersonalProductionSurface(
  app: FastifyInstance,
  config: ProductionConfig,
  jwtIssuers: readonly PersonalJwtIssuerConfig[],
  now: () => Date = () => new Date(),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<PersonalProductionSurface | undefined> {
  if (jwtIssuers.length === 0) return undefined;
  if (!config.mandateSigningKey) {
    throw new Error("Mino Personal authority requires the configured mandate signing key");
  }

  const runtime = getAppRuntimeDependencies(app);
  if (!runtime.approvals) {
    throw new Error("Mino Personal owner approvals require the durable approval service");
  }
  if (!runtime.receipts) {
    throw new Error("Mino Personal execution requires authorization receipt issuance");
  }

  const stripeConfig = loadPersonalStripeConfig(environment);
  if (stripeConfig && !runtime.economicAuthorization) {
    throw new Error("Mino Personal Stripe execution requires production economic authorization dependencies");
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
    const ownerApprovals = new PostgresPersonalApprovalService(
      sql,
      runtime.approvals,
      now,
    );
    const execution = new PersonalACPExecutionService(
      mandateTokens,
      runtime.proxy,
      new StaticMerchantCredentialProvider(config.merchantCredentials),
    );

    const stripeExecution =
      stripeConfig && runtime.economicAuthorization
        ? new PersonalStripeExecutionService({
            ...runtime.economicAuthorization,
            stripeClient: new FetchStripePaymentIntentClient(),
            stripeTarget: stripeConfig.target,
            credentials: {
              async getAuthorization(organizationId, providerTargetId) {
                return organizationId === stripeConfig.target.organizationId &&
                  providerTargetId === stripeConfig.target.id
                  ? stripeConfig.authorization
                  : undefined;
              },
            },
          })
        : undefined;

    await registerPersonalRoutes(app, { personal, authenticator });
    await registerPersonalAuthorityRoutes(app, { authority, authenticator });
    await registerPersonalApprovalRoutes(app, {
      approvals: ownerApprovals,
      authenticator,
    });
    await registerPersonalExecutionRoutes(app, {
      execution,
      receipts: runtime.receipts,
      now,
    });
    if (stripeExecution) {
      await registerPersonalStripeExecutionRoutes(app, {
        execution: stripeExecution,
        receipts: runtime.receipts,
        now,
      });
    }

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