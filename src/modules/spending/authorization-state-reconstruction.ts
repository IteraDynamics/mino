import type { QueryResultRow } from "pg";
import type {
  AuthorizationReservations,
  ReservationAttemptInput,
  ReservationAttemptResult,
  RedisScriptClient,
} from "./authorization-reservation.service.js";
import { ReservationStatus } from "./authorization-reservation.service.js";
import type { DurableSpendReservationStore } from "./postgres-spend-reservation.store.js";

const MAX_SAFE_MINOR_UNITS = BigInt(Number.MAX_SAFE_INTEGER);
const DEFAULT_ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RESERVATION_TTL_MS = 5 * 60 * 1000;
const DEFAULT_RECONCILIATION_HOLD_MS = 26 * 60 * 60 * 1000;
const DEFAULT_DETAIL_TTL_MS = 50 * 60 * 60 * 1000;
const MIN_VELOCITY_WINDOW_MS = 60_000;

export interface AuthorizationStateSqlClient {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ readonly rows: R[]; readonly rowCount: number | null }>;
}

export interface AuthorizationStateReconstructorOptions {
  readonly rollingWindowMs?: number;
  readonly reconciliationHoldMs?: number;
  readonly detailTtlMs?: number;
  readonly keyPrefix?: string;
}

export interface AuthorizationStateReconstructionResult {
  readonly mandateId: string;
  readonly committed: number;
  readonly unresolved: number;
  readonly attempts: number;
}

interface MandateRow extends QueryResultRow {
  id: string;
  crossMerchantWindowSecs: number;
}

interface DurableMoneyRow extends QueryResultRow {
  reservationId: string;
  amountMinor: string;
  currency: string;
  stateKind: "COMMITTED" | "RESERVED";
  eventAt: Date | null;
}

interface AttemptRow extends QueryResultRow {
  merchantDomain: string;
  sourceId: string;
  occurredAt: Date;
}

interface MandateIdRow extends QueryResultRow {
  mandateId: string;
}

interface RestorableState {
  readonly kind: "COMMITTED" | "RESERVED";
  readonly reservationId: string;
  readonly amountMinor: string;
  readonly currency: string;
  readonly eventAt: number;
}

interface RestorableAttempt {
  readonly merchantDomain: string;
  readonly sourceId: string;
  readonly occurredAt: number;
}

export class AuthorizationStateUnavailableError extends Error {
  public constructor(message = "Redis authorization state is not reconstructed") {
    super(message);
    this.name = "AuthorizationStateUnavailableError";
  }
}

/**
 * Rebuilds the monetary and velocity state Redis needs for authorization from
 * durable PostgreSQL facts. The per-mandate ready marker is written only after
 * the entire reconstruction script completes atomically.
 *
 * SpendReservation closes the pre-dispatch reservation gap for new requests.
 * PaymentOutcome remains a recovery fallback for legacy rows and is authoritative
 * for unresolved or succeeded payments that crossed the merchant-dispatch boundary.
 * Recent AuditLog and PaymentOutcome rows restore machine-attempt velocity.
 */
export class RedisAuthorizationStateReconstructor {
  private readonly rollingWindowMs: number;
  private readonly reconciliationHoldMs: number;
  private readonly detailTtlMs: number;
  private readonly keyPrefix: string;
  private readonly inFlight = new Map<string, Promise<AuthorizationStateReconstructionResult>>();

  public constructor(
    private readonly sql: AuthorizationStateSqlClient,
    private readonly redis: RedisScriptClient,
    options: AuthorizationStateReconstructorOptions = {},
  ) {
    this.rollingWindowMs = options.rollingWindowMs ?? DEFAULT_ROLLING_WINDOW_MS;
    this.reconciliationHoldMs =
      options.reconciliationHoldMs ?? DEFAULT_RECONCILIATION_HOLD_MS;
    this.detailTtlMs = options.detailTtlMs ?? DEFAULT_DETAIL_TTL_MS;
    this.keyPrefix = options.keyPrefix ?? "mino:v1:auth";
  }

