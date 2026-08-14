import type { QueryResultRow } from "pg";

export enum ApprovalRequestStatus {
  PENDING = "PENDING",
  APPROVED = "APPROVED",
  REJECTED = "REJECTED",
  EXPIRED = "EXPIRED",
}

export enum ApprovalVoteDecision {
  APPROVE = "APPROVE",
  REJECT = "REJECT",
}

export interface ApprovalVoteRecord {
  readonly id: string;
  readonly approvalRequestId: string;
  readonly approverId: string;
  readonly decision: ApprovalVoteDecision;
  readonly comment?: string;
  readonly metadata?: unknown;
  readonly createdAt: Date;
}

export interface ApprovalRequestRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly mandateId: string;
  readonly decisionId: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly policyVersion: number;
  readonly merchantId: string;
  readonly merchantDomain: string;
  readonly checkoutSessionId?: string;
  readonly requestedPayload: unknown;
  readonly sessionSnapshot?: unknown;
  readonly spendSnapshot?: unknown;
  readonly reasonCodes: readonly string[];
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly status: ApprovalRequestStatus;
  readonly requiredSignatures: number;
  readonly approvalData?: unknown;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly resolvedAt?: Date;
  readonly votes: readonly ApprovalVoteRecord[];
}

export interface BeginApprovalRequestInput {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly mandateId: string;
  readonly decisionId: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly policyVersion: number;
  readonly merchantId: string;
  readonly merchantDomain: string;
  readonly checkoutSessionId?: string;
  readonly requestedPayload: unknown;
  readonly sessionSnapshot?: unknown;
  readonly spendSnapshot?: unknown;
  readonly reasonCodes: readonly string[];
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly requiredSignatures: number;
  readonly expiresAt: Date;
  readonly now: Date;
}

export enum BeginApprovalRequestKind {
  CREATED = "CREATED",
  EXISTING = "EXISTING",
  CONFLICT = "CONFLICT",
}

export interface BeginApprovalRequestResult {
  readonly kind: BeginApprovalRequestKind;
  readonly request: ApprovalRequestRecord;
}

export interface CastApprovalVoteInput {
  readonly approvalRequestId: string;
  readonly approverId: string;
  readonly decision: ApprovalVoteDecision;
  readonly comment?: string;
  readonly metadata?: unknown;
  readonly now: Date;
}

export class ApprovalVoteConflictError extends Error {
  public constructor() {
    super("Approver already cast a different vote for this approval request");
    this.name = "ApprovalVoteConflictError";
  }
}

export class ApprovalAlreadyResolvedError extends Error {
  public constructor(status: ApprovalRequestStatus) {
    super(`Approval request is already ${status.toLowerCase()}`);
    this.name = "ApprovalAlreadyResolvedError";
  }
}

export class ApprovalRequestNotFoundError extends Error {
  public constructor() {
    super("Approval request was not found");
    this.name = "ApprovalRequestNotFoundError";
  }
}

export interface ApprovalSqlTransaction {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ readonly rows: R[]; readonly rowCount: number | null }>;
  release(): void;
}

export interface ApprovalSqlClient {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ readonly rows: R[]; readonly rowCount: number | null }>;
  connect(): Promise<ApprovalSqlTransaction>;
}

export interface ApprovalRequestStore {
  getById(approvalRequestId: string): Promise<ApprovalRequestRecord | undefined>;
  getByIdempotency(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<ApprovalRequestRecord | undefined>;
  begin(input: BeginApprovalRequestInput): Promise<BeginApprovalRequestResult>;
  castVote(input: CastApprovalVoteInput): Promise<ApprovalRequestRecord>;
  expirePending(approvalRequestId: string, now: Date): Promise<ApprovalRequestRecord>;
}

interface ApprovalRequestRow extends QueryResultRow {
  id: string;
  organizationId: string;
  userId: string;
  agentId: string;
  mandateId: string;
  decisionId: string;
  requestId: string;
  idempotencyKey: string;
  requestDigest: string;
  policyVersion: number;
  merchantId: string;
  merchantDomain: string;
  checkoutSessionId: string | null;
  requestedPayload: unknown;
  sessionSnapshot: unknown | null;
  spendSnapshot: unknown | null;
  reasonCodes: string[];
  amountMinor: string;
  currency: string;
  status: ApprovalRequestStatus;
  requiredSignatures: number;
  approvalData: unknown | null;
  createdAt: Date;
  expiresAt: Date;
  resolvedAt: Date | null;
}

interface ApprovalVoteRow extends QueryResultRow {
  id: string;
  approvalRequestId: string;
  approverId: string;
  decision: ApprovalVoteDecision;
  comment: string | null;
  metadata: unknown | null;
  createdAt: Date;
}

export class PostgresApprovalRequestStore implements ApprovalRequestStore {
  public constructor(private readonly sql: ApprovalSqlClient) {}

