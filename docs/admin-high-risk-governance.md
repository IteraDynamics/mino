# High-risk administrative four-eyes governance

Mino applies an explicit durable governance layer to a bounded set of administrative mutations that can create or enable economic authority.

This layer is separate from transaction-level human payment approvals. Transaction approvals decide whether a particular economic request may proceed. Administrative governance decides whether a sensitive control-plane configuration change may become authoritative.

## Governed actions

PR #39 governs exactly:

- `mandate.issue` — creates delegated economic authority for an agent;
- `policy.activate` — makes an inactive policy version eligible to govern new authority.

The bounded scope is intentional. Mino does not turn every administrator write into an arbitrary approval workflow.

Authority-removing actions such as mandate revocation and policy deactivation remain direct RBAC operations so an authorized administrator can fail closed without waiting for another human.

## Lifecycle

A governed change moves through these phases:

```text
proposer A
    |
    v
PENDING governance request
    |
    | exact proposal + precondition digests
    v
distinct authorized principal B approves
    |
    v
APPROVED
    |
    | explicit apply
    | revalidate proposer, approver, executor, target state
    v
APPLIED
```

A rejection becomes `REJECTED`. A request that outlives its approval window becomes `EXPIRED`. A request whose authority or target state no longer matches the approved preconditions becomes `STALE` and does not mutate the target.

The current approval window is 30 minutes from proposal creation.

## Exact proposal binding

Each governance request stores separate digests for:

- the requested mutation;
- the target/precondition state observed when proposed;
- the combined governance proposal.

For policy activation, the precondition binds the exact organization-local policy ID, name, version, activation state, economic configuration, controls, and durable update timestamp.

For mandate issuance, the precondition binds the organization-local user state, agent identity state and verification key, exact active policy snapshot, and absence of a prior mandate under the supplied issuance idempotency key.

Approval is therefore not a reusable permission to perform a similar action later. It is evidence for one exact proposed mutation against one observed target state.

## Distinct-principal rule

The proposer cannot approve their own request.

Approval is keyed by stable Mino administrator principal identity, not by browser session or display name. The current slice requires one distinct approving principal in addition to the proposer.

The approving principal must currently hold the same underlying narrow permission as the proposed mutation:

- `policy.activate` for a policy-activation request;
- `mandate.issue` for a mandate-issuance request.

`governance.read` only permits visibility into the governance queue. It does not itself grant vote or apply authority.

## Revalidation at apply

An approval does not immediately perform the mutation.

The explicit apply step rechecks, inside the durable mutation transaction:

1. the applying principal still has the underlying mutation permission;
2. the original proposer principal and membership are still active and still have that permission;
3. the distinct approving principal and membership are still active and still have that permission;
4. the request is still within its expiry window;
5. the target precondition digest still matches current durable state.

Any failed authority or target-state check produces `STALE` or `EXPIRED` rather than silently applying previously approved authority to changed state.

## Atomic application and audit

When all revalidation passes, Mino commits the actual mutation, the governance `APPLIED` transition, and signed administrative audit evidence in one PostgreSQL transaction.

The existing mutation audit action is retained for compatibility and evidence continuity:

- `policy.activate` for governed policy activation;
- `mandate.issue` for governed mandate issuance.

Those mutation audit records carry governance request/proposal metadata. Separate governance audit events record proposal, approval/rejection, stale/expiry, and apply lifecycle transitions in the independent administrative audit chain.

## Mandate token boundary

A mandate proposal does not mint a bearer token.

The mandate token is created only during the successful apply transaction, after all four-eyes and state revalidation has passed. The raw signed token is returned once to the applying administrator and is not stored in the governance request or signed administrative audit records.

The durable governance request stores the internal issuance idempotency key only in its execution payload because applying the exact approved mutation must preserve the existing mandate idempotency semantics. Administrative projections expose only the safe proposal payload and never return that internal execution payload.

## Replay and concurrency behavior

Proposal creation is idempotent per organization, governed action, and client idempotency key. Reusing the same key for a materially different proposal conflicts.

A principal may replay the same vote decision without adding another vote. Attempting to change an already-cast vote conflicts. Applying an already applied request replays without creating another policy transition or mandate.

Database row locking and unique constraints provide the durable serialization boundary.

## Console behavior

The web console exposes a separate **Governance** view for this administrative workflow.

Policy activation and mandate issuance now create proposals rather than claiming the change happened immediately. A distinct eligible administrator can approve or reject a pending proposal, and an eligible administrator can explicitly apply an approved proposal. For mandate issuance, the one-time bearer token appears only after successful apply.

## Non-goals

PR #39 does not:

- create a customer-authored ABAC/expression language;
- merge administrative governance with transaction payment approvals;
- govern every administrative mutation;
- allow an administrator to force payment outcomes, release reservations, or bypass economic policy;
- change transaction policy evaluation, provider execution, reconciliation, or provider-neutral authorization semantics;
- store mandate bearer tokens, signing private keys, merchant credentials, or administrator JWTs in governance records.
