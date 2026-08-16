import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { createClient } from "redis";
import { PrismaClient } from "../generated/prisma/client.js";
import { createApp } from "../app.js";
import { PostgresAdminAgentEnrollmentService } from "../modules/admin/admin-agent-enrollment.js";
import {
  AdminAuditCheckpointRetentionWorker,
  PostgresAdminAuditCheckpointIssuer,
  PostgresRetainedAdminAuditVerifier,
  type AdminAuditCheckpointRetainer,
} from "../modules/admin/admin-audit-checkpoint-retention.js";
import {
  PostgresAdminChangeAuditLedger,
  PostgresAdminChangeAuditVerifier,
} from "../modules/admin/admin-change-audit-ledger.js";
import { AdminAuthorizer } from "../modules/admin/admin-authorizer.js";
import {
  AdminJwtAuthenticator,
  type AdminJwtIssuerConfig,
} from "../modules/admin/admin-jwt-authenticator.js";
import { AgentRequestVerifier } from "../modules/agents/agent-request-verifier.js";
import { HmacApprovalResolutionAuthenticator } from "../modules/approvals/approval-resolution-authenticator.js";
import {
  NoopHumanApprovalEmitter,
  WebhookApprovalEmitter,
} from "../modules/approvals/approval-emitter.js";
import { ApprovalNotificationOutboxWorker } from "../modules/approvals/approval-notification-outbox.worker.js";
import { PostgresApprovalRequestStore } from "../modules/approvals/approval-request.store.js";
import { DurableHumanApprovalService } from "../modules/approvals/durable-approval.service.js";
import {
  AuditCheckpointRetentionWorker,
  type AuditCheckpointRetainer,
} from "../modules/audit/audit-checkpoint-retention.js";
import {
  PostgresAuditLedger,
  PostgresAuditVerifier,
} from "../modules/audit/postgres-audit-ledger.js";
import { MandateTokenService } from "../modules/mandates/mandate-token.service.js";
import { BackgroundPaymentReconciler } from "../modules/payments/background-payment-reconciler.js";
import { PaymentReconciliationMonitor } from "../modules/payments/payment-reconciliation-monitor.js";
import { PostgresPaymentOutcomeStore } from "../modules/payments/payment-outcome.store.js";
import { PolicyEvaluator } from "../modules/policy/policy-evaluator.js";
import { ACPAdapter } from "../modules/proxy/acp-adapter.js";
import { CheckoutLifecycleProxyService } from "../modules/proxy/checkout-lifecycle-proxy.service.js";
import { CheckoutProxyService } from "../modules/proxy/checkout-proxy.service.js";
import { DelegationAssertionService } from "../modules/proxy/delegation-assertion.service.js";
import {
  FetchACPMerchantClient,
  type ACPMerchantClient,
} from "../modules/proxy/merchant-client.js";
import { AuthorizationReservationService } from "../modules/spending/authorization-reservation.service.js";
import {
  ReconstructingAuthorizationReservations,
  RedisAuthorizationStateReconstructor,
} from "../modules/spending/authorization-state-reconstruction.js";
import { ExpiryAwareAuthorizationReservations } from "../modules/spending/expiry-aware-authorization-reservations.js";
import { PostgresSpendReservationStore } from "../modules/spending/postgres-spend-reservation.store.js";
import type { OperationalMetricsConfig } from "../infrastructure/config/operational-metrics-config.js";
import type { ProductionConfig } from "../infrastructure/config/production-config.js";
import {
  StaticAuditKeyProvider,
  StaticMandateVerificationKeyResolver,
} from "../infrastructure/crypto/static-key-providers.js";
import { StaticMerchantCredentialProvider } from "../infrastructure/merchant/static-merchant-credential-provider.js";
import { PgSqlAdapter } from "../infrastructure/postgres/pg-sql-adapter.js";
import { PrismaAdminAuthorizationContextRepository } from "../infrastructure/prisma/admin-authorization.repository.js";
import { PrismaAdminInventoryRepository } from "../infrastructure/prisma/admin-inventory.repository.js";
import {
  PrismaAgentVerificationKeyResolver,
  PrismaMandateRepository,
  PrismaMerchantRegistry,
  PrismaPolicyRepository,
} from "../infrastructure/prisma/control-plane.repositories.js";
import {
  RedisAuthorizationScriptClient,
  RedisNonceReplayGuard,
} from "../infrastructure/redis/redis-adapters.js";
import { PostgresOperationalMetrics } from "../operations/postgres-operational-metrics.js";

export interface ProductionApplicationOverrides {
  readonly merchantClient?: ACPMerchantClient;
  readonly auditCheckpointRetainer?: AuditCheckpointRetainer;
  readonly adminAuditCheckpointRetainer?: AdminAuditCheckpointRetainer;
  readonly operationalMetrics?: OperationalMetricsConfig;
  readonly adminJwtIssuers?: readonly AdminJwtIssuerConfig[];
  readonly generateId?: () => string;
  readonly now?: () => Date;
  readonly logger?: boolean;
}

