import type { AgentSpendMandate } from "../../domain/mandates/mandate.types.js";
import type { Money } from "../../domain/money.js";
import type { SpendState, VelocityState } from "../../domain/evaluation/evaluation.types.js";

const MAX_SAFE_MINOR_UNITS = BigInt(Number.MAX_SAFE_INTEGER);
const DEFAULT_ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RESERVATION_TTL_MS = 5 * 60 * 1000;
const DEFAULT_IDEMPOTENCY_TTL_MS = 25 * 60 * 60 * 1000;
const DEFAULT_RECONCILIATION_HOLD_MS = 26 * 60 * 60 * 1000;

export interface RedisScriptClient {
  eval(
    script: string,
    options: {
      readonly keys: readonly string[];
      readonly arguments: readonly string[];
    },
  ): Promise<unknown>;
}

export enum ReservationStatus {
  RESERVED = "RESERVED",
  DAILY_LIMIT = "DAILY_LIMIT",
  RATE_LIMIT = "RATE_LIMIT",
  CROSS_MERCHANT_BURST = "CROSS_MERCHANT_BURST",
  IDEMPOTENCY_CONFLICT = "IDEMPOTENCY_CONFLICT",
}

export interface ReservationAttemptInput {
  readonly mandate: AgentSpendMandate;
  readonly amount: Money;
  readonly merchantDomain: string;
  readonly requestId: string;
  readonly reservationId: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly now: Date;
  readonly allowDailyLimitOverride?: boolean;
}

export interface ReservationAttemptResult {
  readonly status: ReservationStatus;
  readonly reservationId?: string;
  readonly spend: SpendState;
  readonly velocity: VelocityState;
  readonly replayed: boolean;
  readonly dailyLimitOverridden: boolean;
}

export interface AuthorizationReservations {
  tryReserve(input: ReservationAttemptInput): Promise<ReservationAttemptResult>;
  commit(mandateId: string, reservationId: string, now: Date): Promise<boolean>;
  release(mandateId: string, reservationId: string): Promise<boolean>;
  holdForReconciliation(mandateId: string, reservationId: string, now: Date): Promise<boolean>;
}

export interface AuthorizationReservationServiceOptions {
  readonly rollingWindowMs?: number;
  readonly reservationTtlMs?: number;
  readonly idempotencyTtlMs?: number;
  readonly reconciliationHoldMs?: number;
  readonly keyPrefix?: string;
}

export class AuthorizationReservationService implements AuthorizationReservations {
  private readonly rollingWindowMs: number;
  private readonly reservationTtlMs: number;
  private readonly idempotencyTtlMs: number;
  private readonly reconciliationHoldMs: number;
  private readonly keyPrefix: string;

  public constructor(
    private readonly redis: RedisScriptClient,
    options: AuthorizationReservationServiceOptions = {},
  ) {
    this.rollingWindowMs = options.rollingWindowMs ?? DEFAULT_ROLLING_WINDOW_MS;
    this.reservationTtlMs = options.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS;
    this.idempotencyTtlMs = options.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
    this.reconciliationHoldMs = options.reconciliationHoldMs ?? DEFAULT_RECONCILIATION_HOLD_MS;
    this.keyPrefix = options.keyPrefix ?? "mino:v1:auth";
  }

  public async tryReserve(input: ReservationAttemptInput): Promise<ReservationAttemptResult> {
    assertSafeAmount(input.amount.minorUnits);
    assertSafeAmount(input.mandate.rollingDailyLimitMinor);

    if (input.amount.currency.toUpperCase() !== input.mandate.currency.toUpperCase()) {
      throw new Error("Reservation amount must be normalized to mandate currency");
    }

    const keys = this.keys(input.mandate.id, input.idempotencyKey, input.reservationId);
    const response = await this.redis.eval(RESERVE_SCRIPT, {
      keys,
      arguments: [
        String(input.now.getTime()),
        String(this.rollingWindowMs),
        String(this.reservationTtlMs),
        String(this.idempotencyTtlMs),
        "60000",
        String(input.mandate.velocity.crossMerchantWindowSeconds * 1000),
        input.amount.minorUnits.toString(10),
        input.mandate.rollingDailyLimitMinor.toString(10),
        String(input.mandate.velocity.maxTransactionsPerMinute),
        String(input.mandate.velocity.maxDistinctMerchantsInWindow),
        canonicalizeMerchant(input.merchantDomain),
        input.requestId,
        input.reservationId,
        input.requestDigest,
        input.mandate.currency.toUpperCase(),
        input.allowDailyLimitOverride ? "1" : "0",
      ],
    });

    return parseReservationResponse(response, input.mandate.currency);
  }

