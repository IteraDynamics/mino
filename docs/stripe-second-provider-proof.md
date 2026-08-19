# Stripe second-provider proof

PR #37 proves that Mino's provider-neutral authorization boundaries can drive a materially different payment provider without changing policy meaning or inventing a provider-specific authorization artifact.

## Why Stripe

Stripe is a strong second-provider proof because its PaymentIntent model differs substantially from the current ACP checkout integration while remaining a conventional server-side payments API:

- payment execution is expressed by confirming a PaymentIntent;
- PaymentIntent state is retrieved separately and moves through provider-specific lifecycle statuses;
- Stripe recommends idempotency keys for payment requests;
- Connect routes server-side requests to a specific connected account with the `Stripe-Account` header;
- provider authentication is server-side and remains outside agent input.

Primary references:

- https://docs.stripe.com/api/payment_intents/confirm
- https://docs.stripe.com/api/payment_intents/retrieve
- https://docs.stripe.com/payments/payment-intents
- https://docs.stripe.com/api/authentication
- https://docs.stripe.com/connect/authentication

Circle remains a useful future proof for wallet/onchain execution, but adding it here would combine a second-provider test with a broader expansion into wallet, chain, asset, and settlement semantics. Stripe isolates the provider-neutrality question more cleanly.

## Architecture

```text
EconomicIntent (protocol=STRIPE)
        |
PolicyDecision
        |
Signed AuthorizationGrant
        |
StripeExecutionAdapter
        |
preflight GET PaymentIntent
  - connected account binding
  - PaymentIntent ID binding
  - amount/currency binding
        |
confirm PaymentIntent
        |
Stripe
```

Reconciliation remains provider-neutral above the adapter:

```text
PaymentOutcomeRecord
        |
StripeReconciliationAdapter
        |
SUCCEEDED | FAILED_DEFINITIVE | DEFERRED
        |
BackgroundPaymentReconciler
        |
commit | release | hold + retry
```

## Security invariants

### 1. Mino's grant remains the authorization artifact

The Stripe adapter consumes the same `SignedAuthorizationGrant` issued by `AuthorizationGrantService`. There is no Stripe-specific Mino authorization token or policy dialect.

### 2. Provider destination is bound before execution

For this proof, a Stripe Connect account is represented in the normalized counterparty as:

```json
{
  "scheme": "PROVIDER_REFERENCE",
  "namespace": "stripe-account",
  "value": "acct_..."
}
```

The execution adapter refuses a `Stripe-Account` destination not present in the signed grant.

The existing merchant policy projection may simultaneously use the counterparty's `DOMAIN` identifier. `PROVIDER_REFERENCE` is routing/binding evidence, not a provider-specific policy selector.

### 3. Provider economics are preflighted

Before confirmation, the adapter retrieves the PaymentIntent and requires:

- the expected PaymentIntent ID;
- exact approved amount;
- exact currency;
- a state that this proof adapter can safely confirm.

A mismatched PaymentIntent is never confirmed.

### 4. Provider idempotency is preserved

The existing Mino economic-intent idempotency key is forwarded as Stripe's idempotency key on confirmation. Provider-specific idempotency behavior does not redefine Mino's request identity.

### 5. Reconciliation fails closed

`StripeReconciliationAdapter` maps only:

- `succeeded` -> `SUCCEEDED`;
- `canceled` -> `FAILED_DEFINITIVE`.

Other known PaymentIntent states remain `DEFERRED`. Invalid responses, target mismatches, amount/currency mismatches, unavailable credentials, transport failures, and non-2xx retrievals also remain unresolved rather than inventing a terminal outcome.

### 6. Durable evidence is minimized

Reconciliation stores only the PaymentIntent ID, amount, currency, status, optional cancellation reason, and allowlisted request/version headers. It does not persist `client_secret`, payment method details, cookies, credentials, or arbitrary Stripe payloads.

## Compatibility boundary

This is a second-provider architecture proof, not production Stripe routing.

No production application composition, public route, database migration, admin API, console surface, or customer credential configuration is introduced.

`PaymentOutcomeRecord` still uses the compatibility field names `merchantId`, `merchantDomain`, and `checkoutSessionId`. In the Stripe proof adapter, those fields are interpreted as the internal Stripe target key, target domain, and PaymentIntent ID respectively. That is explicitly temporary compatibility storage, not provider-neutral vocabulary.

## Non-goals

PR #37 does not:

- add Stripe credentials to production configuration;
- expose a Stripe-facing public endpoint;
- create PaymentIntents;
- create or onboard Stripe Connect accounts;
- change Mino policy semantics;
- change mandates, approvals, reservations, or idempotency semantics;
- change ACP behavior;
- migrate PaymentOutcome persistence;
- claim production-ready Stripe support.

## What this proves

ACP and Stripe can sit behind the same Mino authorization architecture even though their provider object models, execution calls, credentials, destination routing, and reconciliation statuses differ.

That is the architectural point of the second-provider proof: changing the payment provider changes translation and transport, not what Mino means by authorization.