export interface ProductionApplication {
  readonly app: Awaited<ReturnType<typeof createApp>>;
  readonly reconciler: BackgroundPaymentReconciler;
  readonly reconciliationMonitor: PaymentReconciliationMonitor;
  readonly approvalNotifications: ApprovalNotificationOutboxWorker;
  readonly auditCheckpointRetention?: AuditCheckpointRetentionWorker;
  readonly adminAuditCheckpointRetention?: AdminAuditCheckpointRetentionWorker;
  readonly authorizationStateReconstructor: RedisAuthorizationStateReconstructor;
  readonly auditVerifier: PostgresAuditVerifier;
  readonly adminAudit: PostgresAdminChangeAuditLedger;
  readonly adminAuditVerifier: PostgresAdminChangeAuditVerifier;
  readonly retainedAdminAuditVerifier: PostgresRetainedAdminAuditVerifier;
  readonly adminAccess?: {
    readonly authenticator: AdminJwtAuthenticator;
    readonly authorizer: AdminAuthorizer;
  };
  readonly repositories: {
    readonly mandates: PrismaMandateRepository;
    readonly merchants: PrismaMerchantRegistry;
    readonly policies: PrismaPolicyRepository;
    readonly agentKeys: PrismaAgentVerificationKeyResolver;
    readonly adminAuthorization: PrismaAdminAuthorizationContextRepository;
    readonly adminInventory: PrismaAdminInventoryRepository;
  };
  readiness(): Promise<boolean>;
  close(): Promise<void>;
}