  public async commit(
    mandateId: string,
    reservationId: string,
    now: Date,
  ): Promise<boolean> {
    const response = await this.redis.eval(COMMIT_SCRIPT, {
      keys: this.keys(mandateId, "unused", reservationId).slice(0, 3).concat(
        this.keys(mandateId, "unused", reservationId)[4]!,
      ),
      arguments: [String(now.getTime()), String(this.rollingWindowMs), String(this.idempotencyTtlMs)],
    });
    return response === 1 || response === "1";
  }

  public async release(mandateId: string, reservationId: string): Promise<boolean> {
    const response = await this.redis.eval(RELEASE_SCRIPT, {
      keys: [
        `${this.baseKey(mandateId)}:reservations`,
        `${this.baseKey(mandateId)}:reservation:${reservationId}`,
      ],
      arguments: [String(this.idempotencyTtlMs)],
    });
    return response === 1 || response === "1";
  }

  public async holdForReconciliation(
    mandateId: string,
    reservationId: string,
    now: Date,
  ): Promise<boolean> {
    const response = await this.redis.eval(HOLD_FOR_RECONCILIATION_SCRIPT, {
      keys: [
        `${this.baseKey(mandateId)}:reservations`,
        `${this.baseKey(mandateId)}:reservation:${reservationId}`,
      ],
      arguments: [
        String(now.getTime()),
        String(this.reconciliationHoldMs),
        String(this.rollingWindowMs),
        String(this.idempotencyTtlMs),
      ],
    });
    return response === 1 || response === "1";
  }

  private keys(mandateId: string, idempotencyKey: string, reservationId: string): string[] {
    const base = this.baseKey(mandateId);
    return [
      `${base}:committed`,
      `${base}:reservations`,
      `${base}:attempts`,
      `${base}:idem:${encodeURIComponent(idempotencyKey)}`,
      `${base}:reservation:${reservationId}`,
    ];
  }

  private baseKey(mandateId: string): string {
    return `${this.keyPrefix}:{${mandateId}}`;
  }
}

function parseReservationResponse(response: unknown, currency: string): ReservationAttemptResult {
  if (typeof response !== "string") {
    throw new Error("Unexpected Redis reservation response");
  }

  const parsed = JSON.parse(response) as {
    status: ReservationStatus;
    reservation_id?: string;
    committed_minor: number;
    reserved_minor: number;
    transactions_last_minute: number;
    distinct_merchants: number;
    merchant_domains: unknown;
    replayed?: boolean;
    daily_limit_overridden?: boolean;
  };

  if (!Object.values(ReservationStatus).includes(parsed.status)) {
    throw new Error("Redis returned an unknown reservation status");
  }

  const merchantDomains = parseMerchantDomains(parsed.merchant_domains);

  return {
    status: parsed.status,
    ...(parsed.reservation_id ? { reservationId: parsed.reservation_id } : {}),
    spend: {
      committedDailySpend: {
        currency: currency.toUpperCase(),
        minorUnits: BigInt(parsed.committed_minor),
      },
      reservedDailySpend: {
        currency: currency.toUpperCase(),
        minorUnits: BigInt(parsed.reserved_minor),
      },
    },
    velocity: {
      transactionsLastMinute: parsed.transactions_last_minute,
      distinctMerchantsInWindow: parsed.distinct_merchants,
      attemptedAmountLastMinute: {
        currency: currency.toUpperCase(),
        minorUnits: 0n,
      },
      merchantDomainsInWindow: merchantDomains,
    },
    replayed: parsed.replayed ?? false,
    dailyLimitOverridden: parsed.daily_limit_overridden ?? false,
  };
}

