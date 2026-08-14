# Payment Outcome Reconciliation

Mino must never interpret a lost merchant response as proof that a payment failed.

A completion request crosses a distributed-systems boundary: the merchant can accept and process a payment while the network response back to Mino is lost. Releasing the spend reservation in that case can allow the same corporate allowance to be spent again before the original payment is accounted for.

## State model

`PaymentOutcome` is durable PostgreSQL state keyed by organization and idempotency key and bound to one Redis spend reservation.

- `FORWARDING` — Mino persisted intent and extended the spend reservation before dispatching payment.
- `UNKNOWN` — payment was dispatched, but Mino cannot prove success or failure yet.
- `SUCCEEDED` — merchant success is proven and the Redis reservation must be committed.
- `FAILED_DEFINITIVE` — merchant failure is proven and the Redis reservation may be released.

Terminal outcomes are replayable. A retry with the same request digest does not forward payment again.

## Classification after dispatch

Mino treats these outcomes conservatively:

- HTTP 2xx: success; persist `SUCCEEDED`, then commit spend.
- Definite HTTP 4xx other than 409/422: persist `FAILED_DEFINITIVE`, then release spend.
- HTTP 409: unresolved/in-flight; retain spend and reconcile.
- HTTP 422: do not assume payment did not happen; retain spend and reconcile.
- HTTP 5xx: unresolved; retain spend and reconcile.
- Transport exception/timeout: unresolved; retain spend and reconcile.

The reservation is moved from its short authorization TTL to a reconciliation hold before the merchant completion request is sent. The MVP default hold is 26 hours so an ambiguous payment remains part of the rolling daily allowance while Mino establishes the outcome.

## Request-driven reconciliation

On a retry with the same idempotency key, Mino first loads the durable payment outcome and retrieves the merchant-authoritative CheckoutSession.

- If the durable outcome is already terminal, Mino replays the stored sanitized merchant response and repairs Redis commit/release state idempotently.
- If the merchant CheckoutSession is `completed`, Mino resolves the durable outcome to `SUCCEEDED`, commits the reservation, and returns a replayed success without calling the merchant completion endpoint again.
- If the merchant session is canceled/cancelled, Mino resolves it to `FAILED_DEFINITIVE` and releases the reservation.
- Otherwise the reservation hold is extended and Mino returns `PAYMENT_OUTCOME_PENDING` with HTTP 409 and `Retry-After`.

## Idempotency binding

The completion idempotency digest binds:

- merchant ID;
- checkout-session ID;
- a one-way SHA-256 digest of the complete raw request body, so different payment credentials cannot collapse after audit redaction;
- merchant identity;
- currency and authoritative total;
- authorization-relevant cart lines, quantities, categories, SKUs, and prices.

Mino does not persist the raw payment request body in `PaymentOutcome`.

## Remaining work

The current slice provides request-driven reconciliation. A production deployment still needs a background reconciliation worker and a server-side merchant credential provider so unresolved outcomes can be reconciled without waiting for the agent to retry. The 26-hour reservation hold is a safety window, not proof of settlement, and unresolved outcomes must not be silently released when that operational window expires.