export async function createProductionApplication(
  config: ProductionConfig,
  overrides: ProductionApplicationOverrides = {},
): Promise<ProductionApplication> {
  const generateId = overrides.generateId ?? randomUUID;
  const clock = overrides.now ?? (() => new Date());
  const sqlPool = new Pool({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 5_000,
  });
  const redis = createClient({ url: config.redisUrl });
  redis.on("error", () => undefined);

  const prismaAdapter = new PrismaPg({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 5_000,
  });
  const prisma = new PrismaClient({ adapter: prismaAdapter });

  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    await sqlPool.query("select 1");
    await redis.connect();
    await redis.ping();
    await prisma.$connect();
    await prisma.$queryRawUnsafe("select 1");

    const sql = new PgSqlAdapter(sqlPool);
    const mandates = new PrismaMandateRepository(prisma);
    const merchants = new PrismaMerchantRegistry(prisma);
    const policies = new PrismaPolicyRepository(prisma);
    const agentKeys = new PrismaAgentVerificationKeyResolver(prisma);
    const adminAuthorization = new PrismaAdminAuthorizationContextRepository(prisma);
    const adminInventory = new PrismaAdminInventoryRepository(prisma);
    const adminAccess = overrides.adminJwtIssuers?.length
      ? {
          authenticator: new AdminJwtAuthenticator(overrides.adminJwtIssuers, clock),
          authorizer: new AdminAuthorizer(adminAuthorization),
        }
      : undefined;

    const mandateTokens = new MandateTokenService(
      new StaticMandateVerificationKeyResolver(config.mandateVerificationKeys),
      { issuer: config.issuer },
    );
    const agentRequests = new AgentRequestVerifier(
      agentKeys,
      new RedisNonceReplayGuard(redis),
    );
    const redisAuthorization = new RedisAuthorizationScriptClient(redis);
    const rawReservations = new AuthorizationReservationService(redisAuthorization);
    const expiryAwareReservations = new ExpiryAwareAuthorizationReservations(
      rawReservations,
      redisAuthorization,
    );
    const durableReservations = new PostgresSpendReservationStore(sql);
    const authorizationStateReconstructor = new RedisAuthorizationStateReconstructor(
      sql,
      redisAuthorization,
    );
    await authorizationStateReconstructor.reconstructAll(clock());
    const reservations = new ReconstructingAuthorizationReservations(
      expiryAwareReservations,
      authorizationStateReconstructor,
      clock,
      durableReservations,
    );
    const paymentOutcomes = new PostgresPaymentOutcomeStore(sql);

    const approvals = new DurableHumanApprovalService(
      new PostgresApprovalRequestStore(sql),
      new NoopHumanApprovalEmitter(),
      generateId,
    );
    const approvalNotifications = new ApprovalNotificationOutboxWorker(
      sql,
      new WebhookApprovalEmitter(config.approvalWebhook),
    );
    const approvalAuthenticator = new HmacApprovalResolutionAuthenticator({
      secret: config.approvalResolutionSecret,
    });

    const auditKeys = new StaticAuditKeyProvider(
      config.auditSigningKey,
      config.auditVerificationKeys,
    );
    const audit = new PostgresAuditLedger(sql, auditKeys);
    const auditVerifier = new PostgresAuditVerifier(sql, auditKeys);
    const adminAudit = new PostgresAdminChangeAuditLedger(sql, auditKeys);
    const adminAgentEnrollment = new PostgresAdminAgentEnrollmentService(
      sql,
      adminAudit,
      generateId,
      clock,
    );
    const adminAuditVerifier = new PostgresAdminChangeAuditVerifier(sql, auditKeys);
    const adminAuditCheckpointIssuer = new PostgresAdminAuditCheckpointIssuer(sql, auditKeys);
    const retainedAdminAuditVerifier = new PostgresRetainedAdminAuditVerifier(
      sql,
      adminAuditVerifier,
      auditKeys,
    );
    const auditCheckpointRetention = overrides.auditCheckpointRetainer
      ? new AuditCheckpointRetentionWorker(sql, audit, overrides.auditCheckpointRetainer)
      : undefined;
    const adminAuditCheckpointRetention = overrides.adminAuditCheckpointRetainer
      ? new AdminAuditCheckpointRetentionWorker(
          sql,
          adminAuditCheckpointIssuer,
          overrides.adminAuditCheckpointRetainer,
        )
      : undefined;
    const merchantClient = overrides.merchantClient ?? new FetchACPMerchantClient();
    const proxy = new CheckoutProxyService({
      mandateTokens,
      mandates,
      agentRequests,
      merchants,
      merchantClient,
      adapter: new ACPAdapter(),
      evaluator: new PolicyEvaluator({
        generateId,
        monotonicMicros: () => Math.floor(performance.now() * 1_000),
      }),
      reservations,
      paymentOutcomes,
      delegationAssertions: new DelegationAssertionService(
        config.delegationSigningKey,
        generateId,
        { issuer: config.issuer },
      ),
      approvals,
      audit,
      generateId,
    });

    const lifecycleProxy = merchantClient.updateCheckout
      ? new CheckoutLifecycleProxyService({
          mandateTokens,
          mandates,
          agentRequests,
          merchants,
          merchantClient: {
            getCheckout: merchantClient.getCheckout.bind(merchantClient),
            updateCheckout: merchantClient.updateCheckout.bind(merchantClient),
            cancelCheckout: merchantClient.cancelCheckout.bind(merchantClient),
          },
          audit,
          generateId,
        })
      : undefined;
    const operationalMetrics = overrides.operationalMetrics
      ? new PostgresOperationalMetrics(sql)
      : undefined;

    app = await createApp({
      proxy,
      ...(lifecycleProxy ? { lifecycleProxy } : {}),
      approvals,
      approvalAuthenticator,
      ...(adminAccess
        ? {
            adminAccess,
            adminInventory: {
              ...adminAccess,
              inventory: adminInventory,
            },
            adminAgentEnrollment: {
              ...adminAccess,
              agentEnrollment: adminAgentEnrollment,
            },
          }
        : {}),
      ...(operationalMetrics && overrides.operationalMetrics
        ? {
            metrics: {
              metrics: operationalMetrics,
              bearerToken: overrides.operationalMetrics.bearerToken,
              now: clock,
            },
          }
        : {}),
      logger: overrides.logger ?? true,
      ...(overrides.now ? { now: overrides.now } : {}),
    });

    const readiness = async (): Promise<boolean> => {
      try {
        await Promise.all([
          sqlPool.query("select 1"),
          redis.ping(),
          prisma.$queryRawUnsafe("select 1"),
        ]);
        return true;
      } catch {
        return false;
      }
    };

    app.get("/readyz", async (_request, reply) => {
      if (!(await readiness())) {
        return reply.code(503).send({ status: "not_ready" });
      }
      return { status: "ready" };
    });

    const reconciler = new BackgroundPaymentReconciler({
      outcomes: paymentOutcomes,
      reservations,
      merchants,
      merchantClient,
      credentials: new StaticMerchantCredentialProvider(config.merchantCredentials),
      generateRequestId: generateId,
    });
    const reconciliationMonitor = new PaymentReconciliationMonitor(sql);

    let closed = false;
    return {
      app,
      reconciler,
      reconciliationMonitor,
      approvalNotifications,
      ...(auditCheckpointRetention ? { auditCheckpointRetention } : {}),
      ...(adminAuditCheckpointRetention ? { adminAuditCheckpointRetention } : {}),
      authorizationStateReconstructor,
      auditVerifier,
      adminAudit,
      adminAuditVerifier,
      retainedAdminAuditVerifier,
      ...(adminAccess ? { adminAccess } : {}),
      repositories: {
        mandates,
        merchants,
        policies,
        agentKeys,
        adminAuthorization,
        adminInventory,
      },
      readiness,
      async close(): Promise<void> {
        if (closed) {
          return;
        }
        closed = true;
        await app?.close();
        if (redis.isOpen) {
          await redis.quit();
        }
        await prisma.$disconnect();
        await sqlPool.end();
      },
    };
  } catch (error) {
    await app?.close().catch(() => undefined);
    if (redis.isOpen) {
      await redis.quit().catch(() => undefined);
    }
    await prisma.$disconnect().catch(() => undefined);
    await sqlPool.end().catch(() => undefined);
    throw error;
  }
}
