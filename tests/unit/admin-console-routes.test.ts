import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerAdminConsoleRoutes } from "../../src/api/admin-console.routes.js";
import { ADMIN_CONSOLE_HTML } from "../../src/console/admin-console-page.js";
import { ADMIN_CONSOLE_JS } from "../../src/console/admin-console-script.js";

async function consoleApp() {
  const app = Fastify();
  await registerAdminConsoleRoutes(app);
  return app;
}

describe("administrative web console", () => {
  it("serves a same-origin no-store console under a strict browser policy", async () => {
    const app = await consoleApp();
    const response = await app.inject({ method: "GET", url: "/console" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(response.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(response.headers["content-security-policy"]).toContain("style-src 'self'");
    expect(response.headers["content-security-policy"]).toContain("connect-src 'self'");
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(response.payload).toContain('src="/console/app.js"');
    expect(response.payload).toContain('href="/console/styles.css"');
    expect(response.payload).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);

    await app.close();
  });

  it("serves parseable JavaScript and CSS assets without creating a browser credential or HTML-injection path", async () => {
    const app = await consoleApp();
    const [script, styles] = await Promise.all([
      app.inject({ method: "GET", url: "/console/app.js" }),
      app.inject({ method: "GET", url: "/console/styles.css" }),
    ]);

    expect(script.statusCode).toBe(200);
    expect(script.headers["content-type"]).toContain("text/javascript");
    expect(styles.statusCode).toBe(200);
    expect(styles.headers["content-type"]).toContain("text/css");
    expect(script.headers["cache-control"]).toContain("no-store");
    expect(styles.headers["cache-control"]).toContain("no-store");

    expect(() => new Function(ADMIN_CONSOLE_JS)).not.toThrow();
    expect(ADMIN_CONSOLE_JS).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    expect(ADMIN_CONSOLE_JS).not.toMatch(/\.innerHTML\s*=|insertAdjacentHTML|\beval\s*\(/);
    expect(ADMIN_CONSOLE_JS).toContain('credentials: "omit"');
    expect(ADMIN_CONSOLE_JS).toContain('cache: "no-store"');
    expect(ADMIN_CONSOLE_JS).toContain('referrerPolicy: "no-referrer"');
    expect(ADMIN_CONSOLE_JS).toContain('state.token = ""');
    expect(ADMIN_CONSOLE_JS).not.toContain("state.mandateToken");
    expect(ADMIN_CONSOLE_HTML).toContain('autocomplete="off"');

    await app.close();
  });

  it("uses existing governed APIs and does not invent payment or audit mutation requests", () => {
    for (const path of [
      '"/access"',
      '"/agents"',
      '"/policies"',
      '"/merchants"',
      '"/mandates"',
      '"/approvals?',
      '"/payments?',
      '"/operations"',
      '"/audit/transactions',
      '"/audit/administrative',
    ]) {
      expect(ADMIN_CONSOLE_JS).toContain(path);
    }

    expect(ADMIN_CONSOLE_JS).not.toMatch(/apiRequest\([^\n]*(?:force-success|force-failure)/);
    expect(ADMIN_CONSOLE_JS).not.toMatch(/apiRequest\([^\n]*(?:release|commit)-reservation/);
    expect(ADMIN_CONSOLE_JS).not.toMatch(/apiRequest\([^\n]*(?:repair|rewind|delete)[^\n]*audit/);
    expect(ADMIN_CONSOLE_JS).not.toMatch(/apiRequest\([^\n]*(?:trigger|run)[^\n]*reconcil/);
    expect(ADMIN_CONSOLE_JS).toContain("Four-eyes administrative governance is not implemented yet");
    expect(ADMIN_CONSOLE_JS).toContain("crypto.randomUUID()");
  });
});
