import type { QueryResultRow } from "pg";

export enum PaymentOutcomeStatus {
  FORWARDING = "FORWARDING",
  UNKNOWN = "UNKNOWN",
  SUCCEEDED = "SUCCEEDED",
  FAILED_DEFINITIVE = "FAILED_DEFINITIVE",
}

export interface StoredMerchantResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface PaymentOutcomeRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly mandateId: string;
  readonly reservationId: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly merchantId: string;
  readonly merchantDomain: string;
  readonly checkoutSessionId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly status: PaymentOutcomeStatus;
  readonly upstreamStatus?: number;
  readonly response?: StoredMerchantResponse;
  readonly lastErrorCode?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly forwardedAt?: Date;
  readonly resolvedAt?: Date;
  readonly lastReconciledAt?: Date;
}

export interface BeginPaymentOutcomeInput {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly mandateId: string;
  readonly reservationId: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly merchantId: string;
  readonly merchantDomain: string;
  readonly checkoutSessionId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly now: Date;
}

export enum BeginPaymentOutcomeKind {
  CREATED = "CREATED",
  EXISTING = "EXISTING",
  CONFLICT = "CONFLICT",
}

export interface BeginPaymentOutcomeResult {
  readonly kind: BeginPaymentOutcomeKind;
  readonly outcome: PaymentOutcomeRecord;
}

export interface PaymentOutcomeStore {
  begin(input: BeginPaymentOutcomeInput): Promise<BeginPaymentOutcomeResult>;
  markUnknown(
    outcomeId: string,
    args: { readonly upstreamStatus?: number; readonly errorCode?: string; readonly now: Date },
  ): Promise<PaymentOutcomeRecord>;
  markSucceeded(
    outcomeId: string,
    response: StoredMerchantResponse,
    now: Date,
  ): Promise<PaymentOutcomeRecord>;
  markDefinitiveFailure(
    outcomeId: string,
    response: StoredMerchantResponse,
    now: Date,
  ): Promise<PaymentOutcomeRecord>;
  markReconciled(outcomeId: string, now: Date): Promise<PaymentOutcomeRecord>;
}

export interface SqlClient {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ readonly rows: R[]; readonly rowCount: number | null }>;
}

interface PaymentOutcomeRow extends QueryResultRow {
  id: string;
  organizationId: string;
  userId: string;
  agentId: string;
  mandateId: string;
  reservationId: string;
  idempotencyKey: string;
  requestDigest: string;
  merchantId: string;
  merchantDomain: string;
  checkoutSessionId: string;
  amountMinor: string;
  currency: string;
  status: PaymentOutcomeStatus;
  upstreamStatus: number | null;
  responseBody: unknown | null;
  responseHeaders: unknown | null;
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
  forwardedAt: Date | null;
  resolvedAt: Date | null;
  lastReconciledAt: Date | null;
}

export class PostgresPaymentOutcomeStore implements PaymentOutcomeStore {
  public constructor(private readonly sql: SqlClient) {}

  public async begin(input: BeginPaymentOutcomeInput): Promise<BeginPaymentOutcomeResult> {
    const inserted = await this.sql.query<PaymentOutcomeRow>(
      `insert into "PaymentOutcome" (
         "id", "organizationId", "userId", "agentId", "mandateId",
         "reservationId", "idempotencyKey", "requestDigest", "merchantId",
         "merchantDomain", "checkoutSessionId", "amountMinor", "currency",
         "status", "forwardedAt", "createdAt", "updatedAt"
       ) values (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         $6, $7, $8, $9, $10, $11, $12::bigint, $13,
         'FORWARDING', $14, $14, $14
       )
       on conflict ("organizationId", "idempotencyKey") do nothing
       returning *`,
      [
        input.id,
        input.organizationId,
        input.userId,
        input.agentId,
        input.mandateId,
        input.reservationId,
        input.idempotencyKey,
        input.requestDigest,
        input.merchantId,
        input.merchantDomain,
        input.checkoutSessionId,
        input.amountMinor.toString(10),
        input.currency.toUpperCase(),
        input.now,
      ],
    );

    const created = inserted.rows[0];
    if (created) {
      return { kind: BeginPaymentOutcomeKind.CREATED, outcome: mapRow(created) };
    }

    const existing = await this.findByIdempotency(input.organizationId, input.idempotencyKey);
    if (!existing) {
      throw new Error("Payment outcome uniqueness conflict could not be reloaded");
    }

    return {
      kind:
        existing.requestDigest === input.requestDigest
          ? BeginPaymentOutcomeKind.EXISTING
          : BeginPaymentOutcomeKind.CONFLICT,
      outcome: existing,
    };
  }

