---
name: mino
description: Pair this OpenClaw agent with Mino and activate owner-granted bounded economic authority without giving the agent owner credentials.
user-invocable: true
metadata:
  openclaw:
    requires:
      env:
        - MINO_BASE_URL
      bins:
        - node
    envVars:
      - name: MINO_BASE_URL
        required: true
        description: HTTPS base URL for the user's Mino service; loopback HTTP is allowed for local development.
      - name: MINO_STATE_FILE
        required: false
        description: Optional path for Mino's local agent key and mandate state.
---

Use this skill only for the Mino Personal onboarding and authority bootstrap flow.

Mino is the authorization boundary. Do not treat this skill, the model, or the local OpenClaw process as the authority source. A paired agent is not authorized to spend until Mino has an active owner-granted policy and the helper has successfully activated a mandate credential.

Run the bundled helper with fixed subcommands only:

```bash
node {baseDir}/scripts/mino-personal.mjs pair --external-agent-id openclaw-personal --display-name OpenClaw
node {baseDir}/scripts/mino-personal.mjs status
node {baseDir}/scripts/mino-personal.mjs activate
node {baseDir}/scripts/mino-personal.mjs state
```

On first setup, run `pair`. The helper generates and retains the Ed25519 private key locally, proves possession of that key to Mino, and returns a short-lived pairing request ID plus claim secret. Show the pairing request ID and claim secret to the user so they can claim the agent through their independently authenticated Mino owner surface. Never ask for or accept the owner's JWT, session cookie, password, or other owner credential.

After the user says they claimed the pairing, run `status`. If the result is not `CLAIMED`, report the status and do not pretend the agent is enrolled.

After the user has granted an authority profile in Mino, run `activate`. The helper proves possession of the paired key again, receives the bounded mandate credential directly from Mino, and stores it in the local state file. The helper does not print the mandate token. Never read, echo, summarize, paste, or expose the contents of the local state file, private key, or mandate token.

Use `state` only for a redacted readiness summary. `authorityCredentialPresent: true` means a mandate credential exists locally; it does not mean every possible action is allowed. Mino remains authoritative on every transaction and can still block, require owner approval, or reject a revoked/expired mandate.

This skill does not authorize bypass paths. If an economic action would use a card, wallet, browser checkout, payment API, or provider path that is not actually routed through a Mino-aware execution adapter, do not describe that action as protected or governed by Mino. Do not route around Mino because another tool can complete the purchase directly.
