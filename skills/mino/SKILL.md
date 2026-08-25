---
name: mino
description: Pair this OpenClaw agent with Mino, activate owner-granted bounded economic authority, and route checkout completion through Mino without giving the agent owner or merchant credentials.
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
        description: Optional path for Mino's local agent key, mandate, and exact-retry state.
---

Use this skill for Mino Personal onboarding, authority activation, and Mino-governed economic completion.

Mino is the authorization boundary. Do not treat this skill, the model, or the local OpenClaw process as the authority source. A paired agent is not authorized to spend until Mino has an active owner-granted policy and the helper has successfully activated a mandate credential.

Run the bundled helper with fixed subcommands only:

```bash
node {baseDir}/scripts/mino-personal.mjs pair --external-agent-id openclaw-personal --display-name OpenClaw
node {baseDir}/scripts/mino-personal.mjs status
node {baseDir}/scripts/mino-personal.mjs activate
node {baseDir}/scripts/mino-personal.mjs state
node {baseDir}/scripts/mino-personal.mjs complete --merchant-id <merchant-id> --checkout-session-id <session-id> --body-file <json-file>
node {baseDir}/scripts/mino-personal.mjs retry-pending
```

On first setup, run `pair`. The helper generates and retains the Ed25519 private key locally, proves possession of that key to Mino, and returns a short-lived pairing request ID plus claim secret. Show the pairing request ID and claim secret to the user so they can claim the agent through their independently authenticated Mino owner surface. Never ask for or accept the owner's JWT, session cookie, password, or other owner credential.

After the user says they claimed the pairing, run `status`. If the result is not `CLAIMED`, report the status and do not pretend the agent is enrolled.

After the user has granted an authority profile in Mino, run `activate`. The helper proves possession of the paired key again, receives the bounded mandate credential directly from Mino, and stores it in the local state file. The helper does not print the mandate token. Never read, echo, summarize, paste, or expose the contents of the local state file, private key, or mandate token.

Use `state` only for a redacted readiness summary. `authorityCredentialPresent: true` means a mandate credential exists locally; it does not mean every possible action is allowed. Mino remains authoritative on every transaction and can still block, require owner approval, or reject a revoked/expired mandate.

## Economic completion

Mino Personal deliberately does not own shopping, cart construction, or checkout-session creation. Use the merchant/agent tooling to build the intended cart and obtain the merchant's checkout session ID. Do not complete the payment through that tooling if the action is supposed to be governed by Mino.

When the economic action is ready to complete, put the exact provider completion payload in a local JSON file and call `complete`. Treat that payload file as sensitive when it contains payment material. The helper signs the request with the paired Ed25519 key, sends the bounded mandate to Mino, and does not require the merchant's upstream Bearer credential; Mino resolves that credential server-side.

The helper may return:

- `COMPLETED`: Mino allowed and completed the action. Do not submit it again under a new idempotency key.
- `OWNER_APPROVAL_REQUIRED`: show the approval request ID to the user. Do not route around Mino and do not manufacture a new completion attempt. After the user confirms they approved or rejected it in Mino, run `retry-pending`.
- `PAYMENT_OUTCOME_PENDING`: the upstream outcome is ambiguous. Preserve the pending state and use `retry-pending` after the indicated delay. Never create a new idempotency key for the same semantic payment.
- `BLOCKED`: stop. Report the reason codes. Do not use another card, browser path, payment API, or tool to bypass the decision.

`retry-pending` always reuses the exact stored body and idempotency key while generating a fresh timestamp, nonce, and Ed25519 signature. Never edit the pending request between approval and retry.

The owner approval itself happens through the independently authenticated Mino Personal owner surface. The OpenClaw agent must never receive the owner's credential in order to request or consume an approval.

This skill does not authorize bypass paths. If an economic action would use a card, wallet, browser checkout, payment API, or provider path that is not actually routed through the Mino Personal completion adapter, do not describe that action as protected or governed by Mino. Do not route around Mino because another tool can complete the purchase directly.
