export const ADMIN_GUIDED_SETUP_CONSOLE_CSS = String.raw`

.pilot-setup {
  margin: 0 0 28px;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--panel);
  padding: 18px;
}

.pilot-setup-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 14px;
}

.pilot-setup-header h3 {
  margin: 6px 0 4px;
}

.pilot-setup-header p {
  margin: 0;
  max-width: 760px;
  color: var(--ink-soft);
  font-size: 12px;
}

.pilot-setup-progress {
  flex: 0 0 auto;
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 6px 9px;
  color: var(--ink-soft);
  font-size: 11px;
  font-weight: 700;
}

.pilot-setup-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
}

.pilot-setup-step {
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  padding: 12px;
  background: var(--panel);
}

.pilot-setup-step.setup-complete {
  border-style: solid;
}

.pilot-setup-step.setup-next {
  box-shadow: inset 0 0 0 1px var(--ink);
}

.pilot-setup-step.setup-error {
  border-style: dashed;
}

.pilot-setup-step-top {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 8px;
}

.pilot-setup-index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 1px solid var(--line);
  border-radius: 50%;
  color: var(--ink-soft);
  font-size: 10px;
  font-weight: 750;
}

.pilot-setup-state {
  color: var(--ink-faint);
  font-size: 10px;
  font-weight: 750;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.pilot-setup-state.ready {
  color: var(--signal-dark);
}

.pilot-setup-state.next {
  color: var(--ink);
}

.pilot-setup-step p {
  min-height: 48px;
  margin: 10px 0 12px;
  color: var(--ink-soft);
  font-size: 11px;
  line-height: 1.45;
}

.pilot-setup-primary-action {
  border-color: var(--ink);
  color: var(--ink);
}

.pilot-setup-footnote {
  margin: 12px 0 0;
  color: var(--ink-faint);
  font-size: 10px;
}

@media (max-width: 1180px) {
  .pilot-setup-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 760px) {
  .pilot-setup-header { display: grid; }
  .pilot-setup-progress { justify-self: start; }
  .pilot-setup-grid { grid-template-columns: 1fr; }
  .pilot-setup-step p { min-height: 0; }
}
`;