  public async reconstructAll(now: Date): Promise<AuthorizationStateReconstructionResult[]> {
    const rollingCutoff = new Date(now.getTime() - this.rollingWindowMs);
    const result = await this.sql.query<MandateIdRow>(
      `select "id"::text as "mandateId"
         from "AgentMandate"
        where "status" = 'ACTIVE'
          and "expiresAt" > $1
       union
       select distinct "mandateId"::text as "mandateId"
         from "SpendReservation"
        where ("status" = 'RESERVED' and "expiresAt" > $1)
           or ("status" = 'COMMITTED' and "committedAt" >= $2)
       union
       select distinct "mandateId"::text as "mandateId"
         from "PaymentOutcome"
        where "status" in ('FORWARDING', 'UNKNOWN')
           or ("status" = 'SUCCEEDED' and "resolvedAt" >= $2)`,
      [now, rollingCutoff],
    );

    const rebuilt: AuthorizationStateReconstructionResult[] = [];
    for (const row of result.rows) {
      rebuilt.push(await this.ensureMandateReady(row.mandateId, now));
    }
    return rebuilt;
  }

  public async isMandateReady(mandateId: string): Promise<boolean> {
    const result = await this.redis.eval(CHECK_RECONSTRUCTION_MARKER_SCRIPT, {
      keys: [this.markerKey(mandateId)],
      arguments: [],
    });
    return result === 1 || result === "1";
  }

  public async ensureMandateReady(
    mandateId: string,
    now: Date,
  ): Promise<AuthorizationStateReconstructionResult> {
    if (await this.isMandateReady(mandateId)) {
      return { mandateId, committed: 0, unresolved: 0, attempts: 0 };
    }
    return this.reconstructMandate(mandateId, now);
  }

  public async reconstructMandate(
    mandateId: string,
    now: Date,
    force = false,
  ): Promise<AuthorizationStateReconstructionResult> {
    if (!force) {
      const existing = this.inFlight.get(mandateId);
      if (existing) {
        return existing;
      }
    }

    const work = this.reconstructMandateInternal(mandateId, now);
    if (!force) {
      this.inFlight.set(mandateId, work);
    }
    try {
      return await work;
    } finally {
      if (!force && this.inFlight.get(mandateId) === work) {
        this.inFlight.delete(mandateId);
      }
    }
  }

