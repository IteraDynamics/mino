import Fastify, { type FastifyInstance } from "fastify";
import { registerACPLifecycleRoutes } from "./api/acp-lifecycle.routes.js";
import { registerACPRoutes } from "./api/acp.routes.js";
import {
  registerAdminAccessRoutes,
  type AdminAccessRouteDependencies,
} from "./api/admin-access.routes.js";
import {
  registerAdminAgentEnrollmentRoutes,
  type AdminAgentEnrollmentRouteDependencies,
} from "./api/admin-agent-enrollment.routes.js";
import {
  registerAdminAgentLifecycleRoutes,
  type AdminAgentLifecycleRouteDependencies,
} from "./api/admin-agent-lifecycle.routes.js";
import {
  registerAdminInventoryRoutes,
  type AdminInventoryRouteDependencies,
} from "./api/admin-inventory.routes.js";
import {
  registerAdminPolicyManagementRoutes,
  type AdminPolicyManagementRouteDependencies,
} from "./api/admin-policy-management.routes.js";
import { registerApprovalRoutes } from "./api/approval.routes.js";
import {
  registerMetricsRoute,
  type MetricsRouteDependencies,
} from "./api/metrics.routes.js";
import type { HumanApprovalService } from "./modules/approvals/durable-approval.service.js";
import type { ApprovalResolutionAuthenticator } from "./modules/approvals/approval-resolution-authenticator.js";
import type { CheckoutLifecycleProxyService } from "./modules/proxy/checkout-lifecycle-proxy.service.js";
import type { CheckoutProxyService } from "./modules/proxy/checkout-proxy.service.js";

export interface CreateAppOptions {
  readonly proxy: CheckoutProxyService;
  readonly lifecycleProxy?: CheckoutLifecycleProxyService;
  readonly approvals?: HumanApprovalService;
  readonly approvalAuthenticator?: ApprovalResolutionAuthenticator;
  readonly adminAccess?: AdminAccessRouteDependencies;
  readonly adminInventory?: AdminInventoryRouteDependencies;
  readonly adminAgentEnrollment?: AdminAgentEnrollmentRouteDependencies;
  readonly adminAgentLifecycle?: AdminAgentLifecycleRouteDependencies;
  readonly adminPolicyManagement?: AdminPolicyManagementRouteDependencies;
  readonly metrics?: MetricsRouteDependencies;
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
  if (options.lifecycleProxy) {
    await registerACPLifecycleRoutes(app, {
      lifecycleProxy: options.lifecycleProxy,
      ...(options.now ? { now: options.now } : {}),
    });
  }

  if (options.approvals || options.approvalAuthenticator) {
    if (!options.approvals || !options.approvalAuthenticator) {
      throw new Error("Approval routes require both the approval service and resolution authenticator");
    }
    await registerApprovalRoutes(app, {
      approvals: options.approvals,
      authenticator: options.approvalAuthenticator,
      ...(options.now ? { now: options.now } : {}),
    });
  }

  if (options.adminAccess) {
    await registerAdminAccessRoutes(app, options.adminAccess);
  }
  if (options.adminInventory) {
    await registerAdminInventoryRoutes(app, options.adminInventory);
  }
  if (options.adminAgentEnrollment) {
    await registerAdminAgentEnrollmentRoutes(app, options.adminAgentEnrollment);
  }
  if (options.adminAgentLifecycle) {
    await registerAdminAgentLifecycleRoutes(app, options.adminAgentLifecycle);
  }
  if (options.adminPolicyManagement) {
    await registerAdminPolicyManagementRoutes(app, options.adminPolicyManagement);
  }

  if (options.metrics) {
    await registerMetricsRoute(app, options.metrics);
  }

  return app;
}
