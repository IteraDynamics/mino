# Reservation idempotency lifecycle

Mino separates the lifetime of an idempotency key from the lifetime of a temporary pre-dispatch spend reservation.

An idempotency key is retained substantially longer than the normal reservation TTL so a caller cannot reuse the same key with a different request body merely because the temporary allowance hold expired. At the same time, an expired reservation must not be replayed as though the allowance were still held.

## Production behavior

Before the existing Redis reservation engine runs, production executes a small mandate-local preflight against the reservation sorted set and idempotency record using the same logical request timestamp.

For an idempotency record whose status is `RESERVED`:

- If the stored request digest differs from the incoming digest, the preflight leaves the record untouched. The normal reservation engine then returns `IDEMPOTENCY_CONFLICT`.
- If the digest matches and the referenced reservation is still active after the request timestamp, the record is left untouched. The normal engine replays the original reservation ID without creating another allowance hold.
- If the digest matches but the referenced reservation is no longer active, only the stale idempotency result is removed. The normal reservation engine then evaluates the request again against current rolling spend, active reservations, velocity, cross-merchant controls, and current limits.

This means reservation expiry does not weaken request-identity protection, but it also does not preserve an obsolete authorization result.

## Durable reservation mirror

The PostgreSQL `SpendReservation` mirror follows the same lifetime semantics. Replaying the same still-active reservation does not move `reservedAt` forward and does not extend `expiresAt`. A retry therefore cannot keep a temporary pre-dispatch hold alive merely by repeatedly sending the same idempotency key.

When an old reservation is actually released or expired, a later matching retry may create a fresh reservation ID under the same idempotency key after the Redis preflight has determined that no active hold remains. The fresh reservation must pass the normal current-state authorization checks and is durably mirrored before payment processing can advance.

A durable `COMMITTED` reservation cannot regress back to `RESERVED`.

## Scope

This logic does not alter payment-outcome reconciliation. Once a request has crossed the durable `PaymentOutcome` boundary, the payment-outcome state remains authoritative and same-idempotency retries follow the existing reconciliation-safe path rather than blindly issuing another payment.

The correct claim is therefore: **idempotency identity survives reservation expiry, while temporary authorization does not.**