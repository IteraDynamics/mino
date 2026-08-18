# Provider-neutral AuthorizationGrant

PR #33 introduces Mino's provider-neutral signed authorization artifact on top of `EconomicIntent` and `EconomicCounterpartyIdentity`.

## Architectural rule

Mino's authorization result must be representable independently of whichever provider eventually moves money.

The flow is:

```text
provider request
    -> EconomicIntent
    -> EconomicCounterpartyIdentity
    -> PolicyDecision
    -> signed AuthorizationGrant
    -> provider-specific execution artifact
```

The `AuthorizationGrant` is the boundary between Mino authorization and provider execution. It does not itself move money.

## Grant contents

The signed grant binds:

- organization, user, and agent identity;
- mandate, policy, policy version, and decision identity;
- request identity;
- normalized economic operation;
- normalized counterparty identity;
- exact approved amount and currency;
- idempotency identity via digest;
- a canonical provider-neutral economic-intent digest;
- issue and expiry time.

It deliberately does not bind provider protocol or raw provider payload into `intent_digest`. Economically equivalent normalized intents therefore produce the same intent binding even when their ACP/Stripe/custom provenance differs.

## Signing

The compact token uses Ed25519 with:

- `typ = mino+authorization-grant+jwt`;
- `v = 1`;
- a provider-neutral audience of `mino:economic-execution`.

PR #33 reuses the existing delegation signing-key material. Key-separation can be introduced later if deployment requirements justify a separate authorization-grant key domain.

## Fail-closed rules

A grant is issued only for an `ALLOW` decision with an exact approved amount and an unambiguous normalized counterparty. Blocked or pending decisions cannot obtain a grant.

Representability still does not create authority: unsupported account/wallet destinations remain blocked by the policy boundary established in PR #32.

## ACP compatibility

`ACPAuthorizationGrantAdapter` defines the compatibility bridge for the current ACP delegation assertion: issue the provider-neutral grant first, then emit the existing ACP-specific delegation assertion.

PR #33 does not yet replace the production execution dependency graph with a generalized adapter registry. That wiring belongs to PR #34, whose purpose is to make ACP adapter #1 behind an explicit execution boundary. Keeping that step separate prevents this PR from changing live ACP output or execution behavior while the signed grant format is established and tested.

## Explicit non-goals

PR #33 does not change:

- policy evaluation or verdict semantics;
- merchant/counterparty authority;
- ACP request/response schemas or API versioning;
- approval binding/revalidation;
- request idempotency;
- spend reservations;
- payment outcomes or reconciliation;
- current ACP delegation-assertion claims;
- admin APIs or console behavior;
- provider routing or credentials;
- custody or money movement.

## Follow-on

PR #34 should introduce the execution-adapter boundary and make the current ACP path consume `SignedAuthorizationGrant` as adapter input while preserving current behavior. A later provider proof can then consume the same grant without changing Mino policy meaning.
