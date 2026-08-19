# Provider-independence invariants

Mino's provider-neutral architecture is not a naming convention. It is a set of executable invariants that must remain true as additional execution providers are added.

## Governing principle

> If changing the payment or execution provider changes the meaning of a Mino policy, we designed Mino wrong.

Provider provenance may affect translation, transport, credentials, provider-native request shapes, and evidence parsing. It must not redefine normalized economic meaning or the authorization decision derived from it.

## Invariants

### 1. Policy provenance independence

Two `EconomicIntent` values with identical normalized economic meaning must produce the same `PolicyDecision` when only `protocol` and `rawPayload` differ.

This does not mean unlike economic actions are equivalent. Changing amount, counterparty, category, operation, mandate scope, spend state, or another policy-relevant field may and should change the decision.

### 2. AuthorizationGrant provenance independence

A signed `AuthorizationGrant` binds normalized economic meaning, not provider provenance. For equivalent intents, provider-specific payloads and protocol names must not change the grant claims, signature input, or `intent_digest`.

The grant remains Mino's portable authorization artifact. It is not itself a provider payment command.

### 3. Provider implementation isolation

The neutral policy evaluator, AuthorizationGrant issuer, execution-adapter contract, and reconciliation-adapter contract must not import ACP implementation modules or ACP merchant-client contracts.

Provider implementation code belongs behind adapters.

The current `BackgroundPaymentReconciler` intentionally retains a temporary ACP construction compatibility bridge so existing composition can still pass ACP merchant dependencies. That bridge must immediately instantiate `ACPReconciliationAdapter`; the reconciliation state-transition path itself must consume only `EconomicReconciliationAdapter` observations and must not parse ACP state directly.

### 4. Adapter-specific fail-closed behavior

Provider adapters may require provider-specific protocol identity and context. A provider-specific adapter must refuse incompatible provider input rather than reinterpret it.

Existing ACP execution and reconciliation adapter tests enforce this behavior at the provider boundary.

### 5. Provider-neutral reconciliation state transitions

The core reconciliation state machine consumes normalized reconciliation observations. Provider-specific status vocabularies and payload parsing belong in reconciliation adapters.

Only normalized success may commit reserved spend. Only normalized definitive failure may release it. Unavailable, malformed, mismatched, or nonterminal evidence remains unresolved and is retried according to Mino's reconciliation policy.

## Test coverage

`tests/unit/provider-independence-invariants.test.ts` is the cross-layer invariant suite. It intentionally complements, rather than replaces, the focused tests for:

- generalized counterparty policy boundaries;
- AuthorizationGrant issuance;
- ACP execution adapter behavior;
- ACP reconciliation adapter behavior;
- provider-neutral reconciliation injection;
- durable background reconciliation.

The cross-layer suite is expected to fail if a future provider addition changes policy/grant semantics, leaks provider implementation imports into neutral contracts, or moves provider-specific state interpretation back into the reconciliation state machine.

## Scope

This invariant suite does not claim that all current persistence, construction, or API presentation is provider-neutral. `PaymentOutcome` storage, the reconciler's temporary ACP constructor compatibility shape, and portions of the current checkout-facing API remain compatibility-shaped around the first ACP integration. Those migrations are separate from the semantic invariants protected here.
