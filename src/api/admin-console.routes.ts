import type { FastifyInstance, FastifyReply } from "fastify";
import { ADMIN_CONSOLE_CSS } from "../console/admin-console-styles.js";
import { ADMIN_CONSOLE_HTML } from "../console/admin-console-page.js";
import { ADMIN_CONSOLE_JS } from "../console/admin-console-script.js";

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "font-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export async function registerAdminConsoleRoutes(app: FastifyInstance): Promise<void> {
  app.get("/console", async (_request, reply) => sendAsset(reply, "text/html; charset=utf-8", ADMIN_CONSOLE_HTML));
  app.get("/console/", async (_request, reply) => sendAsset(reply, "text/html; charset=utf-8", ADMIN_CONSOLE_HTML));
  app.get("/console/styles.css", async (_request, reply) => sendAsset(reply, "text/css; charset=utf-8", ADMIN_CONSOLE_CSS));
  app.get("/console/app.js", async (_request, reply) => sendAsset(reply, "text/javascript; charset=utf-8", ADMIN_CONSOLE_JS));
}

function sendAsset(reply: FastifyReply, contentType: string, body: string) {
  reply
    .header("cache-control", "no-store, max-age=0")
    .header("content-security-policy", CONTENT_SECURITY_POLICY)
    .header("referrer-policy", "no-referrer")
    .header("x-content-type-options", "nosniff")
    .header("x-frame-options", "DENY")
    .header("cross-origin-opener-policy", "same-origin")
    .header("cross-origin-resource-policy", "same-origin")
    .header(
      "permissions-policy",
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
    )
    .type(contentType);
  return reply.code(200).send(body);
}
