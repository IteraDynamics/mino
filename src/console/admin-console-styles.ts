export const ADMIN_CONSOLE_CSS = String.raw`:root {
  color-scheme: light;
  --ink: #171816;
  --ink-soft: #555850;
  --ink-faint: #7b7f76;
  --paper: #f3f0e8;
  --panel: #fbf9f4;
  --panel-strong: #ffffff;
  --line: #d8d4ca;
  --line-strong: #bbb8ae;
  --signal: #55776a;
  --signal-dark: #365b4f;
  --signal-wash: #e4ebe6;
  --amber: #9b6d1e;
  --amber-wash: #f4ead5;
  --red: #9b433f;
  --red-wash: #f4e4e1;
  --shadow: 0 20px 60px rgba(35, 33, 28, 0.08);
  --radius-sm: 8px;
  --radius-md: 14px;
  --radius-lg: 22px;
  --sidebar: 248px;
  font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-synthesis: none;
}

* { box-sizing: border-box; }

html, body { min-height: 100%; }

body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-size: 14px;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
}

button, input, textarea, select { font: inherit; }
button { color: inherit; }

[hidden] { display: none !important; }

.connect-screen {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 40px 20px;
  background:
    linear-gradient(rgba(23, 24, 22, 0.035) 1px, transparent 1px),
    linear-gradient(90deg, rgba(23, 24, 22, 0.035) 1px, transparent 1px),
    var(--paper);
  background-size: 36px 36px;
}

.connect-card {
  width: min(520px, 100%);
  padding: 42px;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: rgba(251, 249, 244, 0.96);
  box-shadow: var(--shadow);
}

.brand-lockup {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

.brand-lockup-large { margin-bottom: 38px; }

.brand-word {
  font-size: 23px;
  font-weight: 650;
  letter-spacing: -0.045em;
}

.brand-lockup-large .brand-word { font-size: 30px; }

.brand-mark {
  position: relative;
  display: inline-grid;
  grid-template-columns: 1fr 1fr;
  width: 28px;
  height: 24px;
  gap: 5px;
}

.brand-lockup-large .brand-mark { width: 34px; height: 29px; gap: 6px; }

.brand-mark span {
  position: relative;
  display: block;
  border: 3px solid var(--ink);
  border-top-width: 4px;
  border-bottom-width: 4px;
}

.brand-mark span:first-child {
  border-right: 0;
  clip-path: polygon(0 0, 100% 0, 72% 50%, 100% 100%, 0 100%);
}

.brand-mark span:last-child {
  border-left: 0;
  clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%, 28% 50%);
}

.eyebrow {
  margin: 0 0 8px;
  color: var(--ink-faint);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

h1, h2, h3, p { margin-top: 0; }

h1 {
  margin-bottom: 12px;
  font-size: clamp(30px, 5vw, 42px);
  line-height: 1.05;
  letter-spacing: -0.045em;
  font-weight: 650;
}

h2 {
  margin-bottom: 0;
  font-size: 27px;
  line-height: 1.1;
  letter-spacing: -0.035em;
  font-weight: 650;
}

h3 {
  margin-bottom: 7px;
  font-size: 17px;
  letter-spacing: -0.02em;
}

.lede {
  color: var(--ink-soft);
  font-size: 15px;
  max-width: 44ch;
  margin-bottom: 28px;
}

.field {
  display: grid;
  gap: 7px;
  margin-bottom: 16px;
}

.field > span,
.field-label {
  color: var(--ink-soft);
  font-size: 12px;
  font-weight: 650;
}

input, textarea, select {
  width: 100%;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  background: var(--panel-strong);
  color: var(--ink);
  outline: none;
  padding: 11px 12px;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}

textarea {
  min-height: 110px;
  resize: vertical;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
}

input:focus, textarea:focus, select:focus {
  border-color: var(--signal);
  box-shadow: 0 0 0 3px rgba(85, 119, 106, 0.14);
}

input::placeholder, textarea::placeholder { color: #a6a49c; }

.button {
  appearance: none;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  padding: 9px 13px;
  cursor: pointer;
  font-weight: 650;
  transition: transform 100ms ease, background 100ms ease, border-color 100ms ease, opacity 100ms ease;
}

.button:hover:not(:disabled) { transform: translateY(-1px); }
.button:active:not(:disabled) { transform: translateY(0); }
.button:disabled { cursor: not-allowed; opacity: 0.42; }

.button-primary {
  background: var(--ink);
  color: #fff;
}

.button-secondary {
  border-color: var(--line-strong);
  background: var(--panel-strong);
}

.button-signal {
  background: var(--signal-dark);
  color: #fff;
}

.button-danger {
  border-color: #d6aaa6;
  background: var(--red-wash);
  color: #77322f;
}

.button-quiet {
  border-color: var(--line);
  background: transparent;
  color: var(--ink-soft);
}

.button-small { padding: 6px 9px; font-size: 12px; }
.button-full { width: 100%; }

.form-error {
  margin: 0 0 14px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--red-wash);
  color: #7a3531;
}

.security-note {
  display: grid;
  gap: 3px;
  margin-top: 24px;
  padding-top: 20px;
  border-top: 1px solid var(--line);
  color: var(--ink-soft);
  font-size: 12px;
}

.security-note strong { color: var(--ink); }

.app-shell {
  min-height: 100vh;
  display: grid;
  grid-template-columns: var(--sidebar) minmax(0, 1fr);
}

.sidebar {
  position: sticky;
  top: 0;
  height: 100vh;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--line);
  background: #ece8de;
  padding: 26px 18px 18px;
}

.sidebar-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0 8px 28px;
}

.environment-chip {
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  padding: 3px 6px;
  color: var(--ink-faint);
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.nav {
  display: grid;
  gap: 4px;
}

.nav-button {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  padding: 10px 11px;
  color: var(--ink-soft);
  cursor: pointer;
  text-align: left;
  font-weight: 580;
}

.nav-button:hover { background: rgba(255,255,255,0.42); color: var(--ink); }
.nav-button.active { background: var(--panel); color: var(--ink); box-shadow: 0 1px 0 rgba(255,255,255,0.5) inset; }

.nav-icon {
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  color: var(--ink-faint);
  font-size: 14px;
}

.sidebar-bottom {
  margin-top: auto;
  padding-top: 18px;
  border-top: 1px solid var(--line);
}

.identity-block {
  display: grid;
  gap: 3px;
  margin-bottom: 12px;
  padding: 0 5px;
}

.identity-label {
  color: var(--ink-faint);
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.09em;
}

.identity-value {
  appearance: none;
  border: 0;
  background: transparent;
  padding: 0;
  color: var(--ink-soft);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.main-shell { min-width: 0; }

.topbar {
  min-height: 104px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 24px 34px 20px;
  border-bottom: 1px solid var(--line);
  background: rgba(243, 240, 232, 0.92);
}

.topbar-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.role-list {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 5px;
}

.role-chip, .status-chip, .tag {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  white-space: nowrap;
}

.role-chip {
  padding: 4px 7px;
  border: 1px solid var(--line);
  color: var(--ink-soft);
  font-size: 10px;
  font-weight: 650;
}

.icon-button {
  width: 36px;
  height: 36px;
  border: 1px solid var(--line);
  border-radius: 50%;
  background: var(--panel);
  cursor: pointer;
  font-size: 18px;
}

.governance-banner {
  margin: 22px 34px 0;
  border: 1px solid #d8c7a3;
  border-radius: var(--radius-md);
  background: var(--amber-wash);
  color: #76551d;
  padding: 12px 14px;
}

.governance-banner div { display: grid; gap: 2px; }
.governance-banner strong { color: #5f4317; font-size: 12px; }
.governance-banner span { font-size: 12px; }

.view { padding: 26px 34px 48px; }

.view-toolbar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 20px;
}

.view-toolbar-copy { max-width: 720px; }
.view-toolbar-copy p { margin: 4px 0 0; color: var(--ink-soft); }
.view-toolbar-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }

.grid {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  gap: 14px;
}

.card {
  grid-column: span 4;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--panel);
  padding: 18px;
}

.card-wide { grid-column: span 6; }
.card-full { grid-column: 1 / -1; }

.metric-label {
  color: var(--ink-faint);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}

.metric-value {
  margin-top: 9px;
  font-size: 31px;
  line-height: 1;
  font-weight: 640;
  letter-spacing: -0.045em;
}

.metric-detail { margin-top: 8px; color: var(--ink-soft); font-size: 12px; }

.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin: 28px 0 10px;
}

.section-heading:first-child { margin-top: 0; }
.section-heading h3 { margin: 0; }
.section-heading p { margin: 2px 0 0; color: var(--ink-soft); font-size: 12px; }

.table-wrap {
  width: 100%;
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--panel);
}

table {
  width: 100%;
  border-collapse: collapse;
  min-width: 760px;
}

th, td {
  padding: 12px 13px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  vertical-align: middle;
}

th {
  color: var(--ink-faint);
  background: rgba(239, 236, 228, 0.65);
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

td { font-size: 12px; }
tr:last-child td { border-bottom: 0; }
tr:hover td { background: rgba(255,255,255,0.35); }

.cell-primary { font-weight: 620; }
.cell-secondary { display: block; margin-top: 2px; color: var(--ink-faint); font-size: 10px; }
.cell-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace; font-size: 10.5px; }
.cell-actions { display: flex; flex-wrap: wrap; gap: 5px; justify-content: flex-end; }

.status-chip {
  padding: 4px 7px;
  font-size: 10px;
  font-weight: 750;
  letter-spacing: 0.03em;
  background: #ecebe6;
  color: #565852;
}

.status-good { background: var(--signal-wash); color: #35584c; }
.status-warn { background: var(--amber-wash); color: #78551d; }
.status-bad { background: var(--red-wash); color: #7c3733; }

.tag {
  padding: 3px 6px;
  border: 1px solid var(--line);
  color: var(--ink-soft);
  font-size: 10px;
}

.tags { display: flex; flex-wrap: wrap; gap: 4px; }

.empty-state, .error-state, .loading-state {
  min-height: 210px;
  display: grid;
  place-items: center;
  text-align: center;
  border: 1px dashed var(--line-strong);
  border-radius: var(--radius-md);
  color: var(--ink-soft);
  padding: 28px;
}

.empty-state strong, .error-state strong { display: block; color: var(--ink); margin-bottom: 5px; }
.error-state { border-color: #d9aaa6; background: rgba(244,228,225,0.5); }

.loading-dot {
  width: 24px;
  height: 24px;
  border: 2px solid var(--line-strong);
  border-top-color: var(--ink);
  border-radius: 50%;
  animation: spin 700ms linear infinite;
}

@keyframes spin { to { transform: rotate(360deg); } }

.filter-bar {
  display: flex;
  gap: 8px;
  align-items: end;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.filter-bar .field { margin: 0; min-width: 160px; }
.filter-bar input, .filter-bar select { padding: 8px 9px; }

.load-more { display: flex; justify-content: center; padding-top: 14px; }

.audit-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}

.audit-card {
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--panel);
  padding: 16px;
}

.audit-card-top { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
.audit-card p { color: var(--ink-soft); font-size: 12px; }
.audit-result { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); }

.key-value {
  display: grid;
  grid-template-columns: minmax(130px, 0.5fr) 1fr;
  gap: 8px 16px;
  align-items: start;
}

.key-value dt { color: var(--ink-faint); font-size: 11px; }
.key-value dd { margin: 0; min-width: 0; overflow-wrap: anywhere; font-size: 12px; }

.modal {
  width: min(620px, calc(100vw - 28px));
  max-height: min(84vh, 820px);
  overflow: auto;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-lg);
  background: var(--panel);
  color: var(--ink);
  padding: 0;
  box-shadow: 0 35px 100px rgba(26, 25, 22, 0.23);
}

.modal::backdrop { background: rgba(31, 30, 27, 0.4); backdrop-filter: blur(3px); }

.modal-inner { padding: 24px; }
.modal-header { display: flex; justify-content: space-between; gap: 18px; margin-bottom: 18px; }
.modal-header p { margin: 4px 0 0; color: var(--ink-soft); font-size: 12px; }
.modal-close {
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  border: 1px solid var(--line);
  border-radius: 50%;
  background: transparent;
  cursor: pointer;
}

.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
.modal-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.modal-grid .field { margin: 0; }
.modal-grid .field-full { grid-column: 1 / -1; }

.one-time-token {
  margin: 14px 0;
  padding: 12px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  background: #f0ede5;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
  font-size: 11px;
  line-height: 1.55;
  word-break: break-all;
  user-select: all;
}

.warning-box {
  margin: 12px 0;
  padding: 11px 12px;
  border-radius: var(--radius-sm);
  background: var(--amber-wash);
  color: #76551d;
  font-size: 12px;
}

.danger-box {
  margin: 12px 0;
  padding: 11px 12px;
  border-radius: var(--radius-sm);
  background: var(--red-wash);
  color: #77322f;
  font-size: 12px;
}

.toast-region {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 100;
  display: grid;
  gap: 8px;
  width: min(360px, calc(100vw - 40px));
}

.toast {
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: var(--panel-strong);
  box-shadow: 0 10px 36px rgba(25,25,22,0.13);
  padding: 11px 13px;
  font-size: 12px;
}

.toast-success { border-color: #9db9ac; }
.toast-error { border-color: #d4a39f; }

@media (max-width: 980px) {
  :root { --sidebar: 208px; }
  .card { grid-column: span 6; }
  .audit-grid { grid-template-columns: 1fr; }
  .role-list { display: none; }
}

@media (max-width: 760px) {
  .app-shell { display: block; }
  .sidebar {
    position: static;
    width: 100%;
    height: auto;
    padding: 15px;
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
  .sidebar-top { margin: 0 0 12px; }
  .nav { display: flex; overflow-x: auto; padding-bottom: 4px; }
  .nav-button { width: auto; flex: 0 0 auto; }
  .nav-icon { display: none; }
  .sidebar-bottom { display: none; }
  .topbar { min-height: 86px; padding: 18px 20px 16px; }
  .governance-banner { margin: 14px 20px 0; }
  .view { padding: 20px 20px 40px; }
  .card, .card-wide { grid-column: 1 / -1; }
  .view-toolbar { display: block; }
  .view-toolbar-actions { justify-content: flex-start; margin-top: 12px; }
}

@media (max-width: 540px) {
  .connect-card { padding: 28px 22px; }
  .connect-screen { padding: 18px 12px; }
  .modal-grid { grid-template-columns: 1fr; }
  .modal-grid .field-full { grid-column: auto; }
  .topbar-actions { gap: 4px; }
  .governance-banner span { display: block; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}
`;
