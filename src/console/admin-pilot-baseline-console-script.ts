export const ADMIN_PILOT_BASELINE_CONSOLE_JS = String.raw`

// Pilot-facing presentation augmentation. This remains a display layer over the same
// authenticated /access response and backend authorization boundary; it grants no new authority.
function pilotAccessPresentation() {
  const access = state.access || {};
  const organization = access.organization && typeof access.organization === "object"
    ? access.organization
    : {};
  const principal = access.principal && typeof access.principal === "object"
    ? access.principal
    : {};
  const organizationName = typeof organization.name === "string" ? organization.name.trim() : "";
  const displayName = typeof principal.displayName === "string" ? principal.displayName.trim() : "";
  const email = typeof principal.email === "string" ? principal.email.trim() : "";
  return {
    organizationName,
    displayName,
    email,
    principalLabel: displayName || email || "Administrator",
  };
}

const basePilotRenderRoles = renderRoles;
renderRoles = function renderPilotRoles() {
  basePilotRenderRoles();
  if (!state.access) return;
  const presentation = pilotAccessPresentation();
  organizationDisplay.textContent = presentation.organizationName || shortId(state.organizationId, 13);
  organizationDisplay.dataset.fullValue = state.organizationId;
  organizationDisplay.title = presentation.organizationName
    ? presentation.organizationName + " — click to copy organization ID"
    : "Copy organization ID";

  let principalDisplay = document.getElementById("principal-display");
  if (!principalDisplay) {
    principalDisplay = document.createElement("span");
    principalDisplay.id = "principal-display";
    principalDisplay.className = "principal-chip";
    const actions = roleList.parentElement;
    if (actions) actions.insertBefore(principalDisplay, roleList);
  }
  principalDisplay.textContent = presentation.principalLabel;
  principalDisplay.title = presentation.email || "Current administrator";
};

const basePilotRenderOverview = renderOverview;
renderOverview = async function renderPilotOverview(version) {
  await basePilotRenderOverview(version);
  if (version !== state.renderVersion || !state.access) return;

  const presentation = pilotAccessPresentation();
  const technicalHeading = Array.from(viewRoot.querySelectorAll(".section-heading")).find((node) => {
    const heading = node.querySelector("h3");
    return heading && heading.textContent === "Current access";
  });
  if (!technicalHeading) return;

  const technicalTitle = technicalHeading.querySelector("h3");
  const technicalCopy = technicalHeading.querySelector("p");
  if (technicalTitle) technicalTitle.textContent = "Technical access";
  if (technicalCopy) technicalCopy.textContent = "Stable identifiers and effective backend authority remain available for support and audit work.";

  const humanHeading = sectionHeading(
    "Organization & administrator",
    "Human-readable pilot context comes from enrolled Mino records; JWT claims remain identity input, not display authority.",
  );
  const grid = element("div", { className: "grid pilot-identity-grid" });
  grid.appendChild(detailCard("Organization", [
    ["Name", presentation.organizationName || "Name unavailable"],
    ["Organization ID", state.access.organizationId],
  ], "card-wide"));
  grid.appendChild(detailCard("Administrator", [
    ["Name", presentation.displayName || "Not provided"],
    ["Email", presentation.email || "Not provided"],
    ["Principal ID", state.access.principalId],
  ], "card-wide"));

  technicalHeading.before(humanHeading, grid);
};

const basePilotDisconnect = disconnect;
disconnect = function disconnectPilotSession(showToast) {
  basePilotDisconnect(showToast);
  const principalDisplay = document.getElementById("principal-display");
  if (principalDisplay) principalDisplay.remove();
};

openAgentRotate = function openPilotAgentRotate(item) {
  openFormModal({
    title: "Rotate agent key",
    description: "The prior key ID stops resolving when this change commits. Only Ed25519 public keys are accepted.",
    submitLabel: "Rotate key",
    warning: "Agent key rotation remains a direct RBAC-authorized security action. The bounded four-eyes workflow applies to mandate issuance and policy activation, not every administrative mutation.",
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
};
`;