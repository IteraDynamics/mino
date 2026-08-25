# Second-rail falsification: invoice payment

## Hypothesis

Mino's canonical lifecycle is provider-neutral if a materially different economic action can traverse:

`DelegatedAuthority -> EconomicIntent -> AuthorizationDecision -> ExecutionGrant -> EconomicExecution -> AuthorizationReceipt`

without provider-specific authorization logic in Core.

This spike uses `PAY_INVOICE` because invoice payment differs materially from ACP checkout:

- the counterparty is a payee rather than a merchant;
- the economic consequence has an amount but no shopping cart;
- authoritative invoice facts can mutate between approval and execution;
- execution is asynchronous (`PROCESSING` before terminal settlement);
- terminal state can still be bound into an AuthorizationReceipt.

The provider is simulated deliberately. The experiment is about the abstraction, not bank connectivity or product readiness.

## Checkout-shaped assumptions the spike exposed

The first implementation attempt found two real assumptions in Core.

### 1. Canonical economics were checkout-shaped

Canonical EconomicIntent v1 required `cart`, `subtotal`, and `total`. An invoice could only fit by inventing a fake cart.

That would have been a failed abstraction.

The spike therefore moves canonical EconomicIntent to schema version 2 with provider-neutral economics:

```text
amount
items[]                 optional economic components
checkoutBreakdown       optional checkout-only evidence
```

Existing ACP adapters still emit checkout-shaped normalized input. The canonical binder translates both checkout and non-checkout forms into the v2 envelope. Request IDs and raw provider payload remain excluded from intent identity.

### 2. Delegated counterparty policy was merchant-shaped

The evaluator understood merchant domains and vendor IDs only. Treating an invoice payee as a fake merchant would again hide the failure.

The spike adds normalized counterparty authority selectors over existing `EconomicCounterpartyIdentity`:

- `MERCHANT`
- `PAYEE`
- `ACCOUNT`
- `WALLET`
- `OTHER`

A mandate can now carry `approvedCounterparties`. When that field is present, Core evaluates normalized identity and provider-neutral distinct-counterparty velocity. Existing `approvedMerchantDomains` / `approvedVendorIds` behavior remains as an ACP compatibility path.

There is no `PAY_INVOICE` or invoice-provider conditional inside `EconomicPolicyEvaluator`.

## Invoice adapter

The edge adapter owns provider semantics.

Authoritative invoice state contains:

- invoice ID;
- payee ID;
- amount due;
- currency;
- due date;
- invoice status;
- provider version.

`normalizeInvoiceIntent()` validates that state and produces:

```text
protocol: CUSTOM
operation: PAY_INVOICE
counterparty: PAYEE
value: authoritative amount due
authoritativeStateDigest: SHA-256(stable provider projection)
```

The intent contains no fake cart.

Immediately before execution, the invoice execution adapter re-fetches authoritative invoice state, normalizes it again, and recomputes the canonical intent digest using the authority carried by the decision.

Execution is permitted only when:

```text
recomputed intentDigest
= AuthorizationDecision.intentDigest
= ExecutionGrant.intent_digest
```

A changed amount, payee, due state, invoice status, or provider version therefore invalidates the previously authorized consequence before provider submission.

## Async execution

Invoice submission returns `PROCESSING`, not terminal success.

The provider-specific reconciliation adapter maps provider state into the existing neutral reconciliation outcomes:

```text
PROCESSING -> DEFERRED
SETTLED    -> SUCCEEDED
FAILED     -> FAILED_DEFINITIVE
```

Core does not interpret invoice settlement states.

## AuthorizationReceipt

`PAY_INVOICE` is accepted by the same signed receipt model introduced in PR #49. The persisted receipt parser recognizes the operation, and receipt evidence remains:

- authorization/audit evidence = what Mino authorized;
- execution outcome = what the provider eventually did;
- receipt = signed binding between the two through `intentDigest`.

## Falsification assertions

The spike is a pass only if all of the following hold:

1. Invoice intent has no fake cart or merchant alias.
2. `EconomicPolicyEvaluator` contains no invoice-provider authorization branch.
3. An approved payee is evaluated through normalized counterparty authority.
4. An unapproved payee fails closed.
5. A transaction-limit breach uses the existing human-approval machinery.
6. Approval binds the exact `intentDigest`.
7. Mutating authoritative invoice state makes the prior approval stale.
8. The execution adapter independently refuses the old decision/grant after mutation.
9. Async settlement uses the existing neutral reconciliation dispositions.
10. The existing signed AuthorizationReceipt can represent and verify `PAY_INVOICE`.
11. Existing ACP checkout behavior remains green.

## Deliberate remaining seams

This spike does **not** claim all persistence and presentation naming is provider-neutral. Existing operational records still contain checkout-era fields such as `merchantId`, `merchantDomain`, and `checkoutSessionId`. The synthetic approval fixture therefore still supplies compatibility values for those presentation fields.

That is recorded as follow-on operational-model debt, not hidden as a provider-neutral success. The spike's question is narrower: whether authorization semantics in Core generalize without provider-specific branches.

If the tests require invoice-specific authorization semantics in Core, the experiment fails and the abstraction must be reconsidered rather than shimmed.
