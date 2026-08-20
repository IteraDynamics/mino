export const ADMIN_BENEFICIARY_CONSOLE_JS = String.raw`

// Pilot beneficiary administration augmentation. Spending beneficiaries remain distinct from
// administrative principals; the browser consumes only the governed beneficiary APIs.
viewDefinitions.splice(1, 0, {
  key: "beneficiaries",
  label: "Beneficiaries",
  eyebrow: "Delegated subject",
  permission: "beneficiary.read",
  icon: "B",
});

const baseBeneficiaryNavigate = navigate;
navigate = async function beneficiaryAwareNavigate(key) {
  if (key !== "beneficiaries") return baseBeneficiaryNavigate(key);
  if (!hasPermission("beneficiary.read")) {
    toast("Beneficiary visibility is not available to this administrator.", "error");
    return;
  }
  const definition = viewDefinitions.find((item) => item.key === key);
  state.activeView = key;
  const version = ++state.renderVersion;
  viewEyebrow.textContent = definition ? definition.eyebrow : "Delegated subject";
  viewTitle.textContent = definition ? definition.label : "Beneficiaries";
  for (const button of primaryNav.querySelectorAll(".nav-button")) {
    button.classList.toggle("active", button.dataset.view === key);
  }
  renderLoading();
  try {
    await loadBeneficiaries(true, version);
  } catch (error) {
    if (version !== state.renderVersion) return;
    renderViewError(error);
  }
};

async function loadBeneficiaries(reset, version) {
  if (reset) state.pages.beneficiaries = { items: [], nextCursor: null };
  const page = state.pages.beneficiaries;
  const suffix = "/beneficiaries?limit=50" +
    (!reset && page.nextCursor ? "&cursor=" + encodeURIComponent(page.nextCursor) : "");
  const response = await apiRequest(suffix);
  if (version !== state.renderVersion) return;
  page.items = reset ? response.items : page.items.concat(response.items);
  page.nextCursor = response.nextCursor || null;
  renderBeneficiaries();
}

function renderBeneficiaries() {
  const page = state.pages.beneficiaries;
  const actions = [];
  if (hasPermission("beneficiary.create")) {
    actions.push(actionButton("Create beneficiary", "primary", openBeneficiaryCreate));
  }
  const root = element("div");
  root.appendChild(viewToolbar(
    "Spending beneficiaries",
    "Beneficiaries are the people or business users on whose behalf an agent may receive delegated authority. They are not Mino administrators.",
    actions,
  ));
  if (!page.items.length) {
    root.appendChild(emptyState(
      "No beneficiaries",
      hasPermission("beneficiary.create")
        ? "Create the first beneficiary before proposing a mandate."
        : "No spending beneficiaries are visible in this organization.",
    ));
    viewRoot.replaceChildren(root);
    return;
  }
  root.appendChild(dataTable([
    ["Beneficiary", (item) => primaryCell(item.email, shortId(item.id, 12))],
    ["Status", (item) => statusChip(item.status)],
    ["Created", (item) => formatDate(item.createdAt)],
    ["Updated", (item) => formatDate(item.updatedAt)],
    ["", (item) => beneficiaryActions(item)],
  ], page.items));
  appendLoadMore(root, page, () => loadBeneficiaries(false, state.renderVersion));
  viewRoot.replaceChildren(root);
}

function beneficiaryActions(item) {
  const wrap = element("div", { className: "cell-actions" });
  wrap.appendChild(rowButton(
    "View",
    () => openResourceDetail("Beneficiary", "/beneficiaries/" + encodeURIComponent(item.id), "beneficiary"),
  ));
  if (item.status === "ACTIVE" && hasPermission("beneficiary.suspend")) {
    wrap.appendChild(rowButton("Suspend", () => confirmMutation({
      title: "Suspend beneficiary",
      description: "All existing mandates bound to this beneficiary stop resolving for new agent requests as soon as the suspension commits.",
      confirmLabel: "Suspend beneficiary",
      danger: true,
      warning: "This pilot slice intentionally provides no reactivation endpoint. Restoring a suspended beneficiary could revive still-valid mandates and requires a separately designed authority-restoration path.",
      request: () => apiRequest(
        "/beneficiaries/" + encodeURIComponent(item.id) + "/suspend",
        { method: "POST" },
      ),
      success: "Beneficiary suspended. Bound mandates now fail closed for new requests.",
    })));
  }
  return wrap;
}

function openBeneficiaryCreate() {
  openFormModal({
    title: "Create beneficiary",
    description: "Creates an active spending beneficiary in this organization. This does not enroll an administrator, create an agent, or grant spending authority by itself.",
    submitLabel: "Create beneficiary",
    fields: [
      { name: "email", label: "Beneficiary email", type: "email", required: true, full: true },
    ],
    onSubmit: async (raw) => {
      const response = await apiRequest("/beneficiaries", {
        method: "POST",
        body: { email: raw.email.trim() },
      });
      toast(
        response.outcome === "REPLAYED" ? "Existing active beneficiary reused safely." : "Beneficiary created.",
        "success",
      );
      void navigate("beneficiaries");
    },
  });
}

openMandateIssue = async function openPilotBeneficiaryMandateIssue() {
  try {
    const [beneficiariesResponse, agentsResponse, policiesResponse] = await Promise.all([
      apiRequest("/beneficiaries?limit=100"),
      apiRequest("/agents?limit=100"),
      apiRequest("/policies?limit=100"),
    ]);
    const activeBeneficiaries = beneficiariesResponse.items.filter((item) => item.status === "ACTIVE");
    const activeAgents = agentsResponse.items.filter((item) => item.status === "ACTIVE" && item.keyId);
    const activePolicies = policiesResponse.items.filter((item) => item.active);
    if (!activeBeneficiaries.length) {
      toast("Create an active beneficiary before proposing a mandate.", "error");
      void navigate("beneficiaries");
      return;
    }
    const warningParts = [
      "This creates a governance proposal, not a mandate. A distinct currently authorized administrator must approve it, then an authorized administrator must apply it. The signed mandate token is created only at apply and is still shown once.",
    ];
    if (beneficiariesResponse.nextCursor || agentsResponse.nextCursor || policiesResponse.nextCursor) {
      warningParts.push("Selection lists show the first 100 visible records; use the API when the desired resource is beyond this window.");
    }
    const idempotencyKey = crypto.randomUUID();
    openFormModal({
      title: "Propose mandate issuance",
      description: "Mino binds approval to the selected beneficiary, active agent identity/key, exact active policy snapshot, expiry, and absence of a prior mandate under this idempotency key.",
      submitLabel: "Create proposal",
      warning: warningParts.join(" "),
      fields: [
        {
          name: "userId",
          label: "Beneficiary",
          type: "select",
          required: true,
          options: activeBeneficiaries.map((item) => ({
            value: item.id,
            label: item.email + " — " + shortId(item.id, 10),
          })),
        },
        {
          name: "agentId",
          label: "Active agent",
          type: "select",
          required: true,
          options: activeAgents.map((item) => ({
            value: item.id,
            label: (item.displayName || item.externalAgentId) + " — " + shortId(item.id, 10),
          })),
        },
        {
          name: "policyId",
          label: "Active policy version",
          type: "select",
          required: true,
          options: activePolicies.map((item) => ({
            value: item.id,
            label: item.name + " v" + item.version + " — " + formatMinor(item.maxBudgetMinor, item.baseCurrency),
          })),
        },
        { name: "expiresAt", label: "Mandate expires at", type: "datetime-local", required: true },
      ],
      onSubmit: async (raw) => {
        if (!raw.userId || !raw.agentId || !raw.policyId) {
          throw new Error("An active beneficiary, agent, and policy version are required.");
        }
        const parsedExpiry = new Date(raw.expiresAt);
        if (Number.isNaN(parsedExpiry.getTime())) throw new Error("Enter a valid expiration date and time.");
        const response = await apiRequest("/mandates", {
          method: "POST",
          idempotencyKey,
          body: {
            userId: raw.userId,
            agentId: raw.agentId,
            policyId: raw.policyId,
            expiresAt: parsedExpiry.toISOString(),
          },
        });
        if (response.outcome !== "PENDING_GOVERNANCE" && response.outcome !== "REPLAYED") {
          throw new Error("Mandate governance proposal returned an unexpected outcome.");
        }
        toast(
          response.outcome === "REPLAYED" ? "Mandate proposal replayed safely." : "Mandate issuance proposal created.",
          "success",
        );
        void navigate("governance");
      },
    });
  } catch (error) {
    toast(apiErrorMessage(error), "error");
  }
};
`;
