# Provider-neutral outcome and reconciliation boundary

PR #35 separates Mino's durable reconciliation state machine from provider-specific outcome semantics.

The governing rule is:

> Providers report state. Mino decides how that evidence changes authorization state.

The durable flow is now:

```text
PaymentOutcomeRecord
      ↓
EconomicReconciliationAdapter
      ↓
provider-specific observation
      ↓
SUCCEEDED | FAILED_DEFINITIVE | DEFERRED
      ↓
Mino reconciliation state machine
      ↓
commit | release | hold + retry
```

## Provider-neutral observation contract

`EconomicReconciliationAdapter` returns one of three observations:

- `SUCCEEDED` with sanitized provider evidence;
- `FAILED_DEFINITIVE` with sanitized provider evidence; or
- `DEFERRED` with a stable error code and optional provider status.

The core reconciler does not parse provider payloads or assign meaning to provider lifecycle strings. It owns only Mino authority transitions:

- preserving the reconciliation hold;
- committing reserved spend after provider-confirmed success;
- releasing reserved spend after provider-confirmed definitive failure;
- persisting terminal outcome evidence;
- leasing unresolved work; and
- deterministic retry/backoff.

A provider adapter cannot directly commit or release spend.

## ACP adapter #1

`ACPReconciliationAdapter` is the first provider implementation. It owns ACP-specific semantics that previously lived directly in `BackgroundPaymentReconciler`, including:

- merchant endpoint and domain consistency checks;
- server-side merchant credential lookup;
- ACP `GET /checkout_sessions/:id` reconciliation reads;
- ACP version selection;
- checkout-session parsing;
- checkout ID binding;
- `completed` plus order evidence as success;
- canceled/cancelled state as definitive failure;
- nonterminal checkout state as deferred; and
- safe response-header projection.

The adapter emits only the normalized observation back to the reconciliation core.

## Provider independence

The reconciliation core accepts any `EconomicReconciliationAdapter`, independent of protocol. Unit coverage proves that a non-ACP adapter can produce a successful provider-neutral observation without the core interpreting ACP payloads, merchant lifecycle strings, or ACP status codes.

This follows the same architectural progression as the earlier boundaries:

```text
EconomicIntent
      ↓
PolicyDecision
      ↓
AuthorizationGrant
      ↓
EconomicExecutionAdapter
      ↓
provider execution
      ↓
EconomicReconciliationAdapter
      ↓
Mino durable outcome state
```

## Compatibility boundary

The existing production composition and integration harnesses still use the historical ACP-shaped constructor fields (`merchants`, `merchantClient`, credentials, request-ID generator). `BackgroundPaymentReconciler` immediately converts that compatibility shape into `ACPReconciliationAdapter` and thereafter executes only against the provider-neutral reconciliation contract.

This compatibility constructor is not new provider authority. A second provider should supply an explicit `EconomicReconciliationAdapter` rather than extending ACP fields.

The durable `PaymentOutcome` persistence schema also remains merchant/checkout-shaped in this slice. PR #35 does not reinterpret those fields as universal economic vocabulary. They remain compatibility storage for the current ACP execution path and must not be used to define provider-neutral policy meaning.

## Security invariants

- provider-specific payloads cannot directly mutate spend state;
- terminal success requires provider adapter evidence before spend is committed;
- terminal failure requires provider adapter evidence before spend is released;
- nonterminal, malformed, unavailable, or mismatched provider state remains unresolved and retries with the existing bounded backoff;
- provider evidence is redacted before durable storage;
- only allowlisted response headers are retained by the ACP adapter;
- merchant registry/domain mismatch fails closed into deferred reconciliation rather than querying a changed destination.

## Non-goals

PR #35 does not change:

- policy evaluation or thresholds;
- mandate semantics;
- approval semantics;
- request digests or idempotency;
- reservation accounting rules;
- payment outcome database schema or status enum;
- synchronous ACP completion HTTP classification in `CheckoutProxyService`;
- ACP routes, versioning, credentials, or merchant routing;
- admin APIs or console behavior;
- reconciliation leases/backoff timings; or
- second-provider production support.

The synchronous execution-response classification remains compatibility logic in the current ACP checkout proxy. The durable reconciliation interpretation boundary is the provider-neutral boundary introduced here; further removal of provider-specific compatibility code should be driven by the provider-independence invariant suite and second-provider proof.

## Follow-on

PR #36 should add explicit provider-independence invariants across normalized intent, counterparty identity, authorization grants, execution adapters, and reconciliation adapters. PR #37 can then use a second provider to identify any remaining abstraction leaks rather than widening the contract speculatively.
