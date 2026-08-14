import "dotenv/config";
import { randomUUID } from "node:crypto";
import { loadProductionConfig } from "./infrastructure/config/production-config.js";
import { createProductionApplication } from "./production/application.js";

const config = loadProductionConfig();
const production = await createProductionApplication(config);
const approvalNotificationWorkerId = `approval-notify-${randomUUID()}`;
let approvalNotificationRunning = false;
let approvalNotificationTimer: NodeJS.Timeout | undefined;

async function runApprovalNotifications(): Promise<void> {
  if (approvalNotificationRunning || shuttingDown) {
    return;
  }
  approvalNotificationRunning = true;
  try {
    const result = await production.approvalNotifications.runOnce(
      approvalNotificationWorkerId,
      new Date(),
    );
    if (result.claimed > 0) {
      production.app.log.info({ result }, "Processed approval notification outbox");
    }
  } catch (error) {
    production.app.log.error({ error }, "Approval notification outbox run failed");
  } finally {
    approvalNotificationRunning = false;
  }
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  if (approvalNotificationTimer) {
    clearInterval(approvalNotificationTimer);
    approvalNotificationTimer = undefined;
  }
  production.app.log.info({ signal }, "Shutting down Mino");
  try {
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
  await runApprovalNotifications();
  approvalNotificationTimer = setInterval(() => {
    void runApprovalNotifications();
  }, 2_000);
  approvalNotificationTimer.unref();
} catch (error) {
  production.app.log.error({ error }, "Mino failed to start");
  await production.close().catch(() => undefined);
  process.exitCode = 1;
}
