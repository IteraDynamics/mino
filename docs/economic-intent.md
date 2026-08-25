# Canonical EconomicIntent

Mino's authorization boundary converts provider-authoritative economic state into an immutable, authority-bound representation before an economic consequence may execute.

> **Mino Core never trusts the agent's description of the consequence. It authorizes only canonical intent derived from authoritative state and validated semantics.**

The target lifecycle is:

```text
DelegatedAuthority
        ↓
EconomicIntent
        ↓
AuthorizationDecision
        ↓
ExecutionGrant
        ↓
EconomicExecution
        ↓
AuthorizationReceipt
```

`AuthorizationReceipt` is intentionally outside this slice.

## Two stages of intent

Provider adapters first produce validated, normalized economic facts. The existing TypeScript `EconomicIntent` transport shape remains this adapter-to-core representation for compatibility.

Before execution, Mino binds those facts to the current delegated authority and produces `CanonicalEconomicIntent` plus:

```text
intentDigest = SHA256-base64url(canonicalJson(CanonicalEconomicIntent))
```

The canonical object is versioned and deep-frozen.

## Canonical envelope v1

The v1 object contains only fields needed to identify the economic consequence and the authority under which it was evaluated:

- schema version;
- organization, beneficiary, agent, mandate, policy, and policy version;
- economic operation;
- provider protocol plus a digest of the provider-authoritative state projection;
- normalized counterparty identity;
- normalized cart and money values;
- digest of the semantic idempotency key.

It deliberately does **not** contain:

- per-attempt `requestId`;
- arbitrary raw provider payload;
- natural-language purpose text;
- arbitrary agent assertions.

A fresh transport retry therefore does not create a different intent merely because it has a new request ID. Conversely, changed provider-authoritative state, economics, counterparty, operation, idempotency identity, or delegated authority produces a different digest.

## Fact trust classes

Mino distinguishes three conceptual fact sources:

1. `PROVIDER_AUTHORITATIVE` — facts independently read from the execution/provider source of truth.
2. `MINO_DERIVED` — deterministic normalized semantics derived by Mino from trusted facts.
3. `AGENT_ASSERTED` — context supplied by an agent.

Agent assertions may be retained as explanatory context in future schemas, but must not independently satisfy an authorization predicate. Adding text such as `purpose = household purchase` cannot turn that assertion into authorization truth.

## Adapter responsibility

A provider adapter owns the projection used for `authoritativeStateDigest`. It must hash a stable set of validated provider facts, not arbitrary raw JSON.

ACP v1 currently binds its validated checkout session identity, state, currency, normalized line-item facts, totals, and protocol version. Unknown provider extension fields remain available as evidence but do not silently enter authorization semantics.

A future provider adapter must define an equivalent stable authoritative projection for its operation before claiming full canonical-intent support.

## Approval binding

When a decision requires human approval, the durable approval stores the `intentDigest` alongside its existing exact-request digest.

An approved request covers a retry only when both the request semantics and canonical intent still match. If the provider state changes after approval, the newly evaluated intent digest changes and the previous approval is stale.

```text
intent A → PENDING → human approves A
                         ↓
provider state unchanged → intent A → approval may cover
provider state changed   → intent B → approval cannot cover
```

## Execution binding

An `AuthorizationDecision` carries a required `intentDigest`. The signed `ExecutionGrant` copies that exact digest.

The ACP execution adapter recomputes the canonical intent from the actual execution input and authority reference immediately before producing/consuming the provider artifact. It fails closed unless:

```text
recomputed intent digest
    = decision.intentDigest
    = grant.intent_digest
```

This prevents a valid decision or grant from being replayed against a materially different authoritative consequence.

## Provider neutrality

Provider neutrality does not mean different providers produce identical intent digests. Provider protocol and authoritative-state evidence are part of what Mino authorized.

Neutrality means provider adapters map their different external shapes into the same Mino lifecycle without embedding provider-specific authority rules in Mino Core.

The next falsification test is a materially different provider/operation using the same lifecycle.
