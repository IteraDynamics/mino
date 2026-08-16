export const ADMIN_CONSOLE_JS = String.raw`"use strict";

const state = {
  token: "",
  organizationId: "",
  access: null,
  activeView: "overview",
  renderVersion: 0,
  pages: Object.create(null),
  filters: {
    approvals: "",
    payments: "",
  },
};

const viewDefinitions = [
  { key: "overview", label: "Overview", eyebrow: "Control plane", permission: "organization.read", icon: "◫" },
  { key: "agents", label: "Agents", eyebrow: "Machine identity", permission: "agent.read", icon: "A" },
  { key: "policies", label: "Policies", eyebrow: "Governance", permission: "policy.read", icon: "P" },
  { key: "merchants", label: "Merchants", eyebrow: "Routing boundary", permission: "merchant.read", icon: "M" },
  { key: "mandates", label: "Mandates", eyebrow: "Delegated authority", permission: "mandate.read", icon: "D" },
  { key: "approvals", label: "Approvals", eyebrow: "Human review", permission: "approval.read", icon: "✓" },
  { key: "payments", label: "Payments", eyebrow: "Economic outcomes", permission: "payment.read", icon: "$" },
  { key: "audit", label: "Audit & operations", eyebrow: "Evidence", permission: "audit.read", icon: "◎" },
];

const connectScreen = document.getElementById("connect-screen");
const connectForm = document.getElementById("connect-form");
const connectError = document.getElementById("connect-error");
const organizationInput = document.getElementById("organization-id");
const tokenInput = document.getElementById("admin-token");
const appShell = document.getElementById("app-shell");
const primaryNav = document.getElementById("primary-nav");
const organizationDisplay = document.getElementById("organization-display");
const roleList = document.getElementById("role-list");
const viewEyebrow = document.getElementById("view-eyebrow");
const viewTitle = document.getElementById("view-title");
const viewRoot = document.getElementById("view");
const refreshButton = document.getElementById("refresh-button");
const disconnectButton = document.getElementById("disconnect-button");
const toastRegion = document.getElementById("toast-region");
const modal = document.getElementById("modal");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class ApiFailure extends Error {
  constructor(status, data, message) {
    super(message || "Mino API request failed");
    this.name = "ApiFailure";
    this.status = status;
    this.data = data;
  }
}

connectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  connectError.hidden = true;
  const organizationId = organizationInput.value.trim();
  const token = tokenInput.value.trim();
  if (!UUID_PATTERN.test(organizationId) || !token) {
    showConnectError("Enter a valid organization UUID and administrator token.");
    return;
  }

  const submit = connectForm.querySelector("button[type=submit]");
  submit.disabled = true;
  state.organizationId = organizationId;
  state.token = token;
  try {
    state.access = await apiRequest("/access");
    tokenInput.value = "";
    connectScreen.hidden = true;
    appShell.hidden = false;
    organizationDisplay.textContent = shortId(organizationId, 13);
    organizationDisplay.dataset.fullValue = organizationId;
    renderRoles();
    renderNavigation();
    await navigate(firstAllowedView());
  } catch (error) {
    state.token = "";
    state.organizationId = "";
    state.access = null;
    tokenInput.value = "";
    showConnectError(connectFailureMessage(error));
  } finally {
    submit.disabled = false;
  }
});

refreshButton.addEventListener("click", () => {
  void navigate(state.activeView);
});

disconnectButton.addEventListener("click", () => disconnect(true));

organizationDisplay.addEventListener("click", async () => {
  const value = organizationDisplay.dataset.fullValue || "";
  if (value) {
    await copyText(value, "Organization ID copied.");
  }
});

modal.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeModal();
});

function showConnectError(message) {
  connectError.textContent = message;
  connectError.hidden = false;
}

function connectFailureMessage(error) {
  if (error instanceof ApiFailure) {
    if (error.status === 401) return "The token could not be authenticated.";
    if (error.status === 403) return "This administrator does not have access to that organization.";
    if (error.status === 400) return "The organization ID was rejected.";
  }
  return "Mino could not establish an administrative session. Check the organization, token, and network path.";
}

function firstAllowedView() {
  const allowed = viewDefinitions.find((view) => hasPermission(view.permission));
  return allowed ? allowed.key : "overview";
}

function permissionSet() {
  return new Set(state.access && Array.isArray(state.access.permissions) ? state.access.permissions : []);
}

function hasPermission(permission) {
  return permissionSet().has(permission);
}

function renderRoles() {
  roleList.replaceChildren();
  const roles = state.access && Array.isArray(state.access.roles) ? state.access.roles : [];
  for (const role of roles) {
    roleList.appendChild(element("span", { className: "role-chip", text: humanEnum(role) }));
  }
}

function renderNavigation() {
  primaryNav.replaceChildren();
  for (const definition of viewDefinitions) {
    if (!hasPermission(definition.permission)) continue;
    const button = element("button", { className: "nav-button", attrs: { type: "button" } });
    button.dataset.view = definition.key;
    button.appendChild(element("span", { className: "nav-icon", text: definition.icon, attrs: { "aria-hidden": "true" } }));
    button.appendChild(element("span", { text: definition.label }));
    button.addEventListener("click", () => void navigate(definition.key));
    primaryNav.appendChild(button);
  }
}

async function navigate(key) {
  const definition = viewDefinitions.find((item) => item.key === key);
  if (!definition || !hasPermission(definition.permission)) {
    toast("That section is not available to this administrator.", "error");
    return;
  }
  state.activeView = key;
  const version = ++state.renderVersion;
  viewEyebrow.textContent = definition.eyebrow;
  viewTitle.textContent = definition.label;
  for (const button of primaryNav.querySelectorAll(".nav-button")) {
    button.classList.toggle("active", button.dataset.view === key);
  }
  renderLoading();
  try {
    switch (key) {
      case "overview":
        await renderOverview(version);
        break;
      case "agents":
        await loadAgents(true, version);
        break;
      case "policies":
        await loadPolicies(true, version);
        break;
      case "merchants":
        await loadMerchants(true, version);
        break;
      case "mandates":
        await loadMandates(true, version);
        break;
      case "approvals":
        await loadApprovals(true, version);
        break;
      case "payments":
        await loadPayments(true, version);
        break;
      case "audit":
        await loadAuditPage(version);
        break;
      default:
        throw new Error("Unknown console view");
    }
  } catch (error) {
    if (version !== state.renderVersion) return;
    renderViewError(error);
  }
}

async function apiRequest(suffix, options) {
  const requestOptions = options || {};
  if (!state.token || !state.organizationId) throw new Error("Administrative session is not connected");
  const headers = new Headers();
  headers.set("accept", "application/json");
  headers.set("authorization", "Bearer " + state.token);
  if (requestOptions.body !== undefined) headers.set("content-type", "application/json");
  if (requestOptions.idempotencyKey) headers.set("idempotency-key", requestOptions.idempotencyKey);

  let response;
  try {
    response = await fetch(
      "/v1/admin/organizations/" + encodeURIComponent(state.organizationId) + suffix,
      {
        method: requestOptions.method || "GET",
        headers,
        body: requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body),
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        redirect: "error",
      },
    );
  } catch (error) {
    throw new Error("Network request failed");
  }

  let data = null;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      data = await response.json();
    } catch {
      data = null;
    }
  }

  if (response.status === 401) {
    disconnect(false);
    showConnectError("Your administrator token is no longer valid. Connect again with a fresh token.");
    throw new ApiFailure(401, data, "Authentication expired");
  }
  if (!response.ok) {
    throw new ApiFailure(response.status, data);
  }
  return data;
}

function disconnect(showToast) {
  state.token = "";
  state.organizationId = "";
  state.access = null;
  state.activeView = "overview";
  state.pages = Object.create(null);
  state.filters.approvals = "";
  state.filters.payments = "";
  state.renderVersion += 1;
  tokenInput.value = "";
  organizationInput.value = "";
  organizationDisplay.textContent = "";
  delete organizationDisplay.dataset.fullValue;
  closeModal();
  viewRoot.replaceChildren();
  primaryNav.replaceChildren();
  roleList.replaceChildren();
  appShell.hidden = true;
  connectScreen.hidden = false;
  if (showToast) toast("Disconnected. Browser-held administrator credentials were cleared.", "success");
}

function renderLoading() {
  const box = element("div", { className: "loading-state" });
  box.appendChild(element("div", { className: "loading-dot", attrs: { "aria-label": "Loading" } }));
  viewRoot.replaceChildren(box);
}

function renderViewError(error) {
  const box = element("div", { className: "error-state" });
  const content = element("div");
  content.appendChild(element("strong", { text: "This view could not be loaded." }));
  content.appendChild(element("span", { text: apiErrorMessage(error) }));
  const retry = element("button", { className: "button button-secondary", text: "Retry", attrs: { type: "button" } });
  retry.style.marginTop = "14px";
  retry.addEventListener("click", () => void navigate(state.activeView));
  content.appendChild(retry);
  box.appendChild(content);
  viewRoot.replaceChildren(box);
}

function apiErrorMessage(error) {
  if (error instanceof ApiFailure) {
    if (error.status === 400) return "Mino rejected the request as invalid.";
    if (error.status === 403) return "Your current membership does not have the required permission.";
    if (error.status === 404) return "The requested resource was not found in this organization.";
    if (error.status === 409) return "The requested change conflicts with current durable state.";
    return "Mino returned HTTP " + String(error.status) + ".";
  }
  return error instanceof Error ? error.message : "Unexpected console error.";
}

async function renderOverview(version) {
  const root = element("div");
  root.appendChild(viewToolbar(
    "System state",
    "A permission-aware view of durable control-plane and recovery state.",
    [],
  ));

  if (hasPermission("audit.read")) {
    const response = await apiRequest("/operations");
    if (version !== state.renderVersion) return;
    const operations = response.operations;
    const grid = element("div", { className: "grid" });
    grid.appendChild(metricCard("Unresolved payments", operations.payments.unresolved, detailParts([
      operations.payments.claimable + " claimable",
      operations.payments.stale + " stale",
    ]), operations.payments.unresolved > 0 ? "warn" : "good"));
    grid.appendChild(metricCard("Pending approvals", operations.approvals.pending, detailParts([
      operations.approvals.expiredPending + " past expiry",
      operations.approvals.notificationClaimable + " notifications claimable",
    ]), operations.approvals.expiredPending > 0 ? "warn" : "good"));
    grid.appendChild(metricCard("Overdue reservations", operations.reservations.overdueReserved, detailParts([
      operations.reservations.reserved + " currently reserved",
    ]), operations.reservations.overdueReserved > 0 ? "bad" : "good"));
    grid.appendChild(metricCard("Transaction audit head", operations.audit.transaction.headSequence, operations.audit.transaction.updatedAt ? "Updated " + formatDate(operations.audit.transaction.updatedAt) : "No persisted head", "neutral"));
    grid.appendChild(metricCard("Administrative audit head", operations.audit.administrative.headSequence, operations.audit.administrative.updatedAt ? "Updated " + formatDate(operations.audit.administrative.updatedAt) : "No persisted head", "neutral"));
    grid.appendChild(metricCard("Reconciliation attempts", operations.payments.highAttempt, detailParts([
      operations.payments.leased + " actively leased",
      operations.payments.forwarding + " forwarding",
      operations.payments.unknown + " unknown",
    ]), operations.payments.highAttempt > 0 ? "warn" : "neutral"));
    root.appendChild(grid);
  } else {
    root.appendChild(infoCard("Operational state unavailable", "Your role can operate the control plane but does not have audit.read, so Mino does not expose recovery and audit-head telemetry in this session."));
  }

  const accessHeading = sectionHeading("Current access", "Backend permissions are authoritative; the console only reflects them.");
  root.appendChild(accessHeading);
  const accessGrid = element("div", { className: "grid" });
  const roles = state.access && Array.isArray(state.access.roles) ? state.access.roles : [];
  const permissions = state.access && Array.isArray(state.access.permissions) ? state.access.permissions : [];
  accessGrid.appendChild(detailCard("Principal", [
    ["Principal ID", state.access.principalId],
    ["Membership ID", state.access.membershipId],
    ["Organization", state.access.organizationId],
  ], "card-wide"));
  accessGrid.appendChild(detailCard("Authority", [
    ["Roles", roles.map(humanEnum).join(", ") || "None"],
    ["Permissions", String(permissions.length)],
    ["Authentication", "Pinned-issuer administrator JWT"],
  ], "card-wide"));
  root.appendChild(accessGrid);
  viewRoot.replaceChildren(root);
}

async function loadAgents(reset, version) {
  if (reset) state.pages.agents = { items: [], nextCursor: null };
  const page = state.pages.agents;
  const suffix = "/agents?limit=50" + (!reset && page.nextCursor ? "&cursor=" + encodeURIComponent(page.nextCursor) : "");
  const response = await apiRequest(suffix);
  if (version !== state.renderVersion) return;
  page.items = reset ? response.items : page.items.concat(response.items);
  page.nextCursor = response.nextCursor || null;
  renderAgents();
}

function renderAgents() {
  const page = state.pages.agents;
  const actions = [];
  if (hasPermission("agent.create")) {
    actions.push(actionButton("Enroll agent", "primary", openAgentCreate));
  }
  const root = element("div");
  root.appendChild(viewToolbar("Machine identities", "Enroll agents, suspend compromised identities, and rotate verification keys. Identity management alone does not grant spending authority.", actions));
  if (!page.items.length) {
    root.appendChild(emptyState("No agents", hasPermission("agent.create") ? "Enroll the first machine identity for this organization." : "No agent identities are visible in this organization."));
    viewRoot.replaceChildren(root);
    return;
  }
  const tableNode = dataTable([
    ["Agent", (item) => primaryCell(item.displayName || item.externalAgentId, item.externalAgentId)],
    ["Status", (item) => statusChip(item.status)],
    ["Key", (item) => monoCell(item.keyId || "—")],
    ["Updated", (item) => formatDate(item.updatedAt)],
    ["", (item) => agentActions(item)],
  ], page.items);
  root.appendChild(tableNode);
  appendLoadMore(root, page, () => loadAgents(false, state.renderVersion));
  viewRoot.replaceChildren(root);
}

function agentActions(item) {
  const wrap = element("div", { className: "cell-actions" });
  wrap.appendChild(rowButton("View", () => openResourceDetail("Agent", "/agents/" + encodeURIComponent(item.id), "agent")));
  if (item.status === "ACTIVE" && hasPermission("agent.suspend")) {
    wrap.appendChild(rowButton("Suspend", () => confirmMutation({
      title: "Suspend agent",
      description: "New mandate and key resolution for this agent will fail immediately after the change commits.",
      confirmLabel: "Suspend",
      danger: true,
      request: () => apiRequest("/agents/" + encodeURIComponent(item.id) + "/suspend", { method: "POST" }),
      success: "Agent suspended.",
    })));
  }
  if (item.status === "SUSPENDED" && hasPermission("agent.reactivate")) {
    wrap.appendChild(rowButton("Reactivate", () => confirmMutation({
      title: "Reactivate agent",
      description: "This restores the agent to the active identity resolution path.",
      confirmLabel: "Reactivate",
      request: () => apiRequest("/agents/" + encodeURIComponent(item.id) + "/reactivate", { method: "POST" }),
      success: "Agent reactivated.",
    })));
  }
  if (item.status !== "REVOKED" && hasPermission("agent.rotate_key")) {
    wrap.appendChild(rowButton("Rotate key", () => openAgentRotate(item)));
  }
  return wrap;
}

function openAgentCreate() {
  openFormModal({
    title: "Enroll agent",
    description: "Creates an active cryptographic machine identity. It does not issue a mandate or grant payment authority.",
    submitLabel: "Enroll agent",
    fields: [
      { name: "externalAgentId", label: "External agent ID", required: true },
      { name: "displayName", label: "Display name" },
      { name: "keyId", label: "Key ID", required: true },
      { name: "publicKey", label: "Ed25519 public key (PEM)", type: "textarea", required: true, full: true },
    ],
    onSubmit: async (raw) => {
      const body = {
        externalAgentId: raw.externalAgentId.trim(),
        keyId: raw.keyId.trim(),
        publicKey: raw.publicKey.trim(),
      };
      if (raw.displayName.trim()) body.displayName = raw.displayName.trim();
      await apiRequest("/agents", { method: "POST", body });
      toast("Agent enrolled.", "success");
      void navigate("agents");
    },
  });
}

function openAgentRotate(item) {
  openFormModal({
    title: "Rotate agent key",
    description: "The prior key ID stops resolving when this change commits. Only Ed25519 public keys are accepted.",
    submitLabel: "Rotate key",
    warning: "This is a direct RBAC-authorized security change. Four-eyes administrative governance is not implemented yet.",
    fields: [
      { name: "keyId", label: "New key ID", required: true },
      { name: "publicKey", label: "New Ed25519 public key (PEM)", type: "textarea", required: true, full: true },
    ],
    onSubmit: async (raw) => {
      await apiRequest("/agents/" + encodeURIComponent(item.id) + "/rotate-key", {
        method: "POST",
        body: { keyId: raw.keyId.trim(), publicKey: raw.publicKey.trim() },
      });
      toast("Agent key rotated.", "success");
      void navigate("agents");
    },
  });
}

async function loadPolicies(reset, version) {
  if (reset) state.pages.policies = { items: [], nextCursor: null };
  const page = state.pages.policies;
  const suffix = "/policies?limit=50" + (!reset && page.nextCursor ? "&cursor=" + encodeURIComponent(page.nextCursor) : "");
  const response = await apiRequest(suffix);
  if (version !== state.renderVersion) return;
  page.items = reset ? response.items : page.items.concat(response.items);
  page.nextCursor = response.nextCursor || null;
  renderPolicies();
}

function renderPolicies() {
  const page = state.pages.policies;
  const actions = [];
  if (hasPermission("policy.create")) actions.push(actionButton("Create policy", "primary", openPolicyCreate));
  const root = element("div");
  root.appendChild(viewToolbar("Policy versions", "Policies define reusable governance. Versions are explicit and activation is separate from creation.", actions));
  if (!page.items.length) {
    root.appendChild(emptyState("No policies", hasPermission("policy.create") ? "Create an inactive policy version to begin defining governance." : "No policy versions are visible in this organization."));
    viewRoot.replaceChildren(root);
    return;
  }
  const latestByName = new Map();
  for (const item of page.items) latestByName.set(item.name, Math.max(latestByName.get(item.name) || 0, item.version));
  root.appendChild(dataTable([
    ["Policy", (item) => primaryCell(item.name, "Version " + item.version)],
    ["State", (item) => statusChip(item.active ? "ACTIVE" : "INACTIVE")],
    ["Per transaction", (item) => formatMinor(item.maxBudgetMinor, item.baseCurrency)],
    ["Rolling daily", (item) => formatMinor(item.rollingDailyLimitMinor, item.baseCurrency)],
    ["Approval", (item) => humanEnum(item.approvalMode)],
    ["", (item) => policyActions(item, latestByName.get(item.name) === item.version)],
  ], page.items));
  appendLoadMore(root, page, () => loadPolicies(false, state.renderVersion));
  viewRoot.replaceChildren(root);
}

function policyActions(item, isLatest) {
  const wrap = element("div", { className: "cell-actions" });
  wrap.appendChild(rowButton("View", () => openResourceDetail("Policy", "/policies/" + encodeURIComponent(item.id), "policy")));
  if (isLatest && hasPermission("policy.create")) wrap.appendChild(rowButton("New version", () => openPolicyVersion(item)));
  if (!item.active && hasPermission("policy.activate")) {
    wrap.appendChild(rowButton("Activate", () => confirmMutation({
      title: "Activate policy version",
      description: "Mandates may be issued against this exact policy version after activation. Older active versions are not automatically deactivated.",
      confirmLabel: "Activate",
      warning: "Direct RBAC action; no four-eyes administrative governance is currently applied.",
      request: () => apiRequest("/policies/" + encodeURIComponent(item.id) + "/activate", { method: "POST" }),
      success: "Policy version activated.",
    })));
  }
  if (item.active && hasPermission("policy.deactivate")) {
    wrap.appendChild(rowButton("Deactivate", () => confirmMutation({
      title: "Deactivate policy version",
      description: "Mandates bound to this exact version will stop resolving for new requests immediately.",
      confirmLabel: "Deactivate",
      danger: true,
      warning: "Direct RBAC action; no four-eyes administrative governance is currently applied.",
      request: () => apiRequest("/policies/" + encodeURIComponent(item.id) + "/deactivate", { method: "POST" }),
      success: "Policy version deactivated.",
    })));
  }
  return wrap;
}

function policyFields(seed, includeName) {
  const fields = [];
  if (includeName) fields.push({ name: "name", label: "Policy name", required: true, value: seed.name || "", full: true });
  fields.push(
    { name: "baseCurrency", label: "Base currency", type: "select", required: true, value: seed.baseCurrency || "USD", options: ["USD", "EUR", "GBP", "JPY", "BHD", "KWD"] },
    { name: "approvalMode", label: "Approval mode", type: "select", required: true, value: seed.approvalMode || "AUTO_APPROVE", options: ["AUTO_APPROVE", "DUAL_SIGNATURE_SLACK", "HARD_BLOCK"] },
    { name: "maxBudgetMinor", label: "Per-transaction limit (minor units)", required: true, value: seed.maxBudgetMinor || "0" },
    { name: "rollingDailyLimitMinor", label: "Rolling daily limit (minor units)", required: true, value: seed.rollingDailyLimitMinor || "0" },
    { name: "maxTransactionsPerMinute", label: "Max transactions / minute", type: "number", required: true, value: String(seed.maxTransactionsPerMinute ?? 0) },
    { name: "crossMerchantWindowSecs", label: "Cross-merchant window (seconds)", type: "number", required: true, value: String(seed.crossMerchantWindowSecs ?? 60) },
    { name: "maxDistinctMerchants", label: "Max distinct merchants", type: "number", required: true, value: String(seed.maxDistinctMerchants ?? 0) },
    { name: "approvedMerchantDomains", label: "Approved merchant domains", type: "textarea", full: true, value: (seed.approvedMerchantDomains || []).join("\n"), placeholder: "merchant.example\none-per-line.example" },
    { name: "approvedVendorIds", label: "Approved vendor IDs", type: "textarea", full: true, value: (seed.approvedVendorIds || []).join("\n") },
    { name: "restrictedCategories", label: "Restricted categories", type: "textarea", full: true, value: (seed.restrictedCategories || []).join("\n"), placeholder: "GAMBLING\nALCOHOL" },
  );
  return fields;
}

function policyBody(raw) {
  return {
    baseCurrency: raw.baseCurrency,
    maxBudgetMinor: raw.maxBudgetMinor.trim(),
    rollingDailyLimitMinor: raw.rollingDailyLimitMinor.trim(),
    approvedMerchantDomains: parseList(raw.approvedMerchantDomains),
    approvedVendorIds: parseList(raw.approvedVendorIds),
    restrictedCategories: parseList(raw.restrictedCategories),
    approvalMode: raw.approvalMode,
    maxTransactionsPerMinute: Number(raw.maxTransactionsPerMinute),
    crossMerchantWindowSecs: Number(raw.crossMerchantWindowSecs),
    maxDistinctMerchants: Number(raw.maxDistinctMerchants),
  };
}

function openPolicyCreate() {
  openFormModal({
    title: "Create policy",
    description: "Creates version 1 inactive. Activation is a separate backend-authorized operation.",
    submitLabel: "Create inactive policy",
    fields: policyFields({}, true),
    onSubmit: async (raw) => {
      const body = policyBody(raw);
      body.name = raw.name.trim();
      await apiRequest("/policies", { method: "POST", body });
      toast("Inactive policy created.", "success");
      void navigate("policies");
    },
  });
}

function openPolicyVersion(item) {
  openFormModal({
    title: "Create policy version " + String(item.version + 1),
    description: "The existing version remains immutable. The new version is created inactive and does not change existing mandates.",
    submitLabel: "Create version",
    fields: policyFields(item, false),
    onSubmit: async (raw) => {
      const body = policyBody(raw);
      body.version = item.version + 1;
      await apiRequest("/policies/" + encodeURIComponent(item.id) + "/versions", { method: "POST", body });
      toast("New inactive policy version created.", "success");
      void navigate("policies");
    },
  });
}

async function loadMerchants(reset, version) {
  if (reset) state.pages.merchants = { items: [], nextCursor: null };
  const page = state.pages.merchants;
  const suffix = "/merchants?limit=50" + (!reset && page.nextCursor ? "&cursor=" + encodeURIComponent(page.nextCursor) : "");
  const response = await apiRequest(suffix);
  if (version !== state.renderVersion) return;
  page.items = reset ? response.items : page.items.concat(response.items);
  page.nextCursor = response.nextCursor || null;
  renderMerchants();
}

function renderMerchants() {
  const page = state.pages.merchants;
  const actions = [];
  if (hasPermission("merchant.manage")) actions.push(actionButton("Register merchant", "primary", openMerchantCreate));
  const root = element("div");
  root.appendChild(viewToolbar("Merchant registry", "Registered HTTPS origins form Mino's outbound routing boundary. Credentials remain server-side and are never shown here.", actions));
  if (!page.items.length) {
    root.appendChild(emptyState("No merchants", hasPermission("merchant.manage") ? "Register an inactive merchant endpoint before routing can be activated." : "No merchant endpoints are visible in this organization."));
    viewRoot.replaceChildren(root);
    return;
  }
  root.appendChild(dataTable([
    ["Merchant", (item) => primaryCell(item.externalMerchantId, item.vendorId || "No vendor ID")],
    ["Domain", (item) => monoCell(item.domain)],
    ["State", (item) => statusChip(item.active ? "ACTIVE" : "INACTIVE")],
    ["Updated", (item) => formatDate(item.updatedAt)],
    ["", (item) => merchantActions(item)],
  ], page.items));
  appendLoadMore(root, page, () => loadMerchants(false, state.renderVersion));
  viewRoot.replaceChildren(root);
}

function merchantActions(item) {
  const wrap = element("div", { className: "cell-actions" });
  wrap.appendChild(rowButton("View", () => openResourceDetail("Merchant", "/merchants/" + encodeURIComponent(item.id), "merchant")));
  if (hasPermission("merchant.manage") && !item.active) wrap.appendChild(rowButton("Configure", () => openMerchantConfiguration(item)));
  if (hasPermission("merchant.manage") && !item.active) {
    wrap.appendChild(rowButton("Activate", () => confirmMutation({
      title: "Activate merchant",
      description: "The registered canonical HTTPS origin becomes eligible for subsequent Mino merchant resolution.",
      confirmLabel: "Activate",
      warning: "Direct RBAC action; no four-eyes administrative governance is currently applied.",
      request: () => apiRequest("/merchants/" + encodeURIComponent(item.id) + "/activate", { method: "POST" }),
      success: "Merchant activated.",
    })));
  }
  if (hasPermission("merchant.manage") && item.active) {
    wrap.appendChild(rowButton("Deactivate", () => confirmMutation({
      title: "Deactivate merchant",
      description: "New outbound resolution will fail closed. Existing unresolved outcomes may continue to defer until merchant-authoritative recovery is possible.",
      confirmLabel: "Deactivate",
      danger: true,
      request: () => apiRequest("/merchants/" + encodeURIComponent(item.id) + "/deactivate", { method: "POST" }),
      success: "Merchant deactivated.",
    })));
  }
  return wrap;
}

function openMerchantCreate() {
  openFormModal({
    title: "Register merchant",
    description: "New merchant endpoints are created inactive. Domain and base URL must resolve to the same canonical HTTPS origin.",
    submitLabel: "Register inactive merchant",
    fields: [
      { name: "externalMerchantId", label: "External merchant ID", required: true },
      { name: "vendorId", label: "Vendor ID" },
      { name: "domain", label: "Domain", required: true, placeholder: "merchant.example" },
      { name: "baseUrl", label: "HTTPS origin", required: true, placeholder: "https://merchant.example" },
    ],
    onSubmit: async (raw) => {
      const body = {
        externalMerchantId: raw.externalMerchantId.trim(),
        domain: raw.domain.trim(),
        baseUrl: raw.baseUrl.trim(),
      };
      if (raw.vendorId.trim()) body.vendorId = raw.vendorId.trim();
      await apiRequest("/merchants", { method: "POST", body });
      toast("Inactive merchant registered.", "success");
      void navigate("merchants");
    },
  });
}

async function openMerchantConfiguration(item) {
  try {
    const response = await apiRequest("/merchants/" + encodeURIComponent(item.id));
    const merchant = response.merchant;
    openFormModal({
      title: "Configure merchant",
      description: "Routing configuration can only change while the merchant is inactive.",
      submitLabel: "Save configuration",
      warning: "Changing a merchant domain can leave older unresolved payments deferred against the prior domain. Reconcile unresolved outcomes before repointing when possible.",
      fields: [
        { name: "vendorId", label: "Vendor ID", value: merchant.vendorId || "" },
        { name: "domain", label: "Domain", required: true, value: merchant.domain },
        { name: "baseUrl", label: "HTTPS origin", required: true, value: merchant.baseUrl, full: true },
      ],
      onSubmit: async (raw) => {
        await apiRequest("/merchants/" + encodeURIComponent(item.id) + "/configuration", {
          method: "POST",
          body: {
            vendorId: raw.vendorId.trim() ? raw.vendorId.trim() : null,
            domain: raw.domain.trim(),
            baseUrl: raw.baseUrl.trim(),
          },
        });
        toast("Merchant configuration updated.", "success");
        void navigate("merchants");
      },
    });
  } catch (error) {
    toast(apiErrorMessage(error), "error");
  }
}

async function loadMandates(reset, version) {
  if (reset) state.pages.mandates = { items: [], nextCursor: null };
  const page = state.pages.mandates;
  const suffix = "/mandates?limit=50" + (!reset && page.nextCursor ? "&cursor=" + encodeURIComponent(page.nextCursor) : "");
  const response = await apiRequest(suffix);
  if (version !== state.renderVersion) return;
  page.items = reset ? response.items : page.items.concat(response.items);
  page.nextCursor = response.nextCursor || null;
  renderMandates();
}

function renderMandates() {
  const page = state.pages.mandates;
  const actions = [];
  if (hasPermission("mandate.issue")) actions.push(actionButton("Issue mandate", "primary", openMandateIssue));
  const root = element("div");
  root.appendChild(viewToolbar("Delegated authority", "Mandates bind a user, active agent, and exact active policy version. Raw bearer tokens are never retrievable after initial issuance.", actions));
  if (!page.items.length) {
    root.appendChild(emptyState("No mandates", hasPermission("mandate.issue") ? "Issue delegated authority after agent and policy configuration are ready." : "No mandate authority is visible in this organization."));
    viewRoot.replaceChildren(root);
    return;
  }
  root.appendChild(dataTable([
    ["Mandate", (item) => primaryCell(shortId(item.id, 12), "Policy v" + item.policyVersion)],
    ["Authority", (item) => primaryCell(shortId(item.agentId, 10), "for " + shortId(item.userId, 10))],
    ["State", (item) => statusChip(item.status)],
    ["Per transaction", (item) => formatMinor(item.maxBudgetMinor, item.currency)],
    ["Expires", (item) => formatDate(item.expiresAt)],
    ["", (item) => mandateActions(item)],
  ], page.items));
  appendLoadMore(root, page, () => loadMandates(false, state.renderVersion));
  viewRoot.replaceChildren(root);
}

function mandateActions(item) {
  const wrap = element("div", { className: "cell-actions" });
  wrap.appendChild(rowButton("View", () => openResourceDetail("Mandate", "/mandates/" + encodeURIComponent(item.id), "mandate")));
  if (item.status === "ACTIVE" && hasPermission("mandate.revoke")) {
    wrap.appendChild(rowButton("Revoke", () => confirmMutation({
      title: "Revoke mandate",
      description: "New transaction-path resolution for this delegated authority will fail immediately after commit, even if an already-issued token has not expired.",
      confirmLabel: "Revoke authority",
      danger: true,
      warning: "Direct RBAC action; no four-eyes administrative governance is currently applied.",
      request: () => apiRequest("/mandates/" + encodeURIComponent(item.id) + "/revoke", { method: "POST" }),
      success: "Mandate revoked.",
    })));
  }
  return wrap;
}

async function openMandateIssue() {
  try {
    const [agentsResponse, policiesResponse] = await Promise.all([
      apiRequest("/agents?limit=100"),
      apiRequest("/policies?limit=100"),
    ]);
    const activeAgents = agentsResponse.items.filter((item) => item.status === "ACTIVE" && item.keyId);
    const activePolicies = policiesResponse.items.filter((item) => item.active);
    const warningParts = ["This creates delegated economic authority through direct RBAC. Four-eyes administrative governance is not implemented yet."];
    if (agentsResponse.nextCursor || policiesResponse.nextCursor) warningParts.push("Selection lists show the first 100 visible agents/policies; use IDs directly through the API if the desired resource is beyond this window.");
    const idempotencyKey = crypto.randomUUID();
    openFormModal({
      title: "Issue mandate",
      description: "Mino snapshots the selected active policy exactly. The raw signed bearer token is returned once and cannot be retrieved later.",
      submitLabel: "Issue authority",
      warning: warningParts.join(" "),
      fields: [
        { name: "userId", label: "Beneficiary user ID", required: true, full: true },
        { name: "agentId", label: "Active agent", type: "select", required: true, options: activeAgents.map((item) => ({ value: item.id, label: (item.displayName || item.externalAgentId) + " — " + shortId(item.id, 10) })) },
        { name: "policyId", label: "Active policy version", type: "select", required: true, options: activePolicies.map((item) => ({ value: item.id, label: item.name + " v" + item.version + " — " + formatMinor(item.maxBudgetMinor, item.baseCurrency) })) },
        { name: "expiresAt", label: "Expires at", type: "datetime-local", required: true },
      ],
      onSubmit: async (raw) => {
        if (!raw.agentId || !raw.policyId) throw new Error("An active agent and active policy version are required.");
        const parsedExpiry = new Date(raw.expiresAt);
        if (Number.isNaN(parsedExpiry.getTime())) throw new Error("Enter a valid expiration date and time.");
        const response = await apiRequest("/mandates", {
          method: "POST",
          idempotencyKey,
          body: {
            userId: raw.userId.trim(),
            agentId: raw.agentId,
            policyId: raw.policyId,
            expiresAt: parsedExpiry.toISOString(),
          },
        });
        toast(response.outcome === "REPLAYED" ? "Mandate issuance replayed safely." : "Mandate issued.", "success");
        void navigate("mandates");
        if (response.mandateToken) {
          return { afterClose: () => showOneTimeMandateToken(response.mandateToken, response.mandate) };
        }
      },
    });
  } catch (error) {
    toast(apiErrorMessage(error), "error");
  }
}

function showOneTimeMandateToken(token, mandate) {
  const opened = openModalShell("Mandate issued", "This bearer token is shown once. Mino does not persist it and cannot retrieve it later.");
  opened.body.appendChild(element("div", { className: "danger-box", text: "Store this token in the intended agent credential boundary now. Closing this dialog removes it from the page." }));
  const tokenBox = element("div", { className: "one-time-token", text: token });
  opened.body.appendChild(tokenBox);
  if (mandate && mandate.id) opened.body.appendChild(detailList([["Mandate ID", mandate.id], ["Expires", mandate.expiresAt || "—"]]));
  const copy = element("button", { className: "button button-primary", text: "Copy token", attrs: { type: "button" } });
  copy.addEventListener("click", () => void copyText(token, "Mandate token copied."));
  const done = element("button", { className: "button button-secondary", text: "Done", attrs: { type: "button" } });
  done.addEventListener("click", closeModal);
  opened.actions.append(copy, done);
}

async function loadApprovals(reset, version) {
  if (reset) state.pages.approvals = { items: [], nextCursor: null };
  const page = state.pages.approvals;
  const params = new URLSearchParams({ limit: "50" });
  if (state.filters.approvals) params.set("status", state.filters.approvals);
  if (!reset && page.nextCursor) params.set("cursor", page.nextCursor);
  const response = await apiRequest("/approvals?" + params.toString());
  if (version !== state.renderVersion) return;
  page.items = reset ? response.items : page.items.concat(response.items);
  page.nextCursor = response.nextCursor || null;
  renderApprovals();
}

function renderApprovals() {
  const page = state.pages.approvals;
  const root = element("div");
  root.appendChild(viewToolbar("Human approvals", "Review durable transaction approval requests. Approval does not dispatch payment; the agent must retry through full authorization and revalidation.", []));
  root.appendChild(statusFilter("Approval status", ["", "PENDING", "APPROVED", "REJECTED", "EXPIRED"], state.filters.approvals, (value) => {
    state.filters.approvals = value;
    void loadApprovals(true, state.renderVersion);
  }));
  if (!page.items.length) {
    root.appendChild(emptyState("No approvals", state.filters.approvals ? "No approval requests match this filter." : "No durable approval requests are visible in this organization."));
    viewRoot.replaceChildren(root);
    return;
  }
  root.appendChild(dataTable([
    ["Request", (item) => primaryCell(formatMinor(item.amountMinor, item.currency), item.merchantDomain)],
    ["State", (item) => statusChip(item.status)],
    ["Votes", (item) => String(item.approveCount) + " approve / " + String(item.rejectCount) + " reject"],
    ["Reason", (item) => tagsCell(item.reasonCodes)],
    ["Expires", (item) => formatDate(item.expiresAt)],
    ["", (item) => approvalActions(item)],
  ], page.items));
  appendLoadMore(root, page, () => loadApprovals(false, state.renderVersion));
  viewRoot.replaceChildren(root);
}

function approvalActions(item) {
  const wrap = element("div", { className: "cell-actions" });
  wrap.appendChild(rowButton("View", () => openResourceDetail("Approval", "/approvals/" + encodeURIComponent(item.id), "approval")));
  if (item.status === "PENDING" && hasPermission("approval.vote")) {
    wrap.appendChild(rowButton("Approve", () => openApprovalVote(item, "APPROVE")));
    wrap.appendChild(rowButton("Reject", () => openApprovalVote(item, "REJECT")));
  }
  return wrap;
}

function openApprovalVote(item, decision) {
  openFormModal({
    title: decision === "APPROVE" ? "Approve transaction request" : "Reject transaction request",
    description: formatMinor(item.amountMinor, item.currency) + " at " + item.merchantDomain + ". Your stable Mino admin principal identity is used for distinct-voter semantics.",
    submitLabel: decision === "APPROVE" ? "Cast approval vote" : "Cast rejection vote",
    danger: decision === "REJECT",
    warning: decision === "APPROVE" ? "An approved request still requires the agent to retry the exact transaction through current merchant state, policy, reservation, and machine controls." : undefined,
    fields: [
      { name: "comment", label: "Comment", type: "textarea", full: true, placeholder: "Optional context for this vote" },
    ],
    onSubmit: async (raw) => {
      const body = { decision };
      if (raw.comment.trim()) body.comment = raw.comment.trim();
      const response = await apiRequest("/approvals/" + encodeURIComponent(item.id) + "/votes", { method: "POST", body });
      toast(response.outcome === "REPLAYED" ? "Vote replayed safely." : "Approval vote recorded.", "success");
      void navigate("approvals");
    },
  });
}

async function loadPayments(reset, version) {
  if (reset) state.pages.payments = { items: [], nextCursor: null };
  const page = state.pages.payments;
  const params = new URLSearchParams({ limit: "50" });
  if (state.filters.payments) params.set("status", state.filters.payments);
  if (!reset && page.nextCursor) params.set("cursor", page.nextCursor);
  const response = await apiRequest("/payments?" + params.toString());
  if (version !== state.renderVersion) return;
  page.items = reset ? response.items : page.items.concat(response.items);
  page.nextCursor = response.nextCursor || null;
  renderPayments();
}

function renderPayments() {
  const page = state.pages.payments;
  const root = element("div");
  root.appendChild(viewToolbar("Payment outcomes", "Merchant-authoritative payment and reconciliation state. This console deliberately has no force-success, force-failure, reservation-release, or reconciliation-control action.", []));
  root.appendChild(statusFilter("Payment status", ["", "FORWARDING", "UNKNOWN", "SUCCEEDED", "FAILED_DEFINITIVE"], state.filters.payments, (value) => {
    state.filters.payments = value;
    void loadPayments(true, state.renderVersion);
  }));
  if (!page.items.length) {
    root.appendChild(emptyState("No payments", state.filters.payments ? "No payment outcomes match this filter." : "No durable payment outcomes are visible in this organization."));
    viewRoot.replaceChildren(root);
    return;
  }
  root.appendChild(dataTable([
    ["Payment", (item) => primaryCell(formatMinor(item.amountMinor, item.currency), item.merchantDomain)],
    ["Status", (item) => statusChip(item.status)],
    ["Reconciliation", (item) => statusChip(item.reconciliationState)],
    ["Attempts", (item) => String(item.reconcileAttempts)],
    ["Updated", (item) => formatDate(item.updatedAt)],
    ["", (item) => {
      const wrap = element("div", { className: "cell-actions" });
      wrap.appendChild(rowButton("View", () => openResourceDetail("Payment outcome", "/payments/" + encodeURIComponent(item.id), "payment")));
      return wrap;
    }],
  ], page.items));
  appendLoadMore(root, page, () => loadPayments(false, state.renderVersion));
  viewRoot.replaceChildren(root);
}

async function loadAuditPage(version) {
  state.pages.transactionAudit = { items: [], nextCursor: null };
  state.pages.administrativeAudit = { items: [], nextCursor: null };
  const [operationsResponse, transactionResponse, administrativeResponse] = await Promise.all([
    apiRequest("/operations"),
    apiRequest("/audit/transactions?limit=50"),
    apiRequest("/audit/administrative?limit=50"),
  ]);
  if (version !== state.renderVersion) return;
  state.pages.transactionAudit = { items: transactionResponse.items, nextCursor: transactionResponse.nextCursor || null };
  state.pages.administrativeAudit = { items: administrativeResponse.items, nextCursor: administrativeResponse.nextCursor || null };
  renderAudit(operationsResponse.operations);
}

function renderAudit(operations) {
  state.pages.auditOperations = operations;
  const root = element("div");
  root.appendChild(viewToolbar("Audit & operations", "Inspect durable recovery signals and verify transaction/admin integrity domains without database access.", []));

  const grid = element("div", { className: "grid" });
  grid.appendChild(metricCard("Unresolved payments", operations.payments.unresolved, operations.payments.claimable + " claimable · " + operations.payments.stale + " stale", operations.payments.unresolved > 0 ? "warn" : "good"));
  grid.appendChild(metricCard("Approval notifications", operations.approvals.notificationPending + operations.approvals.notificationLeased, operations.approvals.notificationDeadLetter + " dead letter · " + operations.approvals.notificationClaimable + " claimable", operations.approvals.notificationDeadLetter > 0 ? "bad" : "neutral"));
  grid.appendChild(metricCard("Overdue reservations", operations.reservations.overdueReserved, operations.reservations.reserved + " currently reserved", operations.reservations.overdueReserved > 0 ? "bad" : "good"));
  root.appendChild(grid);

  root.appendChild(sectionHeading("Integrity verification", "Stored chain heads are operational state. These actions run the cryptographic verifiers."));
  const auditGrid = element("div", { className: "audit-grid" });
  auditGrid.appendChild(auditVerificationCard("Transaction audit", "transaction", operations.audit.transaction));
  auditGrid.appendChild(auditVerificationCard("Administrative audit", "administrative", operations.audit.administrative));
  root.appendChild(auditGrid);

  root.appendChild(sectionHeading("Transaction audit", "Recent authorization decisions in the transaction integrity domain."));
  root.appendChild(dataTable([
    ["Sequence", (item) => monoCell(item.chainSequence)],
    ["Decision", (item) => primaryCell(item.operation, item.merchantDomain)],
    ["Verdict", (item) => statusChip(item.verdict)],
    ["Reasons", (item) => tagsCell(item.reasonCodes)],
    ["Time", (item) => formatDate(item.timestamp)],
  ], state.pages.transactionAudit.items));
  appendLoadMore(root, state.pages.transactionAudit, () => loadMoreAudit("transaction"));

  root.appendChild(sectionHeading("Administrative audit", "Recent governed administrator actions in the independent administrative integrity domain."));
  root.appendChild(dataTable([
    ["Sequence", (item) => monoCell(item.chainSequence)],
    ["Action", (item) => primaryCell(item.action, item.resourceType + (item.resourceId ? " · " + shortId(item.resourceId, 10) : ""))],
    ["Permission", (item) => monoCell(item.permission)],
    ["Principal", (item) => monoCell(shortId(item.principalId, 12))],
    ["Time", (item) => formatDate(item.timestamp)],
  ], state.pages.administrativeAudit.items));
  appendLoadMore(root, state.pages.administrativeAudit, () => loadMoreAudit("administrative"));
  viewRoot.replaceChildren(root);
}

async function loadMoreAudit(kind) {
  const pageKey = kind === "transaction" ? "transactionAudit" : "administrativeAudit";
  const page = state.pages[pageKey];
  if (!page.nextCursor) return;
  try {
    const response = await apiRequest("/audit/" + (kind === "transaction" ? "transactions" : "administrative") + "?limit=50&cursor=" + encodeURIComponent(page.nextCursor));
    page.items = page.items.concat(response.items);
    page.nextCursor = response.nextCursor || null;
    renderAudit(state.pages.auditOperations);
  } catch (error) {
    toast(apiErrorMessage(error), "error");
  }
}

function auditVerificationCard(title, kind, head) {
  const card = element("div", { className: "audit-card" });
  const top = element("div", { className: "audit-card-top" });
  const copy = element("div");
  copy.appendChild(element("h3", { text: title }));
  copy.appendChild(element("p", { text: "Stored head sequence " + String(head.headSequence) + (head.updatedAt ? " · " + formatDate(head.updatedAt) : "") }));
  top.appendChild(copy);
  if (hasPermission("audit.verify")) {
    const actions = element("div", { className: "cell-actions" });
    actions.appendChild(rowButton("Verify now", () => verifyAudit(kind, null)));
    actions.appendChild(rowButton("Retained proof", () => openRetainedCheckpointVerify(kind)));
    top.appendChild(actions);
  } else {
    top.appendChild(statusChip("READ ONLY"));
  }
  card.appendChild(top);
  card.appendChild(element("div", { className: "audit-result", text: hasPermission("audit.verify") ? "Verification is explicit and does not repair or mutate a chain." : "audit.verify is not granted to this membership." }));
  return card;
}

async function verifyAudit(kind, checkpoint) {
  try {
    const body = checkpoint ? { retainedCheckpoint: checkpoint } : {};
    const response = await apiRequest("/audit/" + (kind === "transaction" ? "transactions" : "administrative") + "/verify", { method: "POST", body });
    showSafeRecord((kind === "transaction" ? "Transaction" : "Administrative") + " audit verification", response);
  } catch (error) {
    toast(apiErrorMessage(error), "error");
  }
}

function openRetainedCheckpointVerify(kind) {
  openFormModal({
    title: "Verify retained checkpoint",
    description: "Paste the independently retained signed checkpoint. The proof stays only in this dialog and is sent directly to the existing verifier.",
    submitLabel: "Verify retained proof",
    fields: [
      { name: "checkpoint", label: "Signed checkpoint JSON", type: "textarea", required: true, full: true, placeholder: "{ ... }" },
    ],
    onSubmit: async (raw) => {
      let checkpoint;
      try {
        checkpoint = JSON.parse(raw.checkpoint);
      } catch {
        throw new Error("Checkpoint must be valid JSON.");
      }
      const response = await apiRequest("/audit/" + (kind === "transaction" ? "transactions" : "administrative") + "/verify", { method: "POST", body: { retainedCheckpoint: checkpoint } });
      return { afterClose: () => showSafeRecord((kind === "transaction" ? "Transaction" : "Administrative") + " retained-proof verification", response) };
    },
  });
}

async function openResourceDetail(title, suffix, property) {
  try {
    const response = await apiRequest(suffix);
    showSafeRecord(title, response[property]);
  } catch (error) {
    toast(apiErrorMessage(error), "error");
  }
}

function showSafeRecord(title, record) {
  const opened = openModalShell(title, "Safe projection returned by Mino's administrative API.");
  const entries = [];
  if (record && typeof record === "object") {
    for (const key of Object.keys(record)) {
      const value = record[key];
      if (value === undefined) continue;
      entries.push([humanLabel(key), displayValue(value)]);
    }
  } else {
    entries.push(["Value", displayValue(record)]);
  }
  opened.body.appendChild(detailList(entries));
  const done = element("button", { className: "button button-primary", text: "Done", attrs: { type: "button" } });
  done.addEventListener("click", closeModal);
  opened.actions.appendChild(done);
}

function confirmMutation(options) {
  const opened = openModalShell(options.title, options.description);
  if (options.warning) opened.body.appendChild(element("div", { className: "warning-box", text: options.warning }));
  if (options.danger) opened.body.appendChild(element("div", { className: "danger-box", text: "This change takes effect at the same durable source used by the transaction path." }));
  const cancel = element("button", { className: "button button-secondary", text: "Cancel", attrs: { type: "button" } });
  cancel.addEventListener("click", closeModal);
  const confirm = element("button", { className: "button " + (options.danger ? "button-danger" : "button-primary"), text: options.confirmLabel, attrs: { type: "button" } });
  confirm.addEventListener("click", async () => {
    confirm.disabled = true;
    try {
      await options.request();
      closeModal();
      toast(options.success, "success");
      void navigate(state.activeView);
    } catch (error) {
      confirm.disabled = false;
      toast(apiErrorMessage(error), "error");
    }
  });
  opened.actions.append(cancel, confirm);
}

function openFormModal(options) {
  const opened = openModalShell(options.title, options.description);
  if (options.warning) opened.body.appendChild(element("div", { className: "warning-box", text: options.warning }));
  const form = element("form", { attrs: { autocomplete: "off" } });
  const grid = element("div", { className: "modal-grid" });
  for (const spec of options.fields) grid.appendChild(buildFormField(spec));
  form.appendChild(grid);
  const error = element("p", { className: "form-error", attrs: { role: "alert", hidden: "" } });
  form.appendChild(error);
  const actions = element("div", { className: "modal-actions" });
  const cancel = element("button", { className: "button button-secondary", text: "Cancel", attrs: { type: "button" } });
  cancel.addEventListener("click", closeModal);
  const submit = element("button", { className: "button " + (options.danger ? "button-danger" : "button-primary"), text: options.submitLabel, attrs: { type: "submit" } });
  actions.append(cancel, submit);
  form.appendChild(actions);
  opened.body.appendChild(form);
  opened.actions.remove();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.hidden = true;
    submit.disabled = true;
    const raw = Object.create(null);
    for (const [key, value] of new FormData(form).entries()) raw[key] = String(value);
    try {
      const result = await options.onSubmit(raw);
      closeModal();
      if (result && typeof result.afterClose === "function") result.afterClose();
    } catch (caught) {
      if (!modal.open) return;
      error.textContent = apiErrorMessage(caught);
      error.hidden = false;
      submit.disabled = false;
    }
  });
}

function buildFormField(spec) {
  const label = element("label", { className: "field" + (spec.full ? " field-full" : "") });
  label.appendChild(element("span", { text: spec.label }));
  let control;
  if (spec.type === "textarea") {
    control = element("textarea", { attrs: { name: spec.name, autocomplete: "off", spellcheck: "false" } });
    control.value = spec.value || "";
    if (spec.placeholder) control.placeholder = spec.placeholder;
  } else if (spec.type === "select") {
    control = element("select", { attrs: { name: spec.name } });
    const options = spec.options || [];
    if (!options.length) control.appendChild(element("option", { text: "No eligible resources", attrs: { value: "" } }));
    for (const item of options) {
      const option = typeof item === "string" ? { value: item, label: humanEnum(item) } : item;
      const node = element("option", { text: option.label, attrs: { value: option.value } });
      if (String(spec.value || "") === String(option.value)) node.selected = true;
      control.appendChild(node);
    }
  } else {
    control = element("input", { attrs: {
      name: spec.name,
      type: spec.type || "text",
      autocomplete: "off",
      spellcheck: "false",
    } });
    control.value = spec.value || "";
    if (spec.placeholder) control.placeholder = spec.placeholder;
  }
  if (spec.required) control.required = true;
  label.appendChild(control);
  return label;
}

function openModalShell(title, description) {
  closeModal();
  const inner = element("div", { className: "modal-inner" });
  const header = element("div", { className: "modal-header" });
  const copy = element("div");
  copy.appendChild(element("h3", { text: title }));
  if (description) copy.appendChild(element("p", { text: description }));
  const close = element("button", { className: "modal-close", text: "×", attrs: { type: "button", "aria-label": "Close dialog" } });
  close.addEventListener("click", closeModal);
  header.append(copy, close);
  const body = element("div");
  const actions = element("div", { className: "modal-actions" });
  inner.append(header, body, actions);
  modal.replaceChildren(inner);
  modal.showModal();
  return { body, actions };
}

function closeModal() {
  if (modal.open) modal.close();
  modal.replaceChildren();
}

function viewToolbar(title, description, actions) {
  const toolbar = element("div", { className: "view-toolbar" });
  const copy = element("div", { className: "view-toolbar-copy" });
  copy.appendChild(element("h3", { text: title }));
  copy.appendChild(element("p", { text: description }));
  const actionWrap = element("div", { className: "view-toolbar-actions" });
  for (const action of actions) actionWrap.appendChild(action);
  toolbar.append(copy, actionWrap);
  return toolbar;
}

function sectionHeading(title, description) {
  const wrap = element("div", { className: "section-heading" });
  const copy = element("div");
  copy.appendChild(element("h3", { text: title }));
  if (description) copy.appendChild(element("p", { text: description }));
  wrap.appendChild(copy);
  return wrap;
}

function actionButton(label, style, handler) {
  const button = element("button", { className: "button button-" + style, text: label, attrs: { type: "button" } });
  button.addEventListener("click", handler);
  return button;
}

function rowButton(label, handler) {
  const button = element("button", { className: "button button-secondary button-small", text: label, attrs: { type: "button" } });
  button.addEventListener("click", handler);
  return button;
}

function metricCard(label, value, detail, tone) {
  const card = element("div", { className: "card" });
  card.appendChild(element("div", { className: "metric-label", text: label }));
  const valueNode = element("div", { className: "metric-value", text: String(value) });
  if (tone === "good") valueNode.style.color = "var(--signal-dark)";
  if (tone === "warn") valueNode.style.color = "var(--amber)";
  if (tone === "bad") valueNode.style.color = "var(--red)";
  card.appendChild(valueNode);
  card.appendChild(element("div", { className: "metric-detail", text: detail || "" }));
  return card;
}

function detailCard(title, entries, className) {
  const card = element("div", { className: "card " + (className || "") });
  card.appendChild(element("h3", { text: title }));
  card.appendChild(detailList(entries));
  return card;
}

function detailList(entries) {
  const list = element("dl", { className: "key-value" });
  for (const entry of entries) {
    list.appendChild(element("dt", { text: entry[0] }));
    list.appendChild(element("dd", { text: entry[1] === undefined || entry[1] === null || entry[1] === "" ? "—" : String(entry[1]) }));
  }
  return list;
}

function infoCard(title, description) {
  const card = element("div", { className: "card card-full" });
  card.appendChild(element("h3", { text: title }));
  card.appendChild(element("p", { text: description }));
  return card;
}

function dataTable(columns, items) {
  const wrap = element("div", { className: "table-wrap" });
  const table = element("table");
  const thead = element("thead");
  const headerRow = element("tr");
  for (const column of columns) headerRow.appendChild(element("th", { text: column[0] }));
  thead.appendChild(headerRow);
  const tbody = element("tbody");
  for (const item of items) {
    const row = element("tr");
    for (const column of columns) {
      const cell = element("td");
      const value = column[1](item);
      if (value instanceof Node) cell.appendChild(value);
      else cell.textContent = value === undefined || value === null ? "—" : String(value);
      row.appendChild(cell);
    }
    tbody.appendChild(row);
  }
  table.append(thead, tbody);
  wrap.appendChild(table);
  return wrap;
}

function primaryCell(primary, secondary) {
  const wrap = element("div");
  wrap.appendChild(element("span", { className: "cell-primary", text: primary || "—" }));
  if (secondary) wrap.appendChild(element("span", { className: "cell-secondary", text: secondary }));
  return wrap;
}

function monoCell(value) {
  return element("span", { className: "cell-mono", text: value || "—" });
}

function statusChip(status) {
  const normalized = String(status || "UNKNOWN");
  const good = new Set(["ACTIVE", "APPROVED", "SUCCEEDED", "RESOLVED", "DELIVERED", "ALLOW"]);
  const warn = new Set(["PENDING", "FORWARDING", "UNKNOWN", "LEASED", "RESERVED", "PENDING_HUMAN_APPROVAL", "INACTIVE"]);
  const bad = new Set(["REVOKED", "REJECTED", "EXPIRED", "FAILED_DEFINITIVE", "DEAD_LETTER", "BLOCK", "SUSPENDED"]);
  let className = "status-chip";
  if (good.has(normalized)) className += " status-good";
  else if (warn.has(normalized)) className += " status-warn";
  else if (bad.has(normalized)) className += " status-bad";
  return element("span", { className, text: humanEnum(normalized) });
}

function tagsCell(values) {
  const wrap = element("div", { className: "tags" });
  if (!Array.isArray(values) || !values.length) {
    wrap.appendChild(element("span", { className: "tag", text: "None" }));
    return wrap;
  }
  for (const value of values.slice(0, 4)) wrap.appendChild(element("span", { className: "tag", text: humanEnum(value) }));
  if (values.length > 4) wrap.appendChild(element("span", { className: "tag", text: "+" + String(values.length - 4) }));
  return wrap;
}

function emptyState(title, description) {
  const box = element("div", { className: "empty-state" });
  const content = element("div");
  content.appendChild(element("strong", { text: title }));
  content.appendChild(element("span", { text: description }));
  box.appendChild(content);
  return box;
}

function appendLoadMore(root, page, loader) {
  if (!page.nextCursor) return;
  const wrap = element("div", { className: "load-more" });
  const button = element("button", { className: "button button-secondary", text: "Load more", attrs: { type: "button" } });
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await loader();
    } catch (error) {
      button.disabled = false;
      toast(apiErrorMessage(error), "error");
    }
  });
  wrap.appendChild(button);
  root.appendChild(wrap);
}

function statusFilter(label, options, current, onChange) {
  const bar = element("div", { className: "filter-bar" });
  const field = element("label", { className: "field" });
  field.appendChild(element("span", { text: label }));
  const select = element("select");
  for (const value of options) {
    const option = element("option", { text: value ? humanEnum(value) : "All states", attrs: { value } });
    if (value === current) option.selected = true;
    select.appendChild(option);
  }
  select.addEventListener("change", () => onChange(select.value));
  field.appendChild(select);
  bar.appendChild(field);
  return bar;
}

function parseList(value) {
  return String(value || "")
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatMinor(value, currency) {
  const exponents = { USD: 2, EUR: 2, GBP: 2, JPY: 0, BHD: 3, KWD: 3 };
  const exponent = exponents[currency];
  if (exponent === undefined) return String(currency || "") + " " + String(value) + " minor";
  try {
    const amount = BigInt(value);
    const negative = amount < 0n;
    const absolute = negative ? -amount : amount;
    const digits = absolute.toString().padStart(exponent + 1, "0");
    const whole = exponent === 0 ? digits : digits.slice(0, -exponent);
    const fraction = exponent === 0 ? "" : "." + digits.slice(-exponent);
    return String(currency) + " " + (negative ? "-" : "") + whole + fraction;
  } catch {
    return String(currency || "") + " " + String(value) + " minor";
  }
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function shortId(value, length) {
  const text = String(value || "");
  if (text.length <= length) return text;
  const left = Math.max(4, Math.floor((length - 1) / 2));
  const right = Math.max(4, length - left - 1);
  return text.slice(0, left) + "…" + text.slice(-right);
}

function humanEnum(value) {
  return String(value || "")
    .toLowerCase()
    .split("_")
    .map((part) => part ? part.charAt(0).toUpperCase() + part.slice(1) : part)
    .join(" ");
}

function humanLabel(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/^./, (character) => character.toUpperCase());
}

function displayValue(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length ? value.map((item) => typeof item === "object" ? JSON.stringify(item) : String(item)).join(" · ") : "[]";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function detailParts(parts) {
  return parts.filter(Boolean).join(" · ");
}

function element(tag, options) {
  const settings = options || {};
  const node = document.createElement(tag);
  if (settings.className) node.className = settings.className;
  if (settings.text !== undefined) node.textContent = String(settings.text);
  if (settings.attrs) {
    for (const [name, value] of Object.entries(settings.attrs)) {
      if (value === undefined || value === null) continue;
      node.setAttribute(name, String(value));
    }
  }
  return node;
}

async function copyText(value, successMessage) {
  try {
    await navigator.clipboard.writeText(value);
    toast(successMessage, "success");
  } catch {
    toast("Clipboard access was unavailable. Select and copy the value manually.", "error");
  }
}

function toast(message, type) {
  const node = element("div", { className: "toast " + (type === "error" ? "toast-error" : "toast-success"), text: message });
  toastRegion.appendChild(node);
  window.setTimeout(() => node.remove(), 4200);
}
`;