  public async markUnknown(
    outcomeId: string,
    args: { readonly upstreamStatus?: number; readonly errorCode?: string; readonly now: Date },
  ): Promise<PaymentOutcomeRecord> {
    return this.updateOne(
      `update "PaymentOutcome"
          set "status" = 'UNKNOWN',
              "upstreamStatus" = coalesce($2, "upstreamStatus"),
              "lastErrorCode" = $3,
              "updatedAt" = $4
        where "id" = $1::uuid
          and "status" in ('FORWARDING', 'UNKNOWN')
      returning *`,
      [outcomeId, args.upstreamStatus ?? null, args.errorCode ?? null, args.now],
      outcomeId,
    );
  }

  public async markSucceeded(
    outcomeId: string,
    response: StoredMerchantResponse,
    now: Date,
  ): Promise<PaymentOutcomeRecord> {
    return this.updateOne(
      `update "PaymentOutcome"
          set "status" = 'SUCCEEDED',
              "upstreamStatus" = $2,
              "responseBody" = $3::jsonb,
              "responseHeaders" = $4::jsonb,
              "lastErrorCode" = null,
              "resolvedAt" = coalesce("resolvedAt", $5),
              "updatedAt" = $5
        where "id" = $1::uuid
          and "status" in ('FORWARDING', 'UNKNOWN', 'SUCCEEDED')
      returning *`,
      [
        outcomeId,
        response.status,
        JSON.stringify(response.body ?? null),
        JSON.stringify(response.headers ?? {}),
        now,
      ],
      outcomeId,
    );
  }

  public async markDefinitiveFailure(
    outcomeId: string,
    response: StoredMerchantResponse,
    now: Date,
  ): Promise<PaymentOutcomeRecord> {
    return this.updateOne(
      `update "PaymentOutcome"
          set "status" = 'FAILED_DEFINITIVE',
              "upstreamStatus" = $2,
              "responseBody" = $3::jsonb,
              "responseHeaders" = $4::jsonb,
              "lastErrorCode" = null,
              "resolvedAt" = coalesce("resolvedAt", $5),
              "updatedAt" = $5
        where "id" = $1::uuid
          and "status" in ('FORWARDING', 'UNKNOWN', 'FAILED_DEFINITIVE')
      returning *`,
      [
        outcomeId,
        response.status,
        JSON.stringify(response.body ?? null),
        JSON.stringify(response.headers ?? {}),
        now,
      ],
      outcomeId,
    );
  }

  public async markReconciled(outcomeId: string, now: Date): Promise<PaymentOutcomeRecord> {
    return this.updateOne(
      `update "PaymentOutcome"
          set "lastReconciledAt" = $2,
              "updatedAt" = $2
        where "id" = $1::uuid
      returning *`,
      [outcomeId, now],
      outcomeId,
    );
  }

  private async findByIdempotency(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<PaymentOutcomeRecord | undefined> {
    const result = await this.sql.query<PaymentOutcomeRow>(
      `select *
         from "PaymentOutcome"
        where "organizationId" = $1::uuid
          and "idempotencyKey" = $2`,
      [organizationId, idempotencyKey],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  private async updateOne(
    statement: string,
    values: unknown[],
    outcomeId: string,
  ): Promise<PaymentOutcomeRecord> {
    const result = await this.sql.query<PaymentOutcomeRow>(statement, values);
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Payment outcome ${outcomeId} cannot make the requested state transition`);
    }
    return mapRow(row);
  }
}

function mapRow(row: PaymentOutcomeRow): PaymentOutcomeRecord {
  const response =
    row.upstreamStatus !== null && row.responseBody !== null
      ? {
          status: row.upstreamStatus,
          body: row.responseBody,
          ...(isStringRecord(row.responseHeaders) ? { headers: row.responseHeaders } : {}),
        }
      : undefined;

  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    agentId: row.agentId,
    mandateId: row.mandateId,
    reservationId: row.reservationId,
    idempotencyKey: row.idempotencyKey,
    requestDigest: row.requestDigest,
    merchantId: row.merchantId,
    merchantDomain: row.merchantDomain,
    checkoutSessionId: row.checkoutSessionId,
    amountMinor: BigInt(row.amountMinor),
    currency: row.currency,
    status: row.status,
    ...(row.upstreamStatus !== null ? { upstreamStatus: row.upstreamStatus } : {}),
    ...(response ? { response } : {}),
    ...(row.lastErrorCode ? { lastErrorCode: row.lastErrorCode } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.forwardedAt ? { forwardedAt: row.forwardedAt } : {}),
    ...(row.resolvedAt ? { resolvedAt: row.resolvedAt } : {}),
    ...(row.lastReconciledAt ? { lastReconciledAt: row.lastReconciledAt } : {}),
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === "string");
}
