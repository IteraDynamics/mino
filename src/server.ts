import "dotenv/config";
import { loadProductionConfig } from "./infrastructure/config/production-config.js";
import { createProductionApplication } from "./production/application.js";

const config = loadProductionConfig();
const production = await createProductionApplication(config);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
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
} catch (error) {
  production.app.log.error({ error }, "Mino failed to start");
  await production.close().catch(() => undefined);
  process.exitCode = 1;
}
