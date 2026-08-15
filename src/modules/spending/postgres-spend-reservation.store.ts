import type { QueryResultRow } from "pg";

export enum DurableSpendReservationStatus {
  RESERVED = "RESERVED",
  COMMITTED = "COMMITTED",
  RELEASED = "RELEASED",
  EXPIRED = "EXPIRED",
}

export interface DurableSpendReservationRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly mandateId: string;
  readonly idempotencyKey: string;
  readonly merchantDomain: string;
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly status: DurableSpendReservationStatus;
  readonly reservedAt: Date;
  readonly committedAt?: Date;
  readonly releasedAt?: Date;
  readonly expiresAt: Date;
}

export interface RecordDurableReservationInput {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly mandateId: string;
  readonly idempotencyKey: string;
  readonly merchantDomain: string;
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly reservedAt: Date;
  readonly expiresAt: Date;
}

export interface SpendReservationSqlClient {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ readonly rows: R[]; readonly rowCount: number | null }>;
}

export interface DurableSpendReservationStore {
  recordReserved(input: RecordDurableReservationInput): Promise<DurableSpendReservationRecord>;
  markCommitted(reservationId: string, now: Date): Promise<boolean>;
  markReleased(reservationId: string, now: Date): Promise<boolean>;
  extendHold(reservationId: string, expiresAt: Date, now: Date): Promise<boolean>;
}

interface SpendReservationRow extends QueryResultRow {
  id: string;
  organizationId: string;
  userId: string;
  agentId: string;
  mandateId: string;
  idempotencyKey: string;
  merchantDomain: string;
  currency: string;
  amountMinor: string;
  status: DurableSpendReservationStatus;
  reservedAt: Date;
  committedAt: Date | null;
  releasedAt: Date | null;
  expiresAt: Date;
}

/**
 * Durable mirror of Redis reservation lifecycle state.
 *
 * Redis remains the atomic enforcement engine. This store closes the gap between
 * an accepted Redis reservation and PaymentOutcome creation so a complete Redis
 * loss cannot erase an in-flight allowance hold before merchant dispatch.
 */
export class PostgresSpendReservationStore implements DurableSpendReservationStore {
  public constructor(private readonly sql: SpendReservationSqlClient) {}

  public async recordReserved(
    input: RecordDurableReservationInput,
  ): Promise<DurableSpendReservationRecord> {
    const result = await this.sql.query<SpendReservationRow>(
      `insert into "SpendReservation" (
         "id", "organizationId", "userId", "agentId", "mandateId",
         "idempotencyKey", "merchantDomain", "currency", "amountMinor",
         "status", "reservedAt", "expiresAt"
       ) values (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         $6, $7, $8, $9::bigint, 'RESERVED', $10, $11
       )
       on conflict ("organizationId", "idempotencyKey") do update
          set "id" = excluded."id",
              "userId" = excluded."userId",
              "agentId" = excluded."agentId",
              "mandateId" = excluded."mandateId",
              "merchantDomain" = excluded."merchantDomain",
              "currency" = excluded."currency",
              "amountMinor" = excluded."amountMinor",
              "status" = 'RESERVED',
              "reservedAt" = case
                when "SpendReservation"."status" = 'RESERVED'
                 and "SpendReservation"."id" = excluded."id"
                 and "SpendReservation"."expiresAt" > excluded."reservedAt"
                then "SpendReservation"."reservedAt"
                else excluded."reservedAt"
              end,
              "committedAt" = null,
              "releasedAt" = null,
              "expiresAt" = case
                when "SpendReservation"."status" = 'RESERVED'
                 and "SpendReservation"."id" = excluded."id"
                 and "SpendReservation"."expiresAt" > excluded."reservedAt"
                then "SpendReservation"."expiresAt"
                else excluded."expiresAt"
              end
        where "SpendReservation"."status" in ('RELEASED', 'EXPIRED')
           or (
             "SpendReservation"."status" = 'RESERVED'
             and "SpendReservation"."expiresAt" <= excluded."reservedAt"
           )
           or (
             "SpendReservation"."status" = 'RESERVED'
             and "SpendReservation"."id" = excluded."id"
             and "SpendReservation"."userId" = excluded."userId"
             and "SpendReservation"."agentId" = excluded."agentId"
             and "SpendReservation"."mandateId" = excluded."mandateId"
             and "SpendReservation"."merchantDomain" = excluded."merchantDomain"
             and "SpendReservation"."currency" = excluded."currency"
             and "SpendReservation"."amountMinor" = excluded."amountMinor"
           )
      returning *`,
      [
        input.id,
        input.organizationId,
        input.userId,
        input.agentId,
        input.mandateId,
        input.idempotencyKey,
        input.merchantDomain,
        input.currency.toUpperCase(),
        input.amountMinor.toString(10),
        input.reservedAt,
        input.expiresAt,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("Durable reservation idempotency state conflicts with an active reservation");
    }
    return mapRow(row);
  }

  public async markCommitted(reservationId: string, now: Date): Promise<boolean> {
    const result = await this.sql.query(
      `update "SpendReservation"
          set "status" = 'COMMITTED',
              "committedAt" = coalesce("committedAt", $2),
              "releasedAt" = null
        where "id" = $1::uuid
          and "status" in ('RESERVED', 'COMMITTED')`,
      [reservationId, now],
    );
    return (result.rowCount ?? 0) > 0;
  }

  public async markReleased(reservationId: string, now: Date): Promise<boolean> {
    const result = await this.sql.query(
      `update "SpendReservation"
          set "status" = 'RELEASED',
              "releasedAt" = coalesce("releasedAt", $2)
        where "id" = $1::uuid
          and "status" in ('RESERVED', 'RELEASED')`,
      [reservationId, now],
    );
    return (result.rowCount ?? 0) > 0;
  }

  public async extendHold(reservationId: string, expiresAt: Date, now: Date): Promise<boolean> {
    const result = await this.sql.query(
      `update "SpendReservation"
          set "expiresAt" = greatest("expiresAt", $2),
              "reservedAt" = least("reservedAt", $3)
        where "id" = $1::uuid
          and "status" = 'RESERVED'`,
      [reservationId, expiresAt, now],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

function mapRow(row: SpendReservationRow): DurableSpendReservationRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    agentId: row.agentId,
    mandateId: row.mandateId,
    idempotencyKey: row.idempotencyKey,
    merchantDomain: row.merchantDomain,
    currency: row.currency,
    amountMinor: BigInt(row.amountMinor),
    status: row.status,
    reservedAt: row.reservedAt,
    ...(row.committedAt ? { committedAt: row.committedAt } : {}),
    ...(row.releasedAt ? { releasedAt: row.releasedAt } : {}),
    expiresAt: row.expiresAt,
  };
}