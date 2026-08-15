import type {
  AuthorizationReservations,
  RedisScriptClient,
  ReservationAttemptInput,
  ReservationAttemptResult,
} from "./authorization-reservation.service.js";

/**
 * Removes only stale RESERVED idempotency results before the normal reservation
 * engine evaluates the request. Active reservations continue to replay exactly as
 * before; expired matching retries are re-evaluated against current spend/velocity.
 * A changed request digest is never cleared, preserving the full idempotency-conflict
 * window even after the original reservation expires.
 *
 * The guard uses the same mandate-local Redis Cluster hash slot as the reservation
 * engine. Request time is supplied by the caller so the stale check and the
 * subsequent reservation evaluation use the same logical timestamp.
 */
export class ExpiryAwareAuthorizationReservations implements AuthorizationReservations {
  public constructor(
    private readonly inner: AuthorizationReservations,
    private readonly redis: RedisScriptClient,
    private readonly keyPrefix = "mino:v1:auth",
  ) {}

  public async tryReserve(input: ReservationAttemptInput): Promise<ReservationAttemptResult> {
    const base = `${this.keyPrefix}:{${input.mandate.id}}`;
    await this.redis.eval(CLEAR_STALE_RESERVED_IDEMPOTENCY_SCRIPT, {
      keys: [
        `${base}:reservations`,
        `${base}:idem:${encodeURIComponent(input.idempotencyKey)}`,
      ],
      arguments: [String(input.now.getTime()), input.requestDigest],
    });
    return this.inner.tryReserve(input);
  }

  public commit(mandateId: string, reservationId: string, now: Date): Promise<boolean> {
    return this.inner.commit(mandateId, reservationId, now);
  }

  public release(mandateId: string, reservationId: string): Promise<boolean> {
    return this.inner.release(mandateId, reservationId);
  }

  public releaseForApproval(
    mandateId: string,
    reservationId: string,
    idempotencyKey: string,
  ): Promise<boolean> {
    return this.inner.releaseForApproval(mandateId, reservationId, idempotencyKey);
  }

  public holdForReconciliation(
    mandateId: string,
    reservationId: string,
    now: Date,
  ): Promise<boolean> {
    return this.inner.holdForReconciliation(mandateId, reservationId, now);
  }
}

export const CLEAR_STALE_RESERVED_IDEMPOTENCY_SCRIPT = String.raw`
local now = tonumber(ARGV[1])
local request_digest = ARGV[2]
local existing_raw = redis.call('GET', KEYS[2])
if not existing_raw then
  return 0
end

local existing = cjson.decode(existing_raw)
if existing.request_digest ~= request_digest then
  return 0
end
if existing.status ~= 'RESERVED' or not existing.reservation_id then
  return 0
end

local prefix = existing.reservation_id .. '|'
local active_members = redis.call('ZRANGEBYSCORE', KEYS[1], '(' .. tostring(now), '+inf')
for _, member in ipairs(active_members) do
  if string.sub(member, 1, string.len(prefix)) == prefix then
    return 0
  end
end

redis.call('DEL', KEYS[2])
return 1
`;