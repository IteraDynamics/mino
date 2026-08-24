# Mino Personal owner bootstrap and agent pairing

Mino Personal pairing establishes **identity ownership**, not spending authority.

```text
agent creates Ed25519 keypair
        ↓
POST /v1/personal/pairing-requests
        ↓
Mino returns a short-lived claim secret once
        ↓
independently authenticated Personal owner
        ↓
POST /v1/personal/pairing-requests/:id/claim
        ↓
AgentIdentity enrolled in the owner's PERSONAL organization
        ↓
NO Policy
NO AgentMandate
NO payment authority
```

The agent private key never enters Mino. Pairing stores only the canonical Ed25519 public key, its SHA-256 fingerprint, and a SHA-256 digest of the one-time claim secret.

## Personal owner bootstrap

The Personal surface is opt-in and is not registered unless trusted Personal JWT issuers are configured.

An authenticated external `(issuer, subject)` can bootstrap one Personal account:

```http
POST /v1/personal/bootstrap
Authorization: Bearer <owner JWT>
Content-Type: application/json

{
  "beneficiaryEmail": "owner@example.com",
  "displayName": "Owner"
}
```

Bootstrap atomically creates:

- one `Organization` with `kind = PERSONAL`;
- one active economic `User` beneficiary;
- one active `PersonalOwner` bound to the authenticated `(issuer, subject)`.

The `PersonalOwner` is not an `AdminPrincipal`; Personal does not inherit enterprise memberships, roles, four-eyes governance, or admin permissions.

## Pairing request

The agent generates and retains an Ed25519 private key, then submits only the public identity:

```http
POST /v1/personal/pairing-requests
Content-Type: application/json

{
  "externalAgentId": "openclaw-home",
  "displayName": "OpenClaw",
  "keyId": "openclaw-k1",
  "publicKey": "-----BEGIN PUBLIC KEY-----..."
}
```

The response includes a `claimSecret` exactly once. Pairing requests expire after ten minutes by default.

The agent may poll:

```http
GET /v1/personal/pairing-requests/:pairingRequestId
```

Polling never returns the claim secret or owner/account identity. After a successful claim it may return the resulting Mino `agentId`, which the agent needs for later signed Mino requests.

## Claim

The human owner receives the request ID + one-time claim secret through the agent experience and claims it through the independently authenticated Personal surface:

```http
POST /v1/personal/pairing-requests/:pairingRequestId/claim
Authorization: Bearer <owner JWT>
Content-Type: application/json

{
  "claimSecret": "<one-time secret>"
}
```

Mino locks and revalidates the owner, PERSONAL organization, beneficiary, and pairing request in one PostgreSQL transaction. It then enrolls the `AgentIdentity` or reuses an exact existing identity. Conflicting external-agent/key reuse fails closed.

A same-owner retry of an already-successful claim is idempotent. A wrong secret, expired request, different owner, or conflicting agent identity cannot enroll the agent.

## Authority separation

Pairing alone deliberately creates neither `Policy` nor `AgentMandate`.

```text
paired agent
    ≠
authorized agent
```

The later Personal authority flow compiles human-readable permissions into the existing Mino policy model and issues a bounded mandate separately. This preserves the core invariant that identity enrollment never confers spending authority.

## Trusted Personal JWT issuers

Configure Personal ingress separately from administrative ingress:

```text
MINO_PERSONAL_JWT_ISSUERS_JSON
```

The JSON format matches the hardened pinned-key JWT configuration used elsewhere in Mino: HTTPS issuer → audience + verification-key map. Personal reuses only the cryptographic verifier; ownership resolution remains Personal-specific.

For the reference Compose deployment, add the Personal overlay:

```bash
docker compose \
  -f deploy/docker-compose.runtime.yml \
  -f deploy/docker-compose.personal-auth.yml \
  up --build -d
```

Leaving the Personal issuer configuration absent leaves the Personal HTTP surface disabled.
