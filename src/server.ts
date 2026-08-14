import "dotenv/config";
import { randomUUID } from "node:crypto";
import { loadProductionConfig } from "./infrastructure/config/production-config.js";
import { paymentReconciliationNeedsAttention } from "./modules/payments/payment-reconciliation-monitor.js";
import { createProductionApplication } from "./production/application.js";
import { NonOverlappingWorkerLoop } from "./production/non-overlapping-worker-loop.js";

const config = loadProductionConfig();
const production = await createProductionApplication(config);
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
    ]);
    await production.close();
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
} catch (error) {
  production.app.log.error({ error }, "Mino failed to start");
  await Promise.all([
    approvalNotificationLoop.stop(),
    paymentReconciliationLoop.stop(),
  ]).catch(() => undefined);
  await production.close().catch(() => undefined);
  process.exitCode = 1;
}