function parseMerchantDomains(value: unknown): string[] {
  if (Array.isArray(value)) {
    if (!value.every((entry) => typeof entry === "string")) {
      throw new Error("Redis returned invalid merchant domains");
    }
    return value;
  }

  if (
    value !== null &&
    typeof value === "object" &&
    Object.keys(value).length === 0
  ) {
    return [];
  }

  throw new Error("Redis returned invalid merchant domains");
}

function canonicalizeMerchant(domain: string): string {
  const normalized = domain.trim().toLowerCase().replace(/\.$/, "");
  if (!normalized || normalized.includes("|") || normalized.includes("://") || normalized.includes("/")) {
    throw new Error("Merchant domain is invalid for reservation enforcement");
  }
  return normalized;
}

function assertSafeAmount(value: bigint): void {
  if (value < 0n || value > MAX_SAFE_MINOR_UNITS) {
    throw new Error(
      `Redis authorization amounts must be between 0 and ${MAX_SAFE_MINOR_UNITS.toString(10)} minor units`,
    );
  }
}

export const RESERVE_SCRIPT = String.raw`
local now = tonumber(ARGV[1])
local rolling_window = tonumber(ARGV[2])
local reservation_ttl = tonumber(ARGV[3])
local idem_ttl = tonumber(ARGV[4])
local velocity_window = tonumber(ARGV[5])
local cross_window = tonumber(ARGV[6])
local amount = tonumber(ARGV[7])
local daily_limit = tonumber(ARGV[8])
local max_tx = tonumber(ARGV[9])
local max_merchants = tonumber(ARGV[10])
local merchant = ARGV[11]
local request_id = ARGV[12]
local reservation_id = ARGV[13]
local request_digest = ARGV[14]
local currency = ARGV[15]
local allow_daily_override = ARGV[16] == '1'

local existing = redis.call('GET', KEYS[4])
if existing then
  local decoded = cjson.decode(existing)
  if decoded.request_digest ~= request_digest then
    return cjson.encode({
      status = 'IDEMPOTENCY_CONFLICT',
      committed_minor = decoded.committed_minor or 0,
      reserved_minor = decoded.reserved_minor or 0,
      transactions_last_minute = decoded.transactions_last_minute or 0,
      distinct_merchants = decoded.distinct_merchants or 0,
      merchant_domains = decoded.merchant_domains or {},
      replayed = true,
      daily_limit_overridden = decoded.daily_limit_overridden or false
    })
  end
  if not (decoded.status == 'DAILY_LIMIT' and allow_daily_override) then
    decoded.replayed = true
    return cjson.encode(decoded)
  end
end

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - rolling_window)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
local longest_attempt_window = math.max(velocity_window, cross_window)
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now - longest_attempt_window)

local tx_count = redis.call('ZCOUNT', KEYS[3], now - velocity_window, now)
local cross_members = redis.call('ZRANGEBYSCORE', KEYS[3], now - cross_window, now)
local merchant_set = {}
local merchant_domains = {}
for _, member in ipairs(cross_members) do
  local delimiter = string.find(member, '|', 1, true)
  local domain = delimiter and string.sub(member, 1, delimiter - 1) or member
  if not merchant_set[domain] then
    merchant_set[domain] = true
    table.insert(merchant_domains, domain)
  end
end
local distinct = #merchant_domains
if not merchant_set[merchant] then
  distinct = distinct + 1
end

local attempt_member = merchant .. '|' .. request_id .. '|' .. tostring(now)
redis.call('ZADD', KEYS[3], now, attempt_member)
redis.call('PEXPIRE', KEYS[3], longest_attempt_window + 60000)

local function sum_amounts(key)
  local members = redis.call('ZRANGE', key, 0, -1)
  local total = 0
  for _, member in ipairs(members) do
    local delimiter = string.find(member, '|', 1, true)
    if delimiter then
      total = total + tonumber(string.sub(member, delimiter + 1))
    end
  end
  return total
end

local committed = sum_amounts(KEYS[1])
local reserved = sum_amounts(KEYS[2])
local exceeds_daily_limit = committed + reserved + amount > daily_limit

local status = 'RESERVED'
if tx_count >= max_tx then
  status = 'RATE_LIMIT'
elseif distinct > max_merchants then
  status = 'CROSS_MERCHANT_BURST'
elseif exceeds_daily_limit and not allow_daily_override then
  status = 'DAILY_LIMIT'
end

local result = {
  status = status,
  request_digest = request_digest,
  committed_minor = committed,
  reserved_minor = reserved,
  transactions_last_minute = tx_count,
  distinct_merchants = #merchant_domains,
  merchant_domains = merchant_domains,
  replayed = false,
  daily_limit_overridden = exceeds_daily_limit and allow_daily_override
}

if status == 'RESERVED' then
  local reservation_member = reservation_id .. '|' .. tostring(amount)
  local expires_at = now + reservation_ttl
  redis.call('ZADD', KEYS[2], expires_at, reservation_member)
  redis.call('PEXPIRE', KEYS[2], rolling_window + reservation_ttl)
  local detail = cjson.encode({
    reservation_id = reservation_id,
    reservation_member = reservation_member,
    amount_minor = amount,
    currency = currency,
    status = 'RESERVED',
    reserved_at = now,
    expires_at = expires_at,
    daily_limit_overridden = exceeds_daily_limit and allow_daily_override
  })
  redis.call('SET', KEYS[5], detail, 'PX', rolling_window + reservation_ttl)
  result.reservation_id = reservation_id
end

redis.call('SET', KEYS[4], cjson.encode(result), 'PX', idem_ttl)
return cjson.encode(result)
`;

