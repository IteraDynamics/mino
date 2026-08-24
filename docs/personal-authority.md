# Mino Personal authority and OpenClaw activation

Pairing proves which agent belongs to the owner. Authority is granted separately.

```text
paired agent
    ↓
owner PUTs a human-readable authority profile
    ↓
Mino compiles it into the existing Policy model
    ↓
agent proves possession of its paired Ed25519 key
    ↓
Mino mints a short-lived AgentMandate credential
    ↓
normal Mino transaction authorization remains authoritative
```

The owner credential and agent credential never cross. OpenClaw does not receive the owner's JWT. The owner never has to paste an AgentMandate bearer token into an agent prompt.

## Owner authority

The authenticated Personal owner may create or update authority for a claimed agent:

```http
PUT /v1/personal/agents/:agentId/authority
Authorization: Bearer <owner JWT>
Content-Type: application/json

{
  "currency": "USD",
  "perTransactionLimit": "100.00",
  "dailyLimit": "300.00",
  "allowedMerchantDomains": ["shop.example"],
  "restrictedCategories": ["GIFT_CARDS"],
  "overLimitBehavior": "ASK_OWNER"
}
```

The Personal compiler produces the same core `Policy` representation used by the rest of Mino. Each meaningful update creates the next immutable policy version, deactivates the prior Personal version, and revokes active mandates bound to the prior Personal authority. An exact repeat is idempotent and does not manufacture another policy version.

Read the current profile:

```http
GET /v1/personal/agents/:agentId/authority
Authorization: Bearer <owner JWT>
```

Revoke it immediately:

```http
DELETE /v1/personal/agents/:agentId/authority
Authorization: Bearer <owner JWT>
```

Revocation deactivates the current Personal policy and revokes active Personal mandates for that agent. Pairing remains intact, so the owner can grant a new authority profile later without re-enrolling the key.

## Agent mandate activation

A paired agent cannot mint a credential unless active owner authority already exists. The agent signs:

```text
MINO-PERSONAL-MANDATE-V1
<agentId>
<keyId>
<Unix timestamp seconds>
<fresh nonce>
```

and submits:

```http
POST /v1/personal/agents/:agentId/mandate
Content-Type: application/json

{
  "keyId": "openclaw-k1",
  "timestamp": 1787590800,
  "nonce": "fresh-base64url-nonce",
  "signature": "<base64url Ed25519 signature>"
}
```

Mino validates the active Personal tenant, owner, beneficiary, claimed pairing, agent lifecycle, current policy, timestamp, signature and Redis-backed nonce freshness. It then revokes the prior credential for the same current policy and returns a fresh 30-day mandate token once. The raw token is not persisted by Mino.

The token is only a credential for the durable server-side mandate snapshot. It cannot enlarge the owner-granted authority, and policy deactivation or mandate revocation fails subsequent use closed immediately.

## OpenClaw skill

The native skill lives at `skills/mino/` and uses only Node.js plus `MINO_BASE_URL`.

```bash
node skills/mino/scripts/mino-personal.mjs pair --external-agent-id openclaw-personal --display-name OpenClaw
node skills/mino/scripts/mino-personal.mjs status
node skills/mino/scripts/mino-personal.mjs activate
node skills/mino/scripts/mino-personal.mjs state
```

The local helper stores Ed25519 private-key material and the mandate credential under `~/.mino/openclaw-personal.json` by default, with restrictive file permissions where the host supports them. It never prints either secret. `state` returns only a redacted readiness summary.

The one-time pairing claim secret is intentionally printable because it is the human handoff used to claim the agent through the independently authenticated owner surface.

This skill is not itself an economic execution adapter. An action is not "protected by Mino" merely because the skill is installed; the eventual card, wallet, browser or provider path must actually route through a Mino-aware execution adapter. Direct bypass paths remain outside Mino's enforcement boundary.
