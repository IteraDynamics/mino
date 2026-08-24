# Mino OpenClaw skill

This directory is the native OpenClaw skill bundle for Mino Personal onboarding.

Local smoke test:

```bash
MINO_BASE_URL=http://127.0.0.1:3000 node skills/mino/scripts/mino-personal.mjs pair --external-agent-id openclaw-personal --display-name OpenClaw
MINO_BASE_URL=http://127.0.0.1:3000 node skills/mino/scripts/mino-personal.mjs status
MINO_BASE_URL=http://127.0.0.1:3000 node skills/mino/scripts/mino-personal.mjs activate
MINO_BASE_URL=http://127.0.0.1:3000 node skills/mino/scripts/mino-personal.mjs state
```

`pair` is the only command that prints the short-lived human claim secret. The private key and mandate token remain only in the local state file and are never printed by the helper.

The owner must claim the pairing and grant authority through Mino's independently authenticated Personal surface before `activate` can succeed.
