import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  ADMIN_CONSOLE_BUNDLE,
  ADMIN_CONSOLE_STYLE_BUNDLE,
  registerAdminConsoleRoutes,
} from "../../src/api/admin-console.routes.js";
import { createApp } from "../../src/app.js";
import { ADMIN_CONSOLE_HTML } from "../../src/console/admin-console-page.js";

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

  it("registers the console only when trusted administrative ingress is configured", async () => {
    const withoutAdmin = await createApp({ proxy: {} as never });
    const absent = await withoutAdmin.inject({ method: "GET", url: "/console" });
    expect(absent.statusCode).toBe(404);
    await withoutAdmin.close();

    const withAdmin = await createApp({
      proxy: {} as never,
      adminAccess: {} as never,
    });
    const present = await withAdmin.inject({ method: "GET", url: "/console" });
    expect(present.statusCode).toBe(200);
    expect(present.headers["cache-control"]).toContain("no-store");
    await withAdmin.close();
  });

  it("serves parseable first-party assets without creating a browser credential or HTML-injection path", async () => {
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

    expect(() => new Function(ADMIN_CONSOLE_BUNDLE)).not.toThrow();
    expect(ADMIN_CONSOLE_BUNDLE).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    expect(ADMIN_CONSOLE_BUNDLE).not.toMatch(/\.innerHTML\s*=|insertAdjacentHTML|\beval\s*\(/);
    expect(ADMIN_CONSOLE_BUNDLE).toContain('credentials: "omit"');
    expect(ADMIN_CONSOLE_BUNDLE).toContain('cache: "no-store"');
    expect(ADMIN_CONSOLE_BUNDLE).toContain('referrerPolicy: "no-referrer"');
    expect(ADMIN_CONSOLE_BUNDLE).toContain('state.token = ""');
    expect(ADMIN_CONSOLE_BUNDLE).not.toContain("state.mandateToken");
    expect(ADMIN_CONSOLE_HTML).toContain('autocomplete="off"');
    expect(ADMIN_CONSOLE_STYLE_BUNDLE).toContain(".principal-chip");
    expect(ADMIN_CONSOLE_STYLE_BUNDLE).toContain(".pilot-setup-grid");

    await app.close();
  });

  it("presents human-readable enrolled identity while preserving stable technical IDs", () => {
    expect(ADMIN_CONSOLE_BUNDLE).toContain("pilotAccessPresentation");
    expect(ADMIN_CONSOLE_BUNDLE).toContain("organization.name");
    expect(ADMIN_CONSOLE_BUNDLE).toContain("principal.displayName");
    expect(ADMIN_CONSOLE_BUNDLE).toContain("principal.email");
    expect(ADMIN_CONSOLE_BUNDLE).toContain("Organization & administrator");
    expect(ADMIN_CONSOLE_BUNDLE).toContain("Technical access");
    expect(ADMIN_CONSOLE_BUNDLE).toContain("Organization ID");
    expect(ADMIN_CONSOLE_BUNDLE).toContain("Principal ID");
  });

  it("makes beneficiary setup human-readable and selects an active beneficiary during mandate proposal", () => {
    expect(ADMIN_CONSOLE_BUNDLE).toContain('key: "beneficiaries"');
    expect(ADMIN_CONSOLE_BUNDLE).toContain("Spending beneficiaries");
    expect(ADMIN_CONSOLE_BUNDLE).toContain('permission: "beneficiary.read"');
    expect(ADMIN_CONSOLE_BUNDLE).toContain('hasPermission("beneficiary.create")');
    expect(ADMIN_CONSOLE_BUNDLE).toContain('hasPermission("beneficiary.suspend")');
    expect(ADMIN_CONSOLE_BUNDLE).toContain('apiRequest("/beneficiaries?limit=100")');
    expect(ADMIN_CONSOLE_BUNDLE).toContain('label: "Beneficiary"');
    expect(ADMIN_CONSOLE_BUNDLE).toContain("Create an active beneficiary before proposing a mandate.");
    expect(ADMIN_CONSOLE_BUNDLE).not.toContain("/beneficiaries/\" + encodeURIComponent(item.id) + \"/reactivate");
  });

  it("guides first-run setup from beneficiary through governed mandate without inventing new authority", () => {
    expect(ADMIN_CONSOLE_BUNDLE).toContain("Pilot setup");
    expect(ADMIN_CONSOLE_BUNDLE).toContain("Design-partner onboarding");
    expect(ADMIN_CONSOLE_BUNDLE).toContain("Beneficiary");
    expect(ADMIN_CONSOLE_BUNDLE).toContain("Agent identity");
    expect(ADMIN_CONSOLE_BUNDLE).toContain("Execution route");
    expect(ADMIN_CONSOLE_BUNDLE).toContain("Governed mandate");
    expect(ADMIN_CONSOLE_BUNDLE).toContain('item.action === "MANDATE_ISSUE"');
    expect(ADMIN_CONSOLE_BUNDLE).toContain('pilotSetupRead("beneficiary.read"');
    expect(ADMIN_CONSOLE_BUNDLE).toContain('pilotSetupRead("mandate.read"');
    expect(ADMIN_CONSOLE_BUNDLE).toContain('pilotSetupRead("governance.read"');
  });

  it("uses human major-unit policy inputs but submits the existing exact minor-unit API shape", () => {
    expect(ADMIN_CONSOLE_BUNDLE).toContain("majorCurrencyToMinor");
    expect(ADMIN_CONSOLE_BUNDLE).toContain("minorCurrencyToMajor");
    expect(ADMIN_CONSOLE_BUNDLE).toContain('name: "maxBudgetMajor"');
    expect(ADMIN_CONSOLE_BUNDLE).toContain('name: "rollingDailyLimitMajor"');
    expect(ADMIN_CONSOLE_BUNDLE).toContain("Per-transaction limit (major units)");
    expect(ADMIN_CONSOLE_BUNDLE).toContain("without floating-point arithmetic");
    expect(ADMIN_CONSOLE_BUNDLE).toContain("maxBudgetMinor: majorCurrencyToMinor(raw.maxBudgetMajor, currency)");
    expect(ADMIN_CONSOLE_BUNDLE).toContain("rollingDailyLimitMinor: majorCurrencyToMinor(raw.rollingDailyLimitMajor, currency)");
    expect(ADMIN_CONSOLE_BUNDLE).toContain("Changing the currency does not perform foreign-exchange conversion");
  });

  it("uses existing governed APIs, reflects completed four-eyes governance, and invents no payment/audit mutation requests", () => {
    for (const path of [
      '"/access"',
      '"/beneficiaries?',
      '"/agents"',
      '"/policies"',
      '"/merchants"',
      '"/mandates"',
      '"/governance?',
      '"/approvals?',
      '"/payments?',
      '"/operations"',
      '"/audit/transactions',
      '"/audit/administrative',
    ]) {
      expect(ADMIN_CONSOLE_BUNDLE).toContain(path);
    }

    expect(ADMIN_CONSOLE_BUNDLE).not.toMatch(/apiRequest\([^\n]*(?:force-success|force-failure)/);
    expect(ADMIN_CONSOLE_BUNDLE).not.toMatch(/apiRequest\([^\n]*(?:release|commit)-reservation/);
    expect(ADMIN_CONSOLE_BUNDLE).not.toMatch(/apiRequest\([^\n]*(?:repair|rewind|delete)[^\n]*audit/);
    expect(ADMIN_CONSOLE_BUNDLE).not.toMatch(/apiRequest\([^\n]*(?:trigger|run)[^\n]*reconcil/);
    expect(ADMIN_CONSOLE_BUNDLE).not.toContain("Four-eyes administrative governance is not implemented yet");
    expect(ADMIN_CONSOLE_BUNDLE).toContain("Four-eyes governance active");
    expect(ADMIN_CONSOLE_BUNDLE).toContain("The bounded four-eyes workflow applies to mandate issuance and policy activation");
    expect(ADMIN_CONSOLE_BUNDLE).toContain("crypto.randomUUID()");
  });
});
