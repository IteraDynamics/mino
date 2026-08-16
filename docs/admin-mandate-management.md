# Administrative mandate issuance and revocation

PR #26 extends Mino's administrative control plane from configuring reusable policy and merchant state to granting and terminating delegated economic authority.

This is a materially different boundary from agent, policy, or merchant administration: a successfully issued mandate can authorize an active agent to spend on behalf of an active user, subject to the immutable durable mandate snapshot and the rest of Mino's transaction controls.

## HTTP surface

```text
GET  /v1/admin/organizations/:organizationId/mandates
GET  /v1/admin/organizations/:organizationId/mandates/:mandateId
POST /v1/admin/organizations/:organizationId/mandates
POST /v1/admin/organizations/:organizationId/mandates/:mandateId/revoke
```

Administrative routes exist only when the trusted admin-JWT boundary is configured. Mandate issuance additionally requires the dedicated mandate signing key to be configured in the production runtime.

Permissions are narrow:

- inventory/detail: `mandate.read`
- issuance: `mandate.issue`
- revocation: `mandate.revoke`

Handlers authorize the exact permission inside the organization named by the route; they do not branch on role names.

## Issuance inputs and authority model

Issuance accepts only:

- an organization-local user ID;
- an organization-local agent ID;
- an organization-local policy row ID representing an exact policy version;
- an explicit expiration timestamp;
- a required administrative `Idempotency-Key` header.

PR #26 deliberately does **not** accept ad-hoc monetary, merchant, vendor, category, approval, or velocity overrides during mandate creation. The selected active policy row defines that reusable governance configuration; issuance grants authority by copying its exact configuration into the new durable mandate snapshot.

At commit time the service requires:

- the user to exist in the same organization and be `ACTIVE`;
- the agent to exist in the same organization and be `ACTIVE`;
- the agent to have usable registered key material;
- the selected exact policy row to exist in the same organization and be active;
- the requested expiration to be in the future.

Failure of any target check creates no mandate and no administrative audit event.

The durable mandate stores the copied policy version and controls. Later mutation of a reusable policy row does not rewrite a previously issued mandate snapshot. Existing transaction-path checks still require the referenced policy version to remain active, so explicit policy deactivation can fail that mandate closed as documented by PR #24.

## Signed bearer artifact

A newly created mandate receives a fresh JTI and a compact Ed25519-signed Mino mandate token. The token binds:

- issuer and audience;
- organization;
- user;
- agent;
- mandate ID;
- exact policy version;
- issued/not-before/expiration times;
- fresh token JTI.

PostgreSQL stores only the SHA-256 JTI digest. The existing transaction path verifies the token cryptographically and then binds those claims back to the durable mandate row. A valid signature is therefore necessary but not sufficient authority.

The raw mandate token is a deliberately narrow exception to the normal safe-projection rule: it is returned **once, only on a successful newly-created issuance response**, because the caller needs the resulting bearer artifact. Mino does not persist it, put it in administrative audit state, list it, expose it through detail reads, or redeliver it on an idempotent replay.

If a client loses that one-time response, repeating the same idempotency key confirms that the authority was already created but does not reproduce the bearer token. Creating another bearer authority requires an explicit new issuance with a new idempotency key.

## Dedicated signing authority

Mandate signing is intentionally separate from payment-delegation signing and administrative/transaction audit signing.

Production configuration supplies:

```text
MINO_MANDATE_PUBLIC_KEYS_B64_JSON
MINO_MANDATE_SIGNING_KEY_ID
MINO_MANDATE_PRIVATE_KEY_B64
# or
MINO_MANDATE_PRIVATE_KEY_FILE
```

Exactly one private-key source is permitted. Startup verifies that:

- the private key is Ed25519;
- the active signing-key ID exists in the mandate public verification-key map;
- the private key derives exactly that configured public key.

Historical mandate public keys may remain in the verification map during rotation. The runtime does not need old private mandate keys merely to verify previously issued unexpired bearer artifacts.

The reference Compose deployment mounts the mandate private key only into the long-running application service. The migration image continues to receive only the PostgreSQL datasource credential.

## Replay and concurrency semantics

Issuance requires an `Idempotency-Key`. Mino does not persist that raw value. It stores an organization-bound digest in `AgentMandate.issuanceKeyHash` with a unique organization-local constraint.

Under the same organization and idempotency key:

- the same user + agent + policy + expiration returns `REPLAYED`;
- changed reuse returns `CONFLICT`;
- neither case appends another administrative audit event;
- a replay never redelivers the raw mandate token.

Equivalent concurrent issuance is serialized with an organization-row lock, resulting in one durable mandate and one signed audit event.

A new idempotency key represents an explicit request for new authority. That remains true after an older mandate has been revoked or expired; terminal old authority is never resurrected in place.

## Revocation

Revocation is organization-scoped, explicit, and terminal for the affected mandate row.

The mutation changes the durable mandate status to `REVOKED` and records `revokedAt`. The existing production `PrismaMandateRepository.getById()` only resolves active mandates whose user, agent, and exact referenced policy version remain active. As a result, committed revocation becomes authoritative immediately for subsequent transaction-path mandate resolution.

A previously issued token can remain cryptographically valid until its signed expiration, but that does not restore authority: the durable resolver no longer returns the revoked mandate, so the token cannot satisfy the transaction boundary.

Repeating revocation is an idempotent replay and creates no duplicate audit history. Expired authority is also terminal; PR #26 does not reactivate or extend a mandate in place.

Revocation does not rewrite already-finalized transactions and does not fabricate outcomes for unresolved merchant payment dispatch. Existing reservation/payment reconciliation rules continue to govern obligations that were already created before revocation.

## Atomic administrative audit

Every actual issuance or revocation uses one PostgreSQL transaction for both governed state and its signed `AdminAuditLog` receipt.

Actions are:

```text
mandate.issue
mandate.revoke
```

The receipt records safe before/after authority state and request digests. It does not contain:

- raw mandate tokens;
- raw token JTI values;
- raw administrative idempotency keys;
- private signing keys;
- merchant credentials or other unrelated secrets.

The existing per-organization administrative audit chain and independent checkpoint-retention boundary continue to provide tamper evidence.

## Schema migration

PR #26 adds one nullable field to `AgentMandate`:

```text
issuanceKeyHash
```

and a unique constraint over:

```text
(organizationId, issuanceKeyHash)
```

The field is nullable so mandates created before this administrative issuance surface remain valid. New administrative issuance always populates it.

## Boundaries preserved

Issuing a mandate does not directly authorize a merchant payment. Every agent request still has to pass the existing controls, including:

- cryptographic mandate-token validation and durable binding;
- active user and agent checks;
- exact active policy-version binding;
- agent request signatures and nonce replay protection;
- mandate merchant/vendor/category/currency limits;
- machine velocity and cross-merchant controls;
- durable authorization reservation;
- human approval and retry revalidation where required;
- merchant-authoritative checkout evaluation;
- payment-outcome persistence and reconciliation;
- transaction audit.

PR #27 adds four-eyes/high-risk administrative governance above this authority boundary; it must not silently change the semantics of mandates already issued by PR #26.
