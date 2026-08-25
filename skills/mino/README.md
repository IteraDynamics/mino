# Mino OpenClaw skill

This directory is the native OpenClaw skill bundle for Mino Personal onboarding, bounded authority activation, and Mino-governed economic completion.

Local onboarding smoke test:

```bash
MINO_BASE_URL=http://127.0.0.1:3000 node skills/mino/scripts/mino-personal.mjs pair --external-agent-id openclaw-personal --display-name OpenClaw
MINO_BASE_URL=http://127.0.0.1:3000 node skills/mino/scripts/mino-personal.mjs status
MINO_BASE_URL=http://127.0.0.1:3000 node skills/mino/scripts/mino-personal.mjs activate
MINO_BASE_URL=http://127.0.0.1:3000 node skills/mino/scripts/mino-personal.mjs state
```

Once a merchant checkout session already exists, completion is routed through Mino:

```bash
MINO_BASE_URL=http://127.0.0.1:3000 node skills/mino/scripts/mino-personal.mjs complete \
  --merchant-id personal-sandbox \
  --checkout-session-id cs_123 \
  --body-file ./completion.json
```

If the helper returns `OWNER_APPROVAL_REQUIRED` or `PAYMENT_OUTCOME_PENDING`, preserve the exact pending operation and use:

```bash
MINO_BASE_URL=http://127.0.0.1:3000 node skills/mino/scripts/mino-personal.mjs retry-pending
```

`retry-pending` reuses the original body and idempotency key while generating a fresh agent proof. It is deliberately impossible to mutate the stored pending request through the helper.

`pair` is the only command that prints the short-lived human claim secret. The private key, mandate token, pending completion body, and any payment material remain only in the restrictive local state file and are never printed by the helper.

The owner must claim the pairing and grant authority through Mino's independently authenticated Personal surface before `activate` can succeed. Owner approvals are also resolved through that owner surface; the OpenClaw runtime never receives the owner's credential.

Mino Personal does not create carts or checkout sessions. It guards the economic completion step. The upstream merchant credential used to retrieve and complete the checkout is resolved by Mino server-side and is not supplied to the OpenClaw helper.