  private async reconstructMandateInternal(
    mandateId: string,
    now: Date,
  ): Promise<AuthorizationStateReconstructionResult> {
    const mandateResult = await this.sql.query<MandateRow>(
      `select "id"::text as "id", "crossMerchantWindowSecs"
         from "AgentMandate"
        where "id" = $1::uuid`,
      [mandateId],
    );
    const mandate = mandateResult.rows[0];
    if (!mandate) {
      throw new AuthorizationStateUnavailableError(`Mandate ${mandateId} does not exist`);
    }

    const rollingCutoff = new Date(now.getTime() - this.rollingWindowMs);
    const attemptWindowMs = Math.max(
      MIN_VELOCITY_WINDOW_MS,
      mandate.crossMerchantWindowSecs * 1000,
    );
    const attemptCutoff = new Date(now.getTime() - attemptWindowMs);

    const [moneyResult, attemptsResult] = await Promise.all([
      this.sql.query<DurableMoneyRow>(
        `select s."id"::text as "reservationId",
                s."amountMinor"::text as "amountMinor",
                s."currency",
                'COMMITTED'::text as "stateKind",
                s."committedAt" as "eventAt"
           from "SpendReservation" s
          where s."mandateId" = $1::uuid
            and s."status" = 'COMMITTED'
            and s."committedAt" >= $2
         union all
         select s."id"::text as "reservationId",
                s."amountMinor"::text as "amountMinor",
                s."currency",
                'RESERVED'::text as "stateKind",
                s."expiresAt" as "eventAt"
           from "SpendReservation" s
          where s."mandateId" = $1::uuid
            and s."status" = 'RESERVED'
            and s."expiresAt" > $3
            and not exists (
              select 1 from "PaymentOutcome" p
               where p."reservationId" = s."id"::text
            )
         union all
         select p."reservationId",
                p."amountMinor"::text as "amountMinor",
                p."currency",
                'RESERVED'::text as "stateKind",
                null::timestamptz as "eventAt"
           from "PaymentOutcome" p
          where p."mandateId" = $1::uuid
            and p."status" in ('FORWARDING', 'UNKNOWN')
         union all
         select p."reservationId",
                p."amountMinor"::text as "amountMinor",
                p."currency",
                'COMMITTED'::text as "stateKind",
                p."resolvedAt" as "eventAt"
           from "PaymentOutcome" p
          where p."mandateId" = $1::uuid
            and p."status" = 'SUCCEEDED'
            and p."resolvedAt" >= $2
            and not exists (
              select 1 from "SpendReservation" s
               where s."id"::text = p."reservationId"
                 and s."status" = 'COMMITTED'
                 and s."committedAt" >= $2
            )`,
        [mandateId, rollingCutoff, now],
      ),
      this.sql.query<AttemptRow>(
        `select "merchantDomain",
                'payment:' || "id"::text as "sourceId",
                "createdAt" as "occurredAt"
           from "PaymentOutcome"
          where "mandateId" = $1::uuid
            and "createdAt" >= $2
         union all
         select audit_attempt."merchantDomain",
                audit_attempt."sourceId",
                audit_attempt."occurredAt"
           from (
             select distinct on (coalesce(a."reservationId", a."requestId"::text))
                    a."merchantDomain",
                    'audit:' || coalesce(a."reservationId", a."requestId"::text) as "sourceId",
                    a."timestamp" as "occurredAt"
               from "AuditLog" a
              where a."mandateId" = $1::uuid
                and a."operation" = 'COMPLETE_CHECKOUT'
                and a."timestamp" >= $2
                and (
                  a."reservationId" is null
                  or not exists (
                    select 1
                      from "PaymentOutcome" p
                     where p."reservationId" = a."reservationId"
                  )
                )
              order by coalesce(a."reservationId", a."requestId"::text), a."timestamp" asc
           ) audit_attempt`,
        [mandateId, attemptCutoff],
      ),
    ]);

    const seenReservations = new Set<string>();
    const states: RestorableState[] = moneyResult.rows.map((row) => {
      if (seenReservations.has(row.reservationId)) {
        throw new AuthorizationStateUnavailableError(
          `Durable authorization history contains conflicting state for reservation ${row.reservationId}`,
        );
      }
      seenReservations.add(row.reservationId);
      const amountMinor = assertRedisSafeAmount(row.amountMinor, row.reservationId);
      if (row.stateKind === "COMMITTED") {
        if (!row.eventAt) {
          throw new AuthorizationStateUnavailableError(
            `Committed reservation ${row.reservationId} is missing its commit timestamp`,
          );
        }
        return {
          kind: "COMMITTED",
          reservationId: row.reservationId,
          amountMinor,
          currency: row.currency.toUpperCase(),
          eventAt: row.eventAt.getTime(),
        };
      }
      return {
        kind: "RESERVED",
        reservationId: row.reservationId,
        amountMinor,
        currency: row.currency.toUpperCase(),
        eventAt: row.eventAt?.getTime() ?? now.getTime() + this.reconciliationHoldMs,
      };
    });

    const attempts: RestorableAttempt[] = attemptsResult.rows.map((row) => ({
      merchantDomain: canonicalizeMerchant(row.merchantDomain),
      sourceId: row.sourceId,
      occurredAt: row.occurredAt.getTime(),
    }));

    const base = this.baseKey(mandateId);
    const detailKeys = states.map(
      (state) => `${base}:reservation:${state.reservationId}`,
    );
    const response = await this.redis.eval(RESTORE_AUTHORIZATION_STATE_SCRIPT, {
      keys: [
        `${base}:committed`,
        `${base}:reservations`,
        `${base}:attempts`,
        this.markerKey(mandateId),
        ...detailKeys,
      ],
      arguments: [
        String(now.getTime()),
        String(this.rollingWindowMs),
        String(attemptWindowMs),
        String(this.detailTtlMs),
        JSON.stringify(states),
        JSON.stringify(attempts),
      ],
    });

    if (response === "CONFLICT") {
      throw new AuthorizationStateUnavailableError(
        `Redis state conflicts with durable payment state for mandate ${mandateId}`,
      );
    }
    if (response !== 1 && response !== "1") {
      throw new AuthorizationStateUnavailableError(
        `Redis authorization state reconstruction failed for mandate ${mandateId}`,
      );
    }

    return {
      mandateId,
      committed: states.filter((state) => state.kind === "COMMITTED").length,
      unresolved: states.filter((state) => state.kind === "RESERVED").length,
      attempts: attempts.length,
    };
  }

  private baseKey(mandateId: string): string {
    return `${this.keyPrefix}:{${mandateId}}`;
  }

