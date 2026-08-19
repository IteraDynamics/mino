# Provider-neutral admin API presentation

Mino's durable storage still contains compatibility fields from the original ACP checkout path. Those storage names do not define Mino's control-plane semantics.

## Governing rule

> Persistence compatibility terminology must not become authorization vocabulary.

Admin-facing economic records therefore expose a provider-neutral `economic` presentation in addition to the existing compatibility fields.

## Neutral presentation

Applicable admin responses now include:

```json
{
  "economic": {
    "provider": { "protocol": "ACP" },
    "counterparty": {
      "kind": "MERCHANT",
      "identifiers": [
        { "scheme": "DOMAIN", "value": "supplier.example" },
        { "scheme": "VENDOR_ID", "value": "vendor-42" }
      ]
    },
    "executionReference": "cs_123"
  }
}
```

The fields are intentionally grouped so future providers do not need to masquerade as ACP concepts merely to be understandable in an administrative surface.

### `counterparty`

`counterparty` uses the same generalized economic counterparty identity introduced for authorization. Current durable admin records still carry merchant-domain/vendor compatibility fields, so their neutral presentation is a `MERCHANT` counterparty with `DOMAIN` and optional `VENDOR_ID` identifiers.

This is presentation only. It does not expand current merchant-scoped policy authority to ACCOUNT, WALLET, or OTHER counterparties.

### `executionReference`

`executionReference` is the provider-side execution/session object reference when one is durably available. Existing ACP-shaped records source this from `checkoutSessionId`.

The neutral name deliberately does not claim every provider uses a checkout session.

### `provider`

Provider provenance is shown only when the durable source actually carries it. Transaction audit records persist protocol provenance and therefore expose `economic.provider.protocol`.

Current ApprovalRequest and PaymentOutcome persistence does not contain a trustworthy provider-protocol field. Their presentation therefore does **not** infer one from merchant names, domains, object prefixes, or current production composition.

> Representability is not authority, and presentation is not evidence creation.

If Mino does not durably know a provider fact for a record, the admin API leaves that fact absent.

## Compatibility

The following legacy fields remain in responses during this migration:

- `merchantId`
- `merchantDomain`
- `merchantVendorId` where available
- `checkoutSessionId`
- transaction-audit `protocol`

Existing console and API consumers therefore continue to work while new consumers can use the neutral `economic` envelope.

This PR does not rewrite the current single-page console's display terminology. It makes the neutral representation available at the authoritative admin API boundary first, while preserving the console's existing compatibility path. A later UX pass can migrate labels without coupling that work to economic semantics.

## Surfaces

The neutral envelope is added to:

- admin approval list/detail responses;
- approval vote responses that return an ApprovalRequest;
- admin payment-outcome list/detail responses;
- admin transaction-audit list responses.

Administrative-change audit records are not economic execution records and are unchanged.

Operational aggregate counters are also unchanged; they already describe provider-neutral durable outcome states such as unresolved, succeeded, failed-definitive, and reconciliation attempts.

## Security and correctness properties

1. No provider is guessed from an identifier prefix or merchant record.
2. No persistence state is mutated to produce the presentation.
3. No authorization or policy decision reads the presentation layer.
4. Existing organization-scoped RBAC remains authoritative for admin endpoints.
5. Legacy fields are preserved so presentation migration cannot silently break operational tooling.
6. Counterparty presentation is derived deterministically from the durable legacy identity facts already returned by the endpoint.

## Non-goals

This slice does not:

- migrate the `PaymentOutcome`, `ApprovalRequest`, or `AuditLog` database schema;
- remove merchant/checkout compatibility fields;
- add production Stripe routing or Stripe credentials;
- change policy, mandate, approval, reservation, idempotency, or reconciliation semantics;
- change ACP routes or wire behavior;
- redesign the admin console;
- claim that all persistence is provider-neutral.

The purpose is narrower: ensure the administrative API can speak Mino's provider-neutral economic language now that two materially different provider adapters have proven the execution boundary.
