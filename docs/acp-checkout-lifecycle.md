# ACP checkout lifecycle boundary

Mino is pinned to Agentic Commerce Protocol `API-Version: 2026-04-17` for its current checkout integration.

The checkout proxy exposes four lifecycle stages with two different authorization meanings:

| Operation | Mino route | Merchant operation | Spend reservation | Payment delegation |
| --- | --- | --- | --- | --- |
| Retrieve | `GET /v1/acp/:merchantId/checkout_sessions/:checkoutSessionId` | `GET /checkout_sessions/{id}` | No | No |
| Update | `POST /v1/acp/:merchantId/checkout_sessions/:checkoutSessionId` | `POST /checkout_sessions/{id}` | No | No |
| Cancel | `POST /v1/acp/:merchantId/checkout_sessions/:checkoutSessionId/cancel` | `POST /checkout_sessions/{id}/cancel` | No | No |
| Complete | `POST /v1/acp/:merchantId/checkout_sessions/:checkoutSessionId/complete` | `POST /checkout_sessions/{id}/complete` | Yes, when policy allows | Yes, only after final ALLOW |

## Lifecycle access versus payment authority

Retrieve, update, and cancel are authenticated control operations. They require a valid Mino mandate token, a signed agent request, the pinned ACP version, and a registered active HTTPS merchant target. They are audited through the same tamper-evident ledger used by the payment path.

They deliberately do not depend on:

- `AuthorizationReservations`
- `SpendReservation`
- `PaymentOutcome`
- human approval
- delegation-assertion issuance

Their returned Mino decision is therefore an access decision, not a spend approval. It has zero requested/policy amount, no `approvedAmount`, and `eligibleForDelegationAssertion=false`.

Only checkout completion enters the spend-reservation and payment-outcome machinery.

## Signed agent requests

All lifecycle requests use the existing Ed25519 agent-proof format, which binds method, exact Mino path, timestamp, nonce, mandate-token JTI digest, ACP version, idempotency value, and canonical body digest.

ACP retrieval does not require a merchant `Idempotency-Key`. Mino therefore binds the retrieval proof to an empty idempotency string and does not forward an `Idempotency-Key` header upstream.

Update and cancel require an `Idempotency-Key`. That exact value is included in the signed agent request and forwarded to the registered merchant.

A body, path, method, API-version, agent identity, or idempotency change invalidates the signature rather than being silently accepted.

## Merchant boundary

Agents still choose only a server-registered merchant ID. Mino resolves the configured endpoint, requires it to be active, requires HTTPS, and requires the configured base URL hostname to exactly match the registered merchant domain. Lifecycle operations do not accept arbitrary forwarding URLs.

The merchant bearer credential supplied on the incoming ACP request is forwarded only to the registered merchant target. Mino-specific mandate and agent-proof headers are control-plane inputs and are not used as a substitute for merchant authentication.

## Response and failure behavior

Successful merchant lifecycle responses are returned with the Mino access decision and merchant response body.

Merchant non-2xx lifecycle responses are recorded in the audit ledger before Mino returns the existing safe upstream-error envelope. Authentication and protocol failures occur before merchant forwarding.

## Security claim

The lifecycle expansion does not broaden payment authority. It adds authenticated, registered-merchant, signed-request, audited cart-management operations while keeping **payment-bearing checkout completion as the only route that can reserve spend or mint a payment delegation assertion**.