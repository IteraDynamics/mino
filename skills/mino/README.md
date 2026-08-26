# Mino OpenClaw skill

This directory is the native OpenClaw skill bundle for Mino Personal onboarding, bounded authority activation, and Mino-governed economic execution.

Local onboarding smoke test:

```bash
MINO_BASE_URL=http://127.0.0.1:3000 node skills/mino/scripts/mino-personal.mjs pair --external-agent-id openclaw-personal --display-name OpenClaw
MINO_BASE_URL=http://127.0.0.1:3000 node skills/mino/scripts/mino-personal.mjs status
MINO_BASE_URL=http://127.0.0.1:3000 node skills/mino/scripts/mino-personal.mjs activate
MINO_BASE_URL=http://127.0.0.1:3000 node skills/mino/scripts/mino-personal.mjs state
```

## ACP checkout completion

Once a merchant checkout session already exists, completion can be routed through Mino:

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

## Known Stripe PaymentIntent execution

The User #1 Stripe path is deliberately narrower than shopping or checkout automation. The agent must already possess a known Stripe PaymentIntent ID from some independent capability or test setup. Mino does not browse, select products, create the PaymentIntent, attach its payment method, or choose its destination.

When a server-configured Personal Stripe target exists, request confirmation through Mino with:

```bash
MINO_BASE_URL=http://127.0.0.1:3000 node skills/mino/scripts/mino-stripe.mjs confirm \
  --payment-intent-id pi_123
```

If Mino requires owner approval, observes an ambiguous provider outcome, or has completed the economic action but has not yet issued its signed proof, retry the exact stored operation with:

```bash
MINO_BASE_URL=http://127.0.0.1:3000 node skills/mino/scripts/mino-stripe.mjs retry
```

The Stripe helper sends only the PaymentIntent reference, an empty JSON body, the Mino mandate, and a fresh signed agent proof. It never receives a Stripe secret key, PaymentIntent client secret, payment-method ID, amount, destination account, or connected-account credential. The same PaymentIntent ID and idempotency key are reused on retry.

`REAUTHORIZE_REQUIRED` means Stripe's authoritative economic state no longer matches the state Mino authorized. The stored pending attempt is cleared and must not be forced through with a new idempotency key. `BLOCKED` is also terminal for that attempt. Do not route either case around Mino through another provider tool.

## Credential and authority boundary

`pair` is the only command that prints the short-lived human claim secret. The private key, mandate token, pending operation state, and any payment material remain only in the restrictive local state file and are never printed by the Personal helper.

The owner must claim the pairing and grant authority through Mino's independently authenticated Personal surface before `activate` can succeed. Owner approvals are also resolved through that owner surface; the OpenClaw runtime never receives the owner's credential.

Mino Personal does not create economic capability. It governs an economic capability the agent already possesses. ACP merchant credentials and Stripe provider credentials are resolved by Mino server-side and are not supplied to the OpenClaw helpers. An economic action is not Mino-governed if the agent can simply execute it through an unrestricted alternate credential or provider path.