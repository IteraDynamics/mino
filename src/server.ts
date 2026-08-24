import "dotenv/config";
import { randomUUID } from "node:crypto";
import { loadAdminJwtIssuerConfiguration } from "./infrastructure/config/admin-jwt-config.js";
import { loadAuditCheckpointRetentionConfig } from "./infrastructure/config/audit-checkpoint-retention-config.js";
import { loadOperationalMetricsConfig } from "./infrastructure/config/operational-metrics-config.js";
import { loadPersonalJwtIssuerConfiguration } from "./infrastructure/config/personal-jwt-config.js";
import { loadProductionConfig } from "./infrastructure/config/production-config.js";
import { WebhookAdminAuditCheckpointRetainer } from "./modules/admin/admin-audit-checkpoint-retention.js";
import { WebhookAuditCheckpointRetainer } from "./modules/audit/audit-checkpoint-retention.js";
import { paymentReconciliationNeedsAttention } from "./modules/payments/payment-reconciliation-monitor.js";
import { createProductionApplication } from "./production/application.js";
import { NonOverlappingWorkerLoop } from "./production/non-overlapping-worker-loop.js";
import { registerPersonalProductionSurface } from "./production/personal-surface.js";

const config = loadProductionConfig();
const adminJwtIssuers = loadAdminJwtIssuerConfiguration();
const personalJwtIssuers = loadPersonalJwtIssuerConfiguration();
const auditCheckpointRetentionConfig = loadAuditCheckpointRetentionConfig();
const operationalMetricsConfig = loadOperationalMetricsConfig();
const production = await createProductionApplication(config, {
  auditCheckpointRetainer: new WebhookAuditCheckpointRetainer(auditCheckpointRetentionConfig),
  adminAuditCheckpointRetainer: new WebhookAdminAuditCheckpointRetainer(
    auditCheckpointRetentionConfig,
  ),
  ...(adminJwtIssuers.length > 0 ? { adminJwtIssuers } : {}),
  ...(operationalMetricsConfig ? { operationalMetrics: operationalMetricsConfig } : {}),
});
let personalSurface: Awaited<ReturnType<typeof registerPersonalProductionSurface>>;
try {
  personalSurface = await registerPersonalProductionSurface(
    production.app,
    config,
    personalJwtIssuers,
  );
} catch (error) {
  await production.close().catch(() => undefined);
  throw error;
}

const auditCheckpointRetention = production.auditCheckpointRetention;
const adminAuditCheckpointRetention = production.adminAuditCheckpointRetention;
if (!auditCheckpointRetention || !adminAuditCheckpointRetention) {
  await personalSurface?.close().catch(() => undefined);
  await production.close();
  throw new Error("Audit checkpoint retention workers were not configured");
}

const approvalNotificationWorkerId = `approval-notify-${randomUUID()}`;
const paymentReconciliationWorkerId = `payment-reconcile-${randomUUID()}`;
let shuttingDown = false;

const approvalNotificationLoop = new NonOverlappingWorkerLoop({
  intervalMs: 2_000,
  run: async () => {
    const result = await production.approvalNotifications.runOnce(
      approvalNotificationWorkerId,
      new Date(),
    );
    if (result.claimed > 0) {
      production.app.log.info({ result }, "Processed approval notification outbox");
    }
  },
  onError: (error) => {
    production.app.log.error({ error }, "Approval notification outbox run failed");
  },
});

const paymentReconciliationLoop = new NonOverlappingWorkerLoop({
  intervalMs: 2_000,
  run: async () => {
    const now = new Date();
    const result = await production.reconciler.runOnce(paymentReconciliationWorkerId, now);
    if (result.claimed > 0 || result.errors > 0) {
      production.app.log.info({ result }, "Processed payment reconciliation batch");
    }

    const snapshot = await production.reconciliationMonitor.snapshot(new Date());
    if (paymentReconciliationNeedsAttention(snapshot)) {
      production.app.log.warn(
        { paymentReconciliation: snapshot },
        "Unresolved payment outcomes require operational attention",
      );
    } else if (snapshot.unresolved > 0) {
      production.app.log.info(
        { paymentReconciliation: snapshot },
        "Payment outcomes remain within reconciliation window",
      );
    }
  },
  onError: (error) => {
    production.app.log.error({ error }, "Payment reconciliation loop failed");
  },
});

const auditCheckpointRetentionLoop = new NonOverlappingWorkerLoop({
  intervalMs: 60_000,
  run: async () => {
    const result = await auditCheckpointRetention.runOnce();
    if (result.failed > 0) {
      production.app.log.warn(
        { auditCheckpointRetention: result },
        "Signed transaction-audit checkpoints could not be retained externally",
      );
    } else if (result.delivered > 0) {
      production.app.log.info(
        { auditCheckpointRetention: result },
        "Retained signed transaction-audit checkpoints externally",
      );
    }
  },
  onError: (error) => {
    production.app.log.error({ error }, "Transaction-audit checkpoint retention loop failed");
  },
});

const adminAuditCheckpointRetentionLoop = new NonOverlappingWorkerLoop({
  intervalMs: 60_000,
  run: async () => {
    const result = await adminAuditCheckpointRetention.runOnce();
    if (result.failed > 0) {
      production.app.log.warn(
        { adminAuditCheckpointRetention: result },
        "Signed administrative-audit checkpoints could not be retained externally",
      );
    } else if (result.delivered > 0) {
      production.app.log.info(
        { adminAuditCheckpointRetention: result },
        "Retained signed administrative-audit checkpoints externally",
      );
    }
  },
  onError: (error) => {
    production.app.log.error(
      { error },
      "Administrative-audit checkpoint retention loop failed",
    );
  },
});

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  production.app.log.info({ signal }, "Shutting down Mino");
  try {
    await Promise.all([
      approvalNotificationLoop.stop(),
      paymentReconciliationLoop.stop(),
      auditCheckpointRetentionLoop.stop(),
      adminAuditCheckpointRetentionLoop.stop(),
    ]);
    await production.close();
    await personalSurface?.close();
    process.exitCode = 0;
  } catch (error) {
    production.app.log.error({ error }, "Mino shutdown failed");
    process.exitCode = 1;
  }
}

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

try {
  await production.app.listen({
    host: config.host,
    port: config.port,
  });
  approvalNotificationLoop.start();
  paymentReconciliationLoop.start();
  auditCheckpointRetentionLoop.start();
  adminAuditCheckpointRetentionLoop.start();
} catch (error) {
  production.app.log.error({ error }, "Mino failed to start");
  await Promise.all([
    approvalNotificationLoop.stop(),
    paymentReconciliationLoop.stop(),
    auditCheckpointRetentionLoop.stop(),
    adminAuditCheckpointRetentionLoop.stop(),
  ]).catch(() => undefined);
  await production.close().catch(() => undefined);
  await personalSurface?.close().catch(() => undefined);
  process.exitCode = 1;
}
