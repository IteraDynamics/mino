# Provider-neutral counterparty identity boundary

PR #32 generalizes the identity of the recipient/destination of economic value without changing the currently authorized merchant policy vocabulary.

## Architectural rule

Mino must distinguish **who receives value** from **which provider executes the transfer**.

Provider-native objects, checkout payloads, account handles, wallet addresses, merchant domains, and vendor identifiers are inputs to normalization. They are not themselves the authorization model.

The provider-neutral authorization core therefore carries an `EconomicCounterpartyIdentity` made of:

- a counterparty kind (`MERCHANT`, `ACCOUNT`, `WALLET`, or `OTHER`);
- one or more normalized identifiers;
- optional identifier namespaces where an identifier is meaningful only within a particular system.

The currently defined normalized identifier schemes are:

- `DOMAIN`;
- `VENDOR_ID`;
- `PROVIDER_REFERENCE`;
- `ACCOUNT_REFERENCE`;
- `WALLET_ADDRESS`.

These identifiers are authorization facts only. They do not contain routing credentials, secrets, bearer material, or execution instructions.

## Compatibility bridge

The existing ACP/checkout path still supplies the historical merchant projection:

```text
merchant.domain
merchant.vendorId?
```

`EconomicIntent` now accepts the canonical `counterparty` identity while retaining that legacy merchant representation as a compatibility bridge. The policy core resolves both through one counterparty normalization boundary.

When both representations are supplied they must agree on the merchant projection. Contradictory identity state is treated as ambiguous and fails closed.

This preserves all current ACP request binding, audit, approval, delegation, payment, and reconciliation behavior while allowing provider-neutral intents to represent future account or wallet destinations without inventing a fake merchant domain.

## Current policy semantics remain merchant-scoped

PR #32 does **not** silently broaden mandate authority.

Existing mandates still authorize only the merchant selectors they already contain:

- approved merchant domains;
- approved vendor IDs.

A generalized `ACCOUNT`, `WALLET`, or other destination therefore does not become authorized merely because the type system can represent it. Until a future policy/mandate slice explicitly defines how those destination classes are scoped, they fail closed under the existing `MERCHANT_NOT_APPROVED` hard-block reason.

That distinction is deliberate:

> Representability is not authority.

## Policy evaluator boundary

The stable `PolicyEvaluator` import now routes through the counterparty-aware economic implementation. Existing callers remain source-compatible, but merchant scope and cross-merchant velocity checks first resolve the generalized counterparty into the currently supported merchant policy projection.

This gives Mino a single place to enforce ambiguity and unsupported-destination behavior rather than asking every future provider adapter to reproduce merchant policy semantics.

## Zero-behavior-change guarantees

For the existing ACP path, PR #32 does not change:

- merchant domain matching or subdomain semantics;
- approved vendor-ID behavior;
- category restrictions;
- transaction or daily spend limits;
- approval creation, voting, expiry, binding, or retry semantics;
- velocity thresholds;
- FX behavior;
- request/idempotency binding;
- reservations;
- payment outcomes or reconciliation;
- delegation assertions;
- ACP routing, API versioning, or merchant credentials;
- administrative APIs or the console.

The existing legacy merchant form and the equivalent canonical `MERCHANT` counterparty must produce the same `PolicyDecision`.

## Fail-closed invariants

PR #32 adds explicit tests requiring that:

1. equivalent legacy and canonical merchant identities authorize identically;
2. conflicting canonical and legacy identities are blocked;
3. unsupported destination kinds are blocked rather than coerced into merchant authority.

## Follow-on boundary

PR #32 does not yet define account/wallet authorization scopes in policies or mandates, and it does not introduce a second execution provider.

The next planned slice is the provider-neutral signed `AuthorizationGrant`. That artifact can now bind to normalized economic intent and counterparty identity without making ACP merchant fields part of Mino's long-term authorization contract.
