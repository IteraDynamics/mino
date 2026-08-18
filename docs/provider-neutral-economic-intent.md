# Provider-neutral EconomicIntent boundary

PR #31 introduces the first explicit provider-independence boundary in Mino's transaction architecture without changing runtime authorization behavior.

## Architectural rule

Mino authorizes normalized economic meaning, not provider-specific request shapes.

The governing invariant is:

> If changing the execution/payment provider changes the meaning of a Mino policy, the abstraction is wrong.

Provider adapters may parse, validate, and preserve provider provenance, but the policy evaluator consumes the canonical `EconomicIntent` domain contract.

## EconomicIntent

`src/domain/economic/economic-intent.types.ts` defines the canonical authorization input currently needed by the existing checkout path:

- request identity;
- normalized operation;
- organization, user, and agent identity;
- existing merchant identity;
- normalized cart/category facts;
- exact money values;
- idempotency identity;
- provider provenance (`protocol` and `rawPayload`).

The provenance fields are intentionally retained in PR #31 so existing behavior, evidence generation, request binding, and downstream ACP behavior remain unchanged. They are not policy inputs. Equivalent normalized intents must evaluate equivalently even when provider provenance differs.

## ACP boundary

`ACPAdapter` remains responsible for ACP-specific validation and parsing. Its output is now explicitly `EconomicIntent`.

That means ACP is an edge normalization concern rather than the semantic type owned by Mino's authorization core.

PR #31 does **not** introduce a second provider and does not generalize merchant/counterparty identity. Those are separate follow-on slices so this change can remain behavior-preserving and reviewable.

## Compatibility

`src/domain/checkout/checkout.types.ts` now exposes compatibility aliases over the provider-neutral types. Existing checkout-facing services can therefore continue compiling and behaving identically while the authorization core adopts the new domain boundary incrementally.

This is deliberate: PR #31 is an architectural seam, not a protocol migration.

## Provider-independence invariant

The unit suite includes a provider-independence test that evaluates economically identical intents with different `protocol` and `rawPayload` provenance and requires identical policy decisions.

The same test also proves that changing normalized economic facts, such as a restricted category, still changes authorization meaning. This guards against accidentally interpreting “provider-neutral” as “ignore economic context.”

## Explicit non-goals

PR #31 does not:

- change ACP routes or the pinned ACP API version;
- change HTTP status or verdict semantics;
- change policy thresholds, merchant matching, category handling, FX behavior, velocity, or spend accounting;
- change approval creation, approval binding, revalidation, or retry behavior;
- change request digests, idempotency semantics, reservations, payment outcomes, or reconciliation;
- change delegation assertion claims or signing behavior;
- generalize merchant identity into a broader counterparty/destination model;
- create a provider-neutral signed authorization grant;
- create a provider execution-adapter interface;
- add a second payment/execution provider.

Those boundaries should be introduced in later narrow slices after this semantic seam is established.

## Follow-on sequence

The intended sequence after PR #31 is:

1. generalized counterparty/destination identity;
2. provider-neutral signed authorization grant;
3. execution adapter boundary, with ACP becoming adapter #1;
4. provider-neutral outcome/reconciliation boundary;
5. provider-independence invariant suite expansion;
6. second-provider proof.
