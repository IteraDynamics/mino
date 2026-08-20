export function majorCurrencyToMinor(value: string, currency: string): string {
  const exponents: Record<string, number> = {
    USD: 2,
    EUR: 2,
    GBP: 2,
    JPY: 0,
    BHD: 3,
    KWD: 3,
  };
  const exponent = exponents[currency];
  if (exponent === undefined) {
    throw new Error("Unsupported policy currency.");
  }

  const input = String(value ?? "").trim();
  if (!input) {
    throw new Error("Enter a monetary amount.");
  }
  if (!/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d+)?$/.test(input)) {
    throw new Error("Enter a non-negative amount using digits and an optional decimal fraction.");
  }

  const normalized = input.replace(/,/g, "");
  const [whole = "0", fraction = ""] = normalized.split(".");
  if (fraction.length > exponent) {
    throw new Error(
      exponent === 0
        ? `${currency} does not use fractional minor units.`
        : `${currency} supports at most ${exponent} decimal places.`,
    );
  }

  const scale = 10n ** BigInt(exponent);
  const paddedFraction = exponent === 0 ? "" : (fraction + "0".repeat(exponent)).slice(0, exponent);
  const minor = BigInt(whole) * scale + BigInt(paddedFraction || "0");
  return minor.toString();
}

export function minorCurrencyToMajor(value: string | bigint, currency: string): string {
  const exponents: Record<string, number> = {
    USD: 2,
    EUR: 2,
    GBP: 2,
    JPY: 0,
    BHD: 3,
    KWD: 3,
  };
  const exponent = exponents[currency];
  if (exponent === undefined) {
    throw new Error("Unsupported policy currency.");
  }

  const amount = BigInt(value);
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  if (exponent === 0) {
    return `${negative ? "-" : ""}${absolute.toString()}`;
  }
  const digits = absolute.toString().padStart(exponent + 1, "0");
  const whole = digits.slice(0, -exponent);
  const fraction = digits.slice(-exponent);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

export const ADMIN_GUIDED_SETUP_CONSOLE_JS = `
${majorCurrencyToMinor.toString()}
${minorCurrencyToMajor.toString()}

// PR #42 pilot setup augmentation. This is presentation/orchestration only: readiness is inferred
// from existing safe administrative reads, while all authority and mutation semantics remain backend-owned.
const baseGuidedRenderOverview = renderOverview;
renderOverview = async function renderGuidedFirstRunOverview(version) {
  const setupPromise = loadPilotSetupSnapshot();
  await baseGuidedRenderOverview(version);
  const snapshot = await setupPromise;
  if (version !== state.renderVersion || state.activeView !== "overview") return;
  const root = viewRoot.firstElementChild;
  if (!root) return;
  const setup = buildPilotSetup(snapshot);
  const toolbar = root.querySelector(".view-toolbar");
  if (toolbar) toolbar.after(setup);
  else root.prepend(setup);
};

async function pilotSetupRead(permission, suffix) {
  if (!hasPermission(permission)) {
    return { available: false, error: false, items: [], nextCursor: null };
  }
  try {
    const response = await apiRequest(suffix);
    return {
      available: true,
      error: false,
      items: response && Array.isArray(response.items) ? response.items : [],
      nextCursor: response && response.nextCursor ? response.nextCursor : null,
    };
  } catch {
    return { available: true, error: true, items: [], nextCursor: null };
  }
}

async function loadPilotSetupSnapshot() {
  const [beneficiaries, agents, policies, merchants, mandates, governance] = await Promise.all([
    pilotSetupRead("beneficiary.read", "/beneficiaries?limit=100"),
    pilotSetupRead("agent.read", "/agents?limit=100"),
    pilotSetupRead("policy.read", "/policies?limit=100"),
    pilotSetupRead("merchant.read", "/merchants?limit=100"),
    pilotSetupRead("mandate.read", "/mandates?limit=100"),
    pilotSetupRead("governance.read", "/governance?limit=100"),
  ]);

  const activeBeneficiary = beneficiaries.items.find((item) => item.status === "ACTIVE");
  const activeAgent = agents.items.find((item) => item.status === "ACTIVE" && item.keyId);
  const activePolicy = policies.items.find((item) => item.active === true);
  const activeMerchant = merchants.items.find((item) => item.active === true);
  const activeMandate = mandates.items.find((item) => item.status === "ACTIVE");
  const pendingMandateGovernance = governance.items.find(
    (item) => item.action === "MANDATE_ISSUE" && (item.status === "PENDING" || item.status === "APPROVED"),
  );

  return {
    beneficiaries,
    agents,
    policies,
    merchants,
    mandates,
    governance,
    activeBeneficiary,
    activeAgent,
    activePolicy,
    activeMerchant,
    activeMandate,
    pendingMandateGovernance,
  };
}

function buildPilotSetup(snapshot) {
  const steps = pilotSetupSteps(snapshot);
  const availableSteps = steps.filter((step) => step.available);
  const completed = availableSteps.filter((step) => step.ready).length;
  const nextStep = availableSteps.find((step) => !step.ready && !step.error);

  const section = element("section", { className: "pilot-setup" });
  const header = element("div", { className: "pilot-setup-header" });
  const copy = element("div");
  copy.appendChild(element("div", { className: "metric-label", text: "Design-partner onboarding" }));
  copy.appendChild(element("h3", { text: "Pilot setup" }));
  copy.appendChild(element("p", {
    text: "Work from beneficiary to agent to policy to execution route to governed mandate. This checklist is informational; backend state and permissions remain authoritative.",
  }));
  header.appendChild(copy);
  header.appendChild(element("div", {
    className: "pilot-setup-progress",
    text: availableSteps.length ? String(completed) + " / " + String(availableSteps.length) + " ready" : "No setup visibility",
  }));
  section.appendChild(header);

  const grid = element("div", { className: "pilot-setup-grid" });
  steps.forEach((step, index) => {
    const card = element("div", {
      className:
        "pilot-setup-step" +
        (step.ready ? " setup-complete" : "") +
        (nextStep === step ? " setup-next" : "") +
        (step.error ? " setup-error" : ""),
    });
    const top = element("div", { className: "pilot-setup-step-top" });
    top.appendChild(element("span", { className: "pilot-setup-index", text: String(index + 1) }));
    top.appendChild(element("strong", { text: step.title }));
    const stateLabel = !step.available
      ? "No access"
      : step.error
        ? "Unavailable"
        : step.ready
          ? "Ready"
          : nextStep === step
            ? "Next"
            : "Waiting";
    top.appendChild(element("span", {
      className: "pilot-setup-state " + (step.ready ? "ready" : nextStep === step ? "next" : ""),
      text: stateLabel,
    }));
    card.appendChild(top);
    card.appendChild(element("p", { text: step.detail }));

    if (step.available && !step.error && step.action) {
      const action = rowButton(step.actionLabel, step.action);
      if (nextStep === step) action.classList.add("pilot-setup-primary-action");
      card.appendChild(action);
    }
    grid.appendChild(card);
  });
  section.appendChild(grid);

  if (steps.some((step) => step.truncated)) {
    section.appendChild(element("p", {
      className: "pilot-setup-footnote",
      text: "Setup readiness inspects the first 100 visible records in each inventory. Use the full inventory/API if a relevant resource is beyond that window.",
    }));
  }
  return section;
}

function pilotSetupSteps(snapshot) {
  const governanceInFlight = snapshot.pendingMandateGovernance;
  return [
    {
      title: "Beneficiary",
      available: snapshot.beneficiaries.available,
      error: snapshot.beneficiaries.error,
      ready: Boolean(snapshot.activeBeneficiary),
      truncated: Boolean(snapshot.beneficiaries.nextCursor),
      detail: snapshot.activeBeneficiary
        ? snapshot.activeBeneficiary.email + " is active and eligible for mandate binding."
        : "Create the person or business user on whose behalf an agent may receive authority.",
      actionLabel: snapshot.activeBeneficiary ? "View beneficiaries" : "Create beneficiary",
      action: snapshot.activeBeneficiary
        ? () => void navigate("beneficiaries")
        : hasPermission("beneficiary.create")
          ? openBeneficiaryCreate
          : () => void navigate("beneficiaries"),
    },
    {
      title: "Agent identity",
      available: snapshot.agents.available,
      error: snapshot.agents.error,
      ready: Boolean(snapshot.activeAgent),
      truncated: Boolean(snapshot.agents.nextCursor),
      detail: snapshot.activeAgent
        ? (snapshot.activeAgent.displayName || snapshot.activeAgent.externalAgentId) + " has an active verification key."
        : "Enroll an Ed25519 machine identity before delegating economic authority.",
      actionLabel: snapshot.activeAgent ? "View agents" : "Enroll agent",
      action: snapshot.activeAgent
        ? () => void navigate("agents")
        : hasPermission("agent.create")
          ? openAgentCreate
          : () => void navigate("agents"),
    },
    {
      title: "Policy",
      available: snapshot.policies.available,
      error: snapshot.policies.error,
      ready: Boolean(snapshot.activePolicy),
      truncated: Boolean(snapshot.policies.nextCursor),
      detail: snapshot.activePolicy
        ? snapshot.activePolicy.name + " v" + String(snapshot.activePolicy.version) + " is active."
        : "Create a policy version, then complete four-eyes activation before mandate issuance.",
      actionLabel: snapshot.activePolicy ? "View policies" : "Open policies",
      action: snapshot.activePolicy
        ? () => void navigate("policies")
        : () => {
            if (!snapshot.policies.items.length && hasPermission("policy.create")) openPolicyCreate();
            else void navigate("policies");
          },
    },
    {
      title: "Execution route",
      available: snapshot.merchants.available,
      error: snapshot.merchants.error,
      ready: Boolean(snapshot.activeMerchant),
      truncated: Boolean(snapshot.merchants.nextCursor),
      detail: snapshot.activeMerchant
        ? snapshot.activeMerchant.domain + " is active in the current merchant routing boundary."
        : "Register and activate the current pilot merchant/counterparty route. Provider credentials remain server-side.",
      actionLabel: snapshot.activeMerchant ? "View routes" : "Open merchant routes",
      action: snapshot.activeMerchant
        ? () => void navigate("merchants")
        : () => {
            if (!snapshot.merchants.items.length && hasPermission("merchant.manage")) openMerchantCreate();
            else void navigate("merchants");
          },
    },
    {
      title: "Governed mandate",
      available: snapshot.mandates.available,
      error: snapshot.mandates.error || snapshot.governance.error,
      ready: Boolean(snapshot.activeMandate),
      truncated: Boolean(snapshot.mandates.nextCursor || snapshot.governance.nextCursor),
      detail: snapshot.activeMandate
        ? "An active mandate has been applied and can be presented by its bound agent."
        : governanceInFlight
          ? "Mandate issuance is already in the four-eyes governance queue (" + humanEnum(governanceInFlight.status) + ")."
          : "Propose mandate issuance after the beneficiary, keyed agent, active policy, and execution route are ready.",
      actionLabel: snapshot.activeMandate
        ? "View mandates"
        : governanceInFlight
          ? "Open governance"
          : "Propose mandate",
      action: snapshot.activeMandate
        ? () => void navigate("mandates")
        : governanceInFlight
          ? () => void navigate("governance")
          : hasPermission("mandate.issue")
            ? openMandateIssue
            : () => void navigate("mandates"),
    },
  ];
}

policyFields = function pilotMajorUnitPolicyFields(seed, includeName) {
  const fields = [];
  const currency = seed.baseCurrency || "USD";
  const hasPerTransaction = seed.maxBudgetMinor !== undefined && seed.maxBudgetMinor !== null;
  const hasDaily = seed.rollingDailyLimitMinor !== undefined && seed.rollingDailyLimitMinor !== null;
  if (includeName) {
    fields.push({ name: "name", label: "Policy name", required: true, value: seed.name || "", full: true });
  }
  fields.push(
    { name: "baseCurrency", label: "Base currency", type: "select", required: true, value: currency, options: ["USD", "EUR", "GBP", "JPY", "BHD", "KWD"] },
    { name: "approvalMode", label: "Approval mode", type: "select", required: true, value: seed.approvalMode || "AUTO_APPROVE", options: ["AUTO_APPROVE", "DUAL_SIGNATURE_SLACK", "HARD_BLOCK"] },
    {
      name: "maxBudgetMajor",
      label: "Per-transaction limit (major units)",
      required: true,
      value: hasPerTransaction ? minorCurrencyToMajor(seed.maxBudgetMinor, currency) : "",
      placeholder: currency === "JPY" ? "2500" : "2500.00",
    },
    {
      name: "rollingDailyLimitMajor",
      label: "Rolling daily limit (major units)",
      required: true,
      value: hasDaily ? minorCurrencyToMajor(seed.rollingDailyLimitMinor, currency) : "",
      placeholder: currency === "JPY" ? "5000" : "5000.00",
    },
    { name: "maxTransactionsPerMinute", label: "Max transactions / minute", type: "number", required: true, value: String(seed.maxTransactionsPerMinute ?? 0) },
    { name: "crossMerchantWindowSecs", label: "Cross-merchant window (seconds)", type: "number", required: true, value: String(seed.crossMerchantWindowSecs ?? 60) },
    { name: "maxDistinctMerchants", label: "Max distinct merchants", type: "number", required: true, value: String(seed.maxDistinctMerchants ?? 0) },
    { name: "approvedMerchantDomains", label: "Approved merchant domains", type: "textarea", full: true, value: (seed.approvedMerchantDomains || []).join("\n"), placeholder: "merchant.example\none-per-line.example" },
    { name: "approvedVendorIds", label: "Approved vendor IDs", type: "textarea", full: true, value: (seed.approvedVendorIds || []).join("\n") },
    { name: "restrictedCategories", label: "Restricted categories", type: "textarea", full: true, value: (seed.restrictedCategories || []).join("\n"), placeholder: "GAMBLING\nALCOHOL" },
  );
  return fields;
};

policyBody = function pilotMajorUnitPolicyBody(raw) {
  const currency = raw.baseCurrency;
  return {
    baseCurrency: currency,
    maxBudgetMinor: majorCurrencyToMinor(raw.maxBudgetMajor, currency),
    rollingDailyLimitMinor: majorCurrencyToMinor(raw.rollingDailyLimitMajor, currency),
    approvedMerchantDomains: parseList(raw.approvedMerchantDomains),
    approvedVendorIds: parseList(raw.approvedVendorIds),
    restrictedCategories: parseList(raw.restrictedCategories),
    approvalMode: raw.approvalMode,
    maxTransactionsPerMinute: Number(raw.maxTransactionsPerMinute),
    crossMerchantWindowSecs: Number(raw.crossMerchantWindowSecs),
    maxDistinctMerchants: Number(raw.maxDistinctMerchants),
  };
};

openPolicyCreate = function openPilotMajorUnitPolicyCreate() {
  openFormModal({
    title: "Create policy",
    description: "Create version 1 inactive. Enter monetary limits in the selected currency's major units; Mino converts them exactly to backend minor-unit strings without floating-point arithmetic.",
    submitLabel: "Create inactive policy",
    warning: "Changing the currency does not perform foreign-exchange conversion. Review both monetary values in the newly selected currency before submitting.",
    fields: policyFields({}, true),
    onSubmit: async (raw) => {
      const body = policyBody(raw);
      body.name = raw.name.trim();
      await apiRequest("/policies", { method: "POST", body });
      toast("Inactive policy created. Activate it through four-eyes governance before issuing a mandate.", "success");
      void navigate("policies");
    },
  });
};

openPolicyVersion = function openPilotMajorUnitPolicyVersion(item) {
  openFormModal({
    title: "Create policy version " + String(item.version + 1),
    description: "The existing version remains immutable. Monetary limits are shown and entered in major currency units, then converted exactly to minor-unit strings at submission.",
    submitLabel: "Create version",
    warning: "The new version is inactive and does not change existing mandates. If you change currency, Mino does not perform FX conversion; review both amount fields explicitly.",
    fields: policyFields(item, false),
    onSubmit: async (raw) => {
      const body = policyBody(raw);
      body.version = item.version + 1;
      await apiRequest("/policies/" + encodeURIComponent(item.id) + "/versions", { method: "POST", body });
      toast("New inactive policy version created.", "success");
      void navigate("policies");
    },
  });
};
`;