  public async getById(approvalRequestId: string): Promise<ApprovalRequestRecord | undefined> {
    const result = await this.sql.query<ApprovalRequestRow>(
      `select * from "ApprovalRequest" where "id" = $1::uuid`,
      [approvalRequestId],
    );
    const row = result.rows[0];
    return row ? this.hydrate(row, this.sql) : undefined;
  }

  public async getByIdempotency(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<ApprovalRequestRecord | undefined> {
    const result = await this.sql.query<ApprovalRequestRow>(
      `select *
         from "ApprovalRequest"
        where "organizationId" = $1::uuid
          and "idempotencyKey" = $2`,
      [organizationId, idempotencyKey],
    );
    const row = result.rows[0];
    return row ? this.hydrate(row, this.sql) : undefined;
  }

  public async begin(input: BeginApprovalRequestInput): Promise<BeginApprovalRequestResult> {
    const inserted = await this.sql.query<ApprovalRequestRow>(
      `insert into "ApprovalRequest" (
         "id", "organizationId", "userId", "agentId", "mandateId",
         "decisionId", "requestId", "idempotencyKey", "requestDigest", "policyVersion",
         "merchantId", "merchantDomain", "checkoutSessionId", "requestedPayload",
         "sessionSnapshot", "spendSnapshot", "reasonCodes", "amountMinor", "currency",
         "status", "requiredSignatures", "createdAt", "expiresAt"
       ) values (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         $6, $7, $8, $9, $10,
         $11, $12, $13, $14::jsonb,
         $15::jsonb, $16::jsonb, $17::text[], $18::bigint, $19,
         'PENDING', $20, $21, $22
       )
       on conflict ("organizationId", "idempotencyKey") do nothing
       returning *`,
      [
        input.id,
        input.organizationId,
        input.userId,
        input.agentId,
        input.mandateId,
        input.decisionId,
        input.requestId,
        input.idempotencyKey,
        input.requestDigest,
        input.policyVersion,
        input.merchantId,
        input.merchantDomain,
        input.checkoutSessionId ?? null,
        JSON.stringify(input.requestedPayload ?? null),
        input.sessionSnapshot === undefined ? null : JSON.stringify(input.sessionSnapshot),
        input.spendSnapshot === undefined ? null : JSON.stringify(input.spendSnapshot),
        [...input.reasonCodes],
        input.amountMinor.toString(10),
        input.currency.toUpperCase(),
        input.requiredSignatures,
        input.now,
        input.expiresAt,
      ],
    );

    const created = inserted.rows[0];
    if (created) {
      return {
        kind: BeginApprovalRequestKind.CREATED,
        request: mapRequestRow(created, []),
      };
    }

    const existing = await this.getByIdempotency(input.organizationId, input.idempotencyKey);
    if (!existing) {
      throw new Error("Approval request uniqueness conflict could not be reloaded");
    }

    return {
      kind:
        existing.requestDigest === input.requestDigest
          ? BeginApprovalRequestKind.EXISTING
          : BeginApprovalRequestKind.CONFLICT,
      request: existing,
    };
  }

  public async castVote(input: CastApprovalVoteInput): Promise<ApprovalRequestRecord> {
    const tx = await this.sql.connect();
    let committed = false;
    try {
      await tx.query("begin");
      const requestResult = await tx.query<ApprovalRequestRow>(
        `select * from "ApprovalRequest" where "id" = $1::uuid for update`,
        [input.approvalRequestId],
      );
      let request = requestResult.rows[0];
      if (!request) {
        throw new ApprovalRequestNotFoundError();
      }

      if (request.status === ApprovalRequestStatus.PENDING && input.now >= request.expiresAt) {
        const expired = await tx.query<ApprovalRequestRow>(
          `update "ApprovalRequest"
              set "status" = 'EXPIRED', "resolvedAt" = coalesce("resolvedAt", $2)
            where "id" = $1::uuid
          returning *`,
          [input.approvalRequestId, input.now],
        );
        request = expired.rows[0]!;
        await tx.query("commit");
        committed = true;
        throw new ApprovalAlreadyResolvedError(request.status);
      }

      const existingVote = await tx.query<ApprovalVoteRow>(
        `select *
           from "ApprovalVote"
          where "approvalRequestId" = $1::uuid
            and "approverId" = $2`,
        [input.approvalRequestId, input.approverId],
      );
      const priorVote = existingVote.rows[0];
      if (priorVote) {
        if (priorVote.decision !== input.decision) {
          throw new ApprovalVoteConflictError();
        }
        const votes = await this.loadVotes(input.approvalRequestId, tx);
        await tx.query("commit");
        committed = true;
        return mapRequestRow(request, votes);
      }

      if (request.status !== ApprovalRequestStatus.PENDING) {
        throw new ApprovalAlreadyResolvedError(request.status);
      }

      await tx.query(
        `insert into "ApprovalVote" (
           "id", "approvalRequestId", "approverId", "decision", "comment", "metadata", "createdAt"
         ) values (
           gen_random_uuid(), $1::uuid, $2, $3::"ApprovalVoteDecision", $4, $5::jsonb, $6
         )`,
        [
          input.approvalRequestId,
          input.approverId,
          input.decision,
          input.comment ?? null,
          input.metadata === undefined ? null : JSON.stringify(input.metadata),
          input.now,
        ],
      );

      if (input.decision === ApprovalVoteDecision.REJECT) {
        const rejected = await tx.query<ApprovalRequestRow>(
          `update "ApprovalRequest"
              set "status" = 'REJECTED', "resolvedAt" = coalesce("resolvedAt", $2)
            where "id" = $1::uuid
          returning *`,
          [input.approvalRequestId, input.now],
        );
        request = rejected.rows[0]!;
      } else {
        const count = await tx.query<{ count: string }>(
          `select count(*)::text as count
             from "ApprovalVote"
            where "approvalRequestId" = $1::uuid
              and "decision" = 'APPROVE'`,
          [input.approvalRequestId],
        );
        if (Number(count.rows[0]?.count ?? "0") >= request.requiredSignatures) {
          const approved = await tx.query<ApprovalRequestRow>(
            `update "ApprovalRequest"
                set "status" = 'APPROVED', "resolvedAt" = coalesce("resolvedAt", $2)
              where "id" = $1::uuid
            returning *`,
            [input.approvalRequestId, input.now],
          );
          request = approved.rows[0]!;
        }
      }

      const votes = await this.loadVotes(input.approvalRequestId, tx);
      await tx.query("commit");
      committed = true;
      return mapRequestRow(request, votes);
    } catch (error) {
      if (!committed) {
        try {
          await tx.query("rollback");
        } catch {
          // Preserve the original resolution failure.
        }
      }
      throw error;
    } finally {
      tx.release();
    }
  }

  public async expirePending(
    approvalRequestId: string,
    now: Date,
  ): Promise<ApprovalRequestRecord> {
    const result = await this.sql.query<ApprovalRequestRow>(
      `update "ApprovalRequest"
          set "status" = case
                when "status" = 'PENDING' and "expiresAt" <= $2 then 'EXPIRED'::"ApprovalStatus"
                else "status"
              end,
              "resolvedAt" = case
                when "status" = 'PENDING' and "expiresAt" <= $2 then coalesce("resolvedAt", $2)
                else "resolvedAt"
              end
        where "id" = $1::uuid
      returning *`,
      [approvalRequestId, now],
    );
    const row = result.rows[0];
    if (!row) {
      throw new ApprovalRequestNotFoundError();
    }
    return this.hydrate(row, this.sql);
  }

  private async hydrate(
    row: ApprovalRequestRow,
    client: Pick<ApprovalSqlClient, "query">,
  ): Promise<ApprovalRequestRecord> {
    return mapRequestRow(row, await this.loadVotes(row.id, client));
  }

  private async loadVotes(
    approvalRequestId: string,
    client: Pick<ApprovalSqlClient, "query">,
  ): Promise<ApprovalVoteRow[]> {
    const result = await client.query<ApprovalVoteRow>(
      `select *
         from "ApprovalVote"
        where "approvalRequestId" = $1::uuid
        order by "createdAt" asc, "id" asc`,
      [approvalRequestId],
    );
    return result.rows;
  }
}

function mapRequestRow(
  row: ApprovalRequestRow,
  votes: readonly ApprovalVoteRow[],
): ApprovalRequestRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    agentId: row.agentId,
    mandateId: row.mandateId,
    decisionId: row.decisionId,
    requestId: row.requestId,
    idempotencyKey: row.idempotencyKey,
    requestDigest: row.requestDigest,
    policyVersion: row.policyVersion,
    merchantId: row.merchantId,
    merchantDomain: row.merchantDomain,
    ...(row.checkoutSessionId ? { checkoutSessionId: row.checkoutSessionId } : {}),
    requestedPayload: row.requestedPayload,
    ...(row.sessionSnapshot !== null ? { sessionSnapshot: row.sessionSnapshot } : {}),
    ...(row.spendSnapshot !== null ? { spendSnapshot: row.spendSnapshot } : {}),
    reasonCodes: row.reasonCodes,
    amountMinor: BigInt(row.amountMinor),
    currency: row.currency,
    status: row.status,
    requiredSignatures: row.requiredSignatures,
    ...(row.approvalData !== null ? { approvalData: row.approvalData } : {}),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    ...(row.resolvedAt ? { resolvedAt: row.resolvedAt } : {}),
    votes: votes.map(mapVoteRow),
  };
}

function mapVoteRow(row: ApprovalVoteRow): ApprovalVoteRecord {
  return {
    id: row.id,
    approvalRequestId: row.approvalRequestId,
    approverId: row.approverId,
    decision: row.decision,
    ...(row.comment ? { comment: row.comment } : {}),
    ...(row.metadata !== null ? { metadata: row.metadata } : {}),
    createdAt: row.createdAt,
  };
}
