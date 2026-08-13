import Fastify, { type FastifyInstance } from "fastify";
import { registerACPRoutes } from "./api/acp.routes.js";
import type { CheckoutProxyService } from "./modules/proxy/checkout-proxy.service.js";

export interface CreateAppOptions {
  readonly proxy: CheckoutProxyService;
  readonly logger?: boolean;
  readonly now?: () => Date;
}

export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });

  app.get("/healthz", async () => ({ status: "ok" }));
  await registerACPRoutes(app, {
    proxy: options.proxy,
    ...(options.now ? { now: options.now } : {}),
  });

  return app;
}