export const COMMIT_SCRIPT = String.raw`
local now = tonumber(ARGV[1])
local rolling_window = tonumber(ARGV[2])
local detail_ttl = tonumber(ARGV[3])
local detail_raw = redis.call('GET', KEYS[4])
if not detail_raw then
  return 0
end
local detail = cjson.decode(detail_raw)
if detail.status == 'COMMITTED' then
  return 1
end
if detail.status ~= 'RESERVED' then
  return 0
end
if detail.expires_at and tonumber(detail.expires_at) <= now then
  redis.call('ZREM', KEYS[2], detail.reservation_member)
  detail.status = 'EXPIRED'
  detail.expired_at = now
  redis.call('SET', KEYS[4], cjson.encode(detail), 'PX', detail_ttl)
  return 0
end
redis.call('ZREM', KEYS[2], detail.reservation_member)
local committed_member = detail.reservation_id .. '|' .. tostring(detail.amount_minor)
redis.call('ZADD', KEYS[1], now, committed_member)
redis.call('PEXPIRE', KEYS[1], rolling_window + 60000)
detail.status = 'COMMITTED'
detail.committed_at = now
redis.call('SET', KEYS[4], cjson.encode(detail), 'PX', detail_ttl)
return 1
`;

export const RELEASE_SCRIPT = String.raw`
local detail_raw = redis.call('GET', KEYS[2])
if not detail_raw then
  return 0
end
local detail = cjson.decode(detail_raw)
if detail.status == 'RELEASED' then
  return 1
end
if detail.status ~= 'RESERVED' then
  return 0
end
redis.call('ZREM', KEYS[1], detail.reservation_member)
detail.status = 'RELEASED'
redis.call('SET', KEYS[2], cjson.encode(detail), 'PX', tonumber(ARGV[1]))
return 1
`;

export const HOLD_FOR_RECONCILIATION_SCRIPT = String.raw`
local now = tonumber(ARGV[1])
local hold_ms = tonumber(ARGV[2])
local rolling_window = tonumber(ARGV[3])
local detail_ttl = tonumber(ARGV[4])
local detail_raw = redis.call('GET', KEYS[2])
if not detail_raw then
  return 0
end
local detail = cjson.decode(detail_raw)
if detail.status == 'COMMITTED' then
  return 1
end
if detail.status ~= 'RESERVED' then
  return 0
end
local expires_at = now + hold_ms
redis.call('ZADD', KEYS[1], expires_at, detail.reservation_member)
redis.call('PEXPIRE', KEYS[1], rolling_window + hold_ms)
detail.expires_at = expires_at
detail.reconciliation_hold = true
detail.reconciliation_held_at = now
local ttl = math.max(detail_ttl, rolling_window + hold_ms)
redis.call('SET', KEYS[2], cjson.encode(detail), 'PX', ttl)
return 1
`;
