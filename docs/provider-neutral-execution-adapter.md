# Provider-neutral execution adapter boundary

PR #34 introduces the boundary between Mino authorization and provider-specific execution.

## Governing rule

Mino authorizes economic action. Execution providers move money.

```text
provider request
  -> EconomicIntent
  -> EconomicCounterpartyIdentity
  -> PolicyDecision
  -> SignedAuthorizationGrant
  -> EconomicExecutionAdapter
  -> provider-specific execution
```

The execution adapter is not allowed to reinterpret policy meaning. It may translate an already-authorized action into provider-native credentials, headers, request shapes, or transport behavior.

## Neutral contract

`EconomicExecutionAdapter<TContext, TResult>` receives:

- the normalized `EconomicIntent`;
- the final `PolicyDecision`;
- the signed provider-neutral `AuthorizationGrant`;
- provider-specific execution context;
- the execution timestamp.

The provider-specific context is deliberately outside the authorization model. Changing providers must not change the semantic meaning of the grant.

## ACP adapter #1

`ACPExecutionAdapter` is the first implementation.

For the current production ACP path it:

1. issues the signed provider-neutral `AuthorizationGrant`;
2. derives the existing ACP delegation assertion;
3. retains a short-lived in-process binding between that provider artifact and the grant;
4. refuses forwarding unless that prepared authorization exists;
5. consumes the prepared authorization once when forwarding;
6. delegates transport to the existing `ACPMerchantClient`.

The public ACP request/response contract is unchanged. Merchant routing, credentials, API versioning, idempotency headers, and delegation assertion wire format remain unchanged.

## Compatibility bridge

`CheckoutProxyService` still exposes its historical ACP-oriented dependency ports in PR #34. Production composition now supplies the same `ACPExecutionAdapter` instance as both the merchant execution client and delegation-assertion issuer.

This allows the live path to move behind the execution adapter without a broad rewrite of the transaction/approval/reconciliation orchestration in the same PR.

The compatibility ports are transitional. Future provider-neutral orchestration can call `EconomicExecutionAdapter.execute(...)` directly.

## Fail-closed invariants

ACP execution fails closed when:

- no prepared authorization exists;
- a prepared authorization was already consumed;
- the authorization grant is expired;
- the grant does not bind to the intent/decision being executed;
- the normalized intent protocol is not ACP.

Representability remains separate from authority. This PR does not authorize new counterparty kinds or providers.

## Keying note

PR #34 reuses the existing configured delegation signing key material for the new grant issuer in production composition. Token type and audience remain cryptographically domain-separated at the message level (`mino+authorization-grant+jwt` / `mino:economic-execution` versus the ACP delegation token). A dedicated grant signing-key configuration can be introduced as a later operational hardening step without changing the grant contract.

## Non-goals

PR #34 does not change:

- policy evaluation;
- mandate scope;
- approval semantics;
- spend reservation semantics;
- request digests or idempotency behavior;
- payment outcome persistence;
- reconciliation behavior;
- ACP HTTP routes or API versions;
- merchant registration/routing;
- admin APIs or console behavior;
- support for a second provider.

PR #35 can now generalize provider-neutral outcome/reconciliation semantics on top of this execution boundary.
