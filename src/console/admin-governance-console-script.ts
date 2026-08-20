export const ADMIN_GOVERNANCE_CONSOLE_JS = String.raw`

// PR #39 governance augmentation. This script is concatenated into the same ES module as the
// base console so it can reuse the existing memory-only session and UI helpers without creating
// a second browser authority boundary.
state.filters.governance = "";
viewDefinitions.splice(5, 0, {
  key: "governance",
  label: "Governance",
  eyebrow: "Four-eyes control",
  permission: "governance.read",
  icon: "G",
});

const governanceBanner = document.getElementById("governance-banner");
if (governanceBanner) {
  governanceBanner.replaceChildren();
  const copy = element("div");
  copy.appendChild(element("strong", { text: "Four-eyes governance active" }));
  copy.appendChild(element("span", {
    text: "Mandate issuance and policy activation require a durable proposal, approval by a distinct currently authorized administrator, and an explicit revalidated apply step. Other administrative mutations remain direct RBAC and signed-audited.",
  }));
  governanceBanner.appendChild(copy);
}

const baseNavigateWithDirectRbacViews = navigate;
navigate = async function governanceAwareNavigate(key) {
  if (key !== "governance") {
    return baseNavigateWithDirectRbacViews(key);
  }
  if (!hasPermission("governance.read")) {
    toast("Governance visibility is not available to this administrator.", "error");
    return;
  }
  const definition = viewDefinitions.find((item) => item.key === key);
  state.activeView = key;
  const version = ++state.renderVersion;
  viewEyebrow.textContent = definition ? definition.eyebrow : "Four-eyes control";
  viewTitle.textContent = definition ? definition.label : "Governance";
  for (const button of primaryNav.querySelectorAll(".nav-button")) {
    button.classList.toggle("active", button.dataset.view === key);
  }
  renderLoading();
  try {
    await loadGovernance(true, version);
  } catch (error) {
    if (version !== state.renderVersion) return;
    renderViewError(error);
  }
};

policyActions = function governedPolicyActions(item, isLatest) {
  const wrap = element("div", { className: "cell-actions" });
  wrap.appendChild(rowButton("View", () => openResourceDetail("Policy", "/policies/" + encodeURIComponent(item.id), "policy")));
  if (isLatest && hasPermission("policy.create")) {
    wrap.appendChild(rowButton("New version", () => openPolicyVersion(item)));
  }
  if (!item.active && hasPermission("policy.activate")) {
    wrap.appendChild(rowButton("Propose activation", () => confirmMutation({
      title: "Propose policy activation",
      description: "This exact policy version remains inactive until a distinct authorized administrator approves the proposal and an authorized administrator explicitly applies it after revalidation.",
      confirmLabel: "Create proposal",
      warning: "Approval is bound to this exact policy state. If the target or relevant administrative authority changes before apply, Mino marks the proposal stale instead of activating it.",
      request: async () => {
        const response = await apiRequest("/policies/" + encodeURIComponent(item.id) + "/activate", {
          method: "POST",
          idempotencyKey: crypto.randomUUID(),
        });
        if (response.outcome !== "PENDING_GOVERNANCE" && response.outcome !== "REPLAYED") {
          throw new Error("Policy activation proposal returned an unexpected outcome.");
        }
        state.activeView = "governance";
        return response;
      },
      success: "Policy activation proposal created.",
    })));
  }
  if (item.active && hasPermission("policy.deactivate")) {
    wrap.appendChild(rowButton("Deactivate", () => confirmMutation({
      title: "Deactivate policy version",
      description: "Mandates bound to this exact version will stop resolving for new requests immediately.",
      confirmLabel: "Deactivate",
      danger: true,
      warning: "Policy deactivation remains a direct RBAC fail-closed action so authority can be removed without waiting for a second administrator.",
      request: () => apiRequest("/policies/" + encodeURIComponent(item.id) + "/deactivate", { method: "POST" }),
      success: "Policy version deactivated.",
    })));
  }
  return wrap;
};

openMandateIssue = async function openGovernedMandateIssue() {
  try {
    const [agentsResponse, policiesResponse] = await Promise.all([
      apiRequest("/agents?limit=100"),
      apiRequest("/policies?limit=100"),
    ]);
    const activeAgents = agentsResponse.items.filter((item) => item.status === "ACTIVE" && item.keyId);
    const activePolicies = policiesResponse.items.filter((item) => item.active);
    const warningParts = [
      "This creates a governance proposal, not a mandate. A distinct currently authorized administrator must approve it, then an authorized administrator must apply it. The signed mandate token is created only at apply and is still shown once.",
    ];
    if (agentsResponse.nextCursor || policiesResponse.nextCursor) {
      warningParts.push("Selection lists show the first 100 visible agents/policies; use the API when the desired resource is beyond this window.");
    }
    const idempotencyKey = crypto.randomUUID();
    openFormModal({
      title: "Propose mandate issuance",
      description: "Mino binds approval to the selected user, active agent identity/key, exact active policy snapshot, expiry, and absence of a prior mandate under this idempotency key.",
      submitLabel: "Create proposal",
      warning: warningParts.join(" "),
      fields: [
        { name: "userId", label: "Beneficiary user ID", required: true, full: true },
        { name: "agentId", label: "Active agent", type: "select", required: true, options: activeAgents.map((item) => ({ value: item.id, label: (item.displayName || item.externalAgentId) + " — " + shortId(item.id, 10) })) },
        { name: "policyId", label: "Active policy version", type: "select", required: true, options: activePolicies.map((item) => ({ value: item.id, label: item.name + " v" + item.version + " — " + formatMinor(item.maxBudgetMinor, item.baseCurrency) })) },
        { name: "expiresAt", label: "Mandate expires at", type: "datetime-local", required: true },
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
        if (response.outcome !== "PENDING_GOVERNANCE" && response.outcome !== "REPLAYED") {
          throw new Error("Mandate governance proposal returned an unexpected outcome.");
        }
        toast(response.outcome === "REPLAYED" ? "Mandate proposal replayed safely." : "Mandate issuance proposal created.", "success");
        void navigate("governance");
      },
    });
  } catch (error) {
    toast(apiErrorMessage(error), "error");
  }
};

async function loadGovernance(reset, version) {
  if (reset) state.pages.governance = { items: [], nextCursor: null };
  const page = state.pages.governance;
  const params = new URLSearchParams({ limit: "50" });
  if (state.filters.governance) params.set("status", state.filters.governance);
  if (!reset && page.nextCursor) params.set("cursor", page.nextCursor);
  const response = await apiRequest("/governance?" + params.toString());
  if (version !== state.renderVersion) return;
  page.items = reset ? response.items : page.items.concat(response.items);
  page.nextCursor = response.nextCursor || null;
  renderGovernance();
}

function renderGovernance() {
  const page = state.pages.governance;
  const root = element("div");
  root.appendChild(viewToolbar(
    "High-risk administrative changes",
    "Mandate issuance and policy activation use a separate durable governance domain. Transaction-level human payment approvals remain a different workflow.",
    [],
  ));
  root.appendChild(statusFilter(
    "Governance status",
    ["", "PENDING", "APPROVED", "REJECTED", "EXPIRED", "APPLIED", "STALE"],
    state.filters.governance,
    (value) => {
      state.filters.governance = value;
      void loadGovernance(true, state.renderVersion);
    },
  ));
  if (!page.items.length) {
    root.appendChild(emptyState(
      "No governance requests",
      state.filters.governance
        ? "No governance requests match this filter."
        : "High-risk proposals will appear here when policy activation or mandate issuance is requested.",
    ));
    viewRoot.replaceChildren(root);
    return;
  }
  root.appendChild(dataTable([
    ["Change", (item) => primaryCell(humanEnum(item.action), governanceTargetSummary(item))],
    ["State", (item) => governanceStatusChip(item.status)],
    ["Proposer", (item) => monoCell(shortId(item.proposerPrincipalId, 12))],
    ["Votes", (item) => String(item.approveCount) + " approve / " + String(item.rejectCount) + " reject"],
    ["Expires", (item) => formatDate(item.expiresAt)],
    ["", (item) => governanceActions(item)],
  ], page.items));
  appendLoadMore(root, page, () => loadGovernance(false, state.renderVersion));
  viewRoot.replaceChildren(root);
}

function governanceTargetSummary(item) {
  if (item.action === "POLICY_ACTIVATE") {
    const proposal = item.proposal || {};
    return (proposal.name || "Policy") + (proposal.version ? " v" + String(proposal.version) : "") + (proposal.policyId ? " · " + shortId(proposal.policyId, 10) : "");
  }
  const proposal = item.proposal || {};
  return "Agent " + shortId(proposal.agentId || "", 10) + " · policy " + shortId(proposal.policyId || "", 10);
}

function governanceStatusChip(status) {
  const normalized = String(status || "UNKNOWN");
  if (normalized === "APPLIED") return element("span", { className: "status-chip status-good", text: humanEnum(normalized) });
  if (normalized === "STALE" || normalized === "REJECTED" || normalized === "EXPIRED") {
    return element("span", { className: "status-chip status-bad", text: humanEnum(normalized) });
  }
  if (normalized === "PENDING" || normalized === "APPROVED") {
    return element("span", { className: "status-chip status-warn", text: humanEnum(normalized) });
  }
  return statusChip(normalized);
}

function governanceActions(item) {
  const wrap = element("div", { className: "cell-actions" });
  wrap.appendChild(rowButton("View", () => openResourceDetail("Governance request", "/governance/" + encodeURIComponent(item.id), "governanceRequest")));
  const isProposer = state.access && state.access.principalId === item.proposerPrincipalId;
  const canAct = hasPermission(item.requiredPermission);
  if (item.status === "PENDING" && canAct && !isProposer) {
    wrap.appendChild(rowButton("Approve", () => openGovernanceVote(item, "APPROVE")));
    wrap.appendChild(rowButton("Reject", () => openGovernanceVote(item, "REJECT")));
  }
  if (item.status === "APPROVED" && canAct) {
    wrap.appendChild(rowButton("Apply", () => applyGovernanceRequest(item)));
  }
  return wrap;
}

function openGovernanceVote(item, decision) {
  openFormModal({
    title: decision === "APPROVE" ? "Approve high-risk change" : "Reject high-risk change",
    description: "Your stable administrator principal is recorded as the distinct governance voter. The approval is bound to proposal digest " + shortId(item.proposalDigest, 18) + ".",
    submitLabel: decision === "APPROVE" ? "Approve proposal" : "Reject proposal",
    danger: decision === "REJECT",
    warning: decision === "APPROVE" ? "Approval alone does not mutate state. Apply performs a fresh permission and target-state revalidation." : undefined,
    fields: [
      { name: "comment", label: "Comment", type: "textarea", full: true, placeholder: "Optional governance context" },
    ],
    onSubmit: async (raw) => {
      const body = { decision };
      if (raw.comment.trim()) body.comment = raw.comment.trim();
      const response = await apiRequest("/governance/" + encodeURIComponent(item.id) + "/votes", { method: "POST", body });
      toast(response.outcome === "REPLAYED" ? "Governance vote replayed safely." : "Governance vote recorded.", "success");
      void navigate("governance");
    },
  });
}

async function applyGovernanceRequest(item) {
  const opened = openModalShell(
    "Apply approved change",
    "Mino will revalidate the proposer, distinct approver, applying administrator, exact proposal binding, and current target state before any mutation occurs.",
  );
  opened.body.appendChild(element("div", {
    className: "warning-box",
    text: item.action === "MANDATE_ISSUE"
      ? "If all checks still pass, a signed mandate token will be minted during this apply transaction and shown once."
      : "If all checks still pass, this exact policy version will become active atomically with signed governance evidence.",
  }));
  const cancel = element("button", { className: "button button-secondary", text: "Cancel", attrs: { type: "button" } });
  cancel.addEventListener("click", closeModal);
  const apply = element("button", { className: "button button-primary", text: "Apply change", attrs: { type: "button" } });
  apply.addEventListener("click", async () => {
    apply.disabled = true;
    try {
      const response = await apiRequest("/governance/" + encodeURIComponent(item.id) + "/apply", { method: "POST" });
      closeModal();
      if (response.mandateToken) {
        showOneTimeMandateToken(response.mandateToken, response.mandate);
      } else {
        toast("Governed policy activation applied.", "success");
        void navigate("governance");
      }
    } catch (error) {
      apply.disabled = false;
      toast(apiErrorMessage(error), "error");
    }
  });
  opened.actions.append(cancel, apply);
}
`;