  private markerKey(mandateId: string): string {
    return `${this.baseKey(mandateId)}:state-reconstructed`;
  }
}

/**
 * Production reservation boundary. It combines Redis's atomic enforcement with
 * a PostgreSQL reservation mirror and a per-mandate reconstruction guard.
 */
export class ReconstructingAuthorizationReservations implements AuthorizationReservations {
  public constructor(
    private readonly inner: AuthorizationReservations,
    private readonly reconstructor: RedisAuthorizationStateReconstructor,
    private readonly clock: () => Date = () => new Date(),
    private readonly durableReservations?: DurableSpendReservationStore,
  ) {}

  public async tryReserve(input: ReservationAttemptInput): Promise<ReservationAttemptResult> {
    await this.reconstructor.ensureMandateReady(input.mandate.id, input.now);
    const result = await this.inner.tryReserve(input);

    if (result.status === ReservationStatus.RESERVED && result.reservationId) {
      if (this.durableReservations) {
        try {
          await this.durableReservations.recordReserved({
            id: result.reservationId,
            organizationId: input.mandate.organizationId,
            userId: input.mandate.userId,
            agentId: input.mandate.agentId,
            mandateId: input.mandate.id,
            idempotencyKey: input.idempotencyKey,
            merchantDomain: input.merchantDomain,
            currency: input.amount.currency,
            amountMinor: input.amount.minorUnits,
            reservedAt: input.now,
            expiresAt: new Date(input.now.getTime() + DEFAULT_RESERVATION_TTL_MS),
          });
        } catch (error) {
          await this.inner.release(input.mandate.id, result.reservationId).catch(() => undefined);
          throw error;
        }
      }

      if (!(await this.reconstructor.isMandateReady(input.mandate.id))) {
        if (this.durableReservations) {
          await this.durableReservations.markReleased(result.reservationId, input.now).catch(() => undefined);
        }
        throw new AuthorizationStateUnavailableError(
          `Redis authorization state was lost while processing mandate ${input.mandate.id}`,
        );
      }
      return result;
    }

    await this.assertStillReady(input.mandate.id);
    return result;
  }

  public async commit(mandateId: string, reservationId: string, now: Date): Promise<boolean> {
    await this.reconstructor.ensureMandateReady(mandateId, now);
    if (this.durableReservations) {
      await this.durableReservations.markCommitted(reservationId, now);
    }
    let committed = await this.inner.commit(mandateId, reservationId, now);
    if (!committed) {
      await this.reconstructor.reconstructMandate(mandateId, now, true);
      committed = await this.inner.commit(mandateId, reservationId, now);
    }
    await this.assertStillReady(mandateId);
    return committed;
  }

  public async release(mandateId: string, reservationId: string): Promise<boolean> {
    const now = this.clock();
    await this.reconstructor.ensureMandateReady(mandateId, now);
    if (this.durableReservations) {
      await this.durableReservations.markReleased(reservationId, now);
    }
    const released = await this.inner.release(mandateId, reservationId);
    await this.assertStillReady(mandateId);
    return released;
  }

  public async releaseForApproval(
    mandateId: string,
    reservationId: string,
    idempotencyKey: string,
  ): Promise<boolean> {
    const now = this.clock();
    await this.reconstructor.ensureMandateReady(mandateId, now);
    if (this.durableReservations) {
      await this.durableReservations.markReleased(reservationId, now);
    }
    const released = await this.inner.releaseForApproval(mandateId, reservationId, idempotencyKey);
    await this.assertStillReady(mandateId);
    return released;
  }

  public async holdForReconciliation(
    mandateId: string,
    reservationId: string,
    now: Date,
  ): Promise<boolean> {
    await this.reconstructor.ensureMandateReady(mandateId, now);
    if (this.durableReservations) {
      await this.durableReservations.extendHold(
        reservationId,
        new Date(now.getTime() + DEFAULT_RECONCILIATION_HOLD_MS),
        now,
      );
    }
    let held = await this.inner.holdForReconciliation(mandateId, reservationId, now);
    if (!held) {
      await this.reconstructor.reconstructMandate(mandateId, now, true);
      held = await this.inner.holdForReconciliation(mandateId, reservationId, now);
    }
    await this.assertStillReady(mandateId);
    return held;
  }

