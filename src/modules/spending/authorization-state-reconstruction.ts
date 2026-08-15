import type { QueryResultRow } from "pg";
import type {
  AuthorizationReservations,
  ReservationAttemptInput,
  ReservationAttemptResult,
  RedisScriptClient,
} from "./authorization-reservation.service.js";

const MAX_SAFE_MINOR_UNITS = BigInt(Number.MAX_SAFE_INTEGER);
const DEFAULT_ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;
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

interface PaymentStateRow extends QueryResultRow {
  reservationId: string;
  amountMinor: string;
  currency: string;
  status: "FORWARDING" | "UNKNOWN" | "SUCCEEDED";
  resolvedAt: Date | null;
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
 * PaymentOutcome is authoritative for money that crossed the merchant-dispatch
 * boundary. Recent AuditLog and PaymentOutcome rows restore machine-attempt
 * velocity. Redis remains the fast enforcement layer; PostgreSQL is the recovery
 * source after a cold Redis loss.
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

    const [paymentStatesResult, attemptsResult] = await Promise.all([
      this.sql.query<PaymentStateRow>(
        `select "reservationId",
                "amountMinor"::text as "amountMinor",
                "currency",
                "status",
                "resolvedAt"
           from "PaymentOutcome"
          where "mandateId" = $1::uuid
            and (
              "status" in ('FORWARDING', 'UNKNOWN')
              or ("status" = 'SUCCEEDED' and "resolvedAt" >= $2)
            )
          order by "reservationId"`,
        [mandateId, rollingCutoff],
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

    const states: RestorableState[] = paymentStatesResult.rows.map((row) => {
      const amountMinor = assertRedisSafeAmount(row.amountMinor, row.reservationId);
      if (row.status === "SUCCEEDED") {
        if (!row.resolvedAt) {
          throw new AuthorizationStateUnavailableError(
            `Succeeded payment reservation ${row.reservationId} is missing resolvedAt`,
          );
        }
        return {
          kind: "COMMITTED",
          reservationId: row.reservationId,
          amountMinor,
          currency: row.currency.toUpperCase(),
          eventAt: row.resolvedAt.getTime(),
        };
      }
      return {
        kind: "RESERVED",
        reservationId: row.reservationId,
        amountMinor,
        currency: row.currency.toUpperCase(),
        eventAt: now.getTime() + this.reconciliationHoldMs,
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
 * Guards every production reservation lifecycle operation with the durable-state
 * recovery marker. A full Redis loss removes the marker; the next operation
 * reconstructs before it can authorize or finalize spend.
 */
export class ReconstructingAuthorizationReservations implements AuthorizationReservations {
  public constructor(
    private readonly inner: AuthorizationReservations,
    private readonly reconstructor: RedisAuthorizationStateReconstructor,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async tryReserve(input: ReservationAttemptInput): Promise<ReservationAttemptResult> {
    return this.guard(input.mandate.id, input.now, () => this.inner.tryReserve(input));
  }

  public async commit(mandateId: string, reservationId: string, now: Date): Promise<boolean> {
    await this.reconstructor.ensureMandateReady(mandateId, now);
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
    return this.guard(mandateId, now, () => this.inner.release(mandateId, reservationId));
  }

  public async releaseForApproval(
    mandateId: string,
    reservationId: string,
    idempotencyKey: string,
  ): Promise<boolean> {
    const now = this.clock();
    return this.guard(mandateId, now, () =>
      this.inner.releaseForApproval(mandateId, reservationId, idempotencyKey),
    );
  }

  public async holdForReconciliation(
    mandateId: string,
    reservationId: string,
    now: Date,
  ): Promise<boolean> {
    await this.reconstructor.ensureMandateReady(mandateId, now);
    let held = await this.inner.holdForReconciliation(mandateId, reservationId, now);
    if (!held) {
      await this.reconstructor.reconstructMandate(mandateId, now, true);
      held = await this.inner.holdForReconciliation(mandateId, reservationId, now);
    }
    await this.assertStillReady(mandateId);
    return held;
  }

  private async guard<T>(mandateId: string, now: Date, operation: () => Promise<T>): Promise<T> {
    await this.reconstructor.ensureMandateReady(mandateId, now);
    const result = await operation();
    await this.assertStillReady(mandateId);
    return result;
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

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - rolling_window)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now - attempt_window)

for index, state in ipairs(states) do
  local detail_key = KEYS[4 + index]
  local member = state.reservationId .. '|' .. state.amountMinor
  local amount = tonumber(state.amountMinor)
  if not amount then
    return 'CONFLICT'
  end

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
  elseif state.kind == 'RESERVED' then
    local existing_raw = redis.call('GET', detail_key)
    if existing_raw then
      local existing = cjson.decode(existing_raw)
      if existing.status == 'COMMITTED' then
        return 'CONFLICT'
      end
    end
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
  else
    return 'CONFLICT'
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
