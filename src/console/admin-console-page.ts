export const ADMIN_CONSOLE_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>Mino — Control Plane</title>
  <link rel="stylesheet" href="/console/styles.css">
</head>
<body>
  <div class="connect-screen" id="connect-screen">
    <section class="connect-card" aria-labelledby="connect-title">
      <div class="brand-lockup brand-lockup-large">
        <span class="brand-mark" aria-hidden="true"><span></span><span></span></span>
        <span class="brand-word">mino</span>
      </div>
      <p class="eyebrow">Administrative control plane</p>
      <h1 id="connect-title">Connect to an organization</h1>
      <p class="lede">Use an existing Mino administrator token. The token stays only in this tab's memory and is cleared on disconnect or reload.</p>
      <form id="connect-form" autocomplete="off">
        <label class="field">
          <span>Organization ID</span>
          <input id="organization-id" name="organizationId" type="text" inputmode="text" autocomplete="off" spellcheck="false" placeholder="00000000-0000-0000-0000-000000000000" required>
        </label>
        <label class="field">
          <span>Administrator bearer token</span>
          <input id="admin-token" name="adminToken" type="password" autocomplete="off" spellcheck="false" placeholder="Paste signed JWT" required>
        </label>
        <p class="form-error" id="connect-error" role="alert" hidden></p>
        <button class="button button-primary button-full" type="submit">Connect</button>
      </form>
      <div class="security-note">
        <strong>Browser boundary</strong>
        <span>No local storage, session storage, cookies, analytics, third-party scripts, or external assets.</span>
      </div>
    </section>
  </div>

  <div class="app-shell" id="app-shell" hidden>
    <aside class="sidebar">
      <div class="sidebar-top">
        <div class="brand-lockup">
          <span class="brand-mark" aria-hidden="true"><span></span><span></span></span>
          <span class="brand-word">mino</span>
        </div>
        <span class="environment-chip">control plane</span>
      </div>
      <nav class="nav" id="primary-nav" aria-label="Console navigation"></nav>
      <div class="sidebar-bottom">
        <div class="identity-block">
          <span class="identity-label">Organization</span>
          <button class="identity-value copyable" id="organization-display" type="button" title="Copy organization ID"></button>
        </div>
        <button class="button button-quiet button-full" id="disconnect-button" type="button">Disconnect</button>
      </div>
    </aside>

    <main class="main-shell">
      <header class="topbar">
        <div>
          <p class="eyebrow" id="view-eyebrow">Control plane</p>
          <h2 id="view-title">Overview</h2>
        </div>
        <div class="topbar-actions">
          <div class="role-list" id="role-list" aria-label="Current roles"></div>
          <button class="icon-button" id="refresh-button" type="button" title="Refresh current view" aria-label="Refresh current view">↻</button>
        </div>
      </header>

      <div class="governance-banner" id="governance-banner">
        <div>
          <strong>Four-eyes governance active</strong>
          <span>Mandate issuance and policy activation require a durable proposal, approval by a distinct authorized administrator, and explicit revalidated apply. Authority-removing and other administrative actions remain direct RBAC where designed.</span>
        </div>
      </div>

      <section class="view" id="view" aria-live="polite"></section>
    </main>
  </div>

  <div class="toast-region" id="toast-region" aria-live="polite" aria-atomic="true"></div>
  <dialog class="modal" id="modal"></dialog>
  <script type="module" src="/console/app.js"></script>
</body>
</html>`;