  private async assertStillReady(mandateId: string): Promise<void> {
    if (!(await this.reconstructor.isMandateReady(mandateId))) {
      throw new AuthorizationStateUnavailableError(
        `Redis authorization state was lost while processing mandate ${mandateId}`,
      );
    }
  }
}

function assertRedisSafeAmount(value: string, reservationId: string): string {
  let amount: bigint;
  try {
    amount = BigInt(value);
  } catch {
    throw new AuthorizationStateUnavailableError(
      `Durable payment reservation ${reservationId} has an invalid amount`,
    );
  }
  if (amount < 0n || amount > MAX_SAFE_MINOR_UNITS) {
    throw new AuthorizationStateUnavailableError(
      `Durable payment reservation ${reservationId} exceeds Redis exact-integer range`,
    );
  }
  return amount.toString(10);
}

function canonicalizeMerchant(domain: string): string {
  const normalized = domain.trim().toLowerCase().replace(/\.$/, "");
  if (!normalized || normalized.includes("|") || normalized.includes("://") || normalized.includes("/")) {
    throw new AuthorizationStateUnavailableError(
      "Durable authorization history contains an invalid merchant domain",
    );
  }
  return normalized;
}

export const CHECK_RECONSTRUCTION_MARKER_SCRIPT = String.raw`
return redis.call('GET', KEYS[1]) == '1' and 1 or 0
`;

export const RESTORE_AUTHORIZATION_STATE_SCRIPT = String.raw`
local now = tonumber(ARGV[1])
local rolling_window = tonumber(ARGV[2])
local attempt_window = tonumber(ARGV[3])
local detail_ttl = tonumber(ARGV[4])
local states = cjson.decode(ARGV[5])
local attempts = cjson.decode(ARGV[6])

for index, state in ipairs(states) do
  local detail_key = KEYS[4 + index]
  local amount = tonumber(state.amountMinor)
  if not amount then
    redis.call('DEL', KEYS[4])
    return 'CONFLICT'
  end
  if state.kind == 'RESERVED' then
    local existing_raw = redis.call('GET', detail_key)
    if existing_raw then
      local existing = cjson.decode(existing_raw)
      if existing.status == 'COMMITTED' then
        redis.call('DEL', KEYS[4])
        return 'CONFLICT'
      end
    end
  elseif state.kind ~= 'COMMITTED' then
    redis.call('DEL', KEYS[4])
    return 'CONFLICT'
  end
end

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - rolling_window)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now - attempt_window)

for index, state in ipairs(states) do
  local detail_key = KEYS[4 + index]
  local member = state.reservationId .. '|' .. state.amountMinor
  local amount = tonumber(state.amountMinor)

  if state.kind == 'COMMITTED' then
    redis.call('ZREM', KEYS[2], member)
    redis.call('ZADD', KEYS[1], tonumber(state.eventAt), member)
    local detail = cjson.encode({
      reservation_id = state.reservationId,
      reservation_member = member,
      amount_minor = amount,
      currency = state.currency,
      status = 'COMMITTED',
      committed_at = tonumber(state.eventAt),
      reconstructed = true
    })
    redis.call('SET', detail_key, detail, 'PX', detail_ttl)
  else
    local expires_at = tonumber(state.eventAt)
    local existing_score = redis.call('ZSCORE', KEYS[2], member)
    if existing_score and tonumber(existing_score) > expires_at then
      expires_at = tonumber(existing_score)
    end
    redis.call('ZADD', KEYS[2], expires_at, member)
    local detail = cjson.encode({
      reservation_id = state.reservationId,
      reservation_member = member,
      amount_minor = amount,
      currency = state.currency,
      status = 'RESERVED',
      expires_at = expires_at,
      reconciliation_hold = true,
      reconstructed = true
    })
    redis.call('SET', detail_key, detail, 'PX', detail_ttl)
  end
end

for _, attempt in ipairs(attempts) do
  local member = attempt.merchantDomain .. '|' .. attempt.sourceId .. '|' .. tostring(attempt.occurredAt)
  redis.call('ZADD', KEYS[3], tonumber(attempt.occurredAt), member)
end

if #states > 0 then
  redis.call('PEXPIRE', KEYS[1], rolling_window + 60000)
  redis.call('PEXPIRE', KEYS[2], rolling_window + detail_ttl)
end
if #attempts > 0 then
  redis.call('PEXPIRE', KEYS[3], attempt_window + 60000)
end

redis.call('SET', KEYS[4], '1')
return 1
`;
