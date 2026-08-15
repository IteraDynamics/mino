import type { Pool, PoolClient, QueryResultRow } from "pg";
import type {
  AdminAuditSqlClient,
  AdminAuditSqlTransaction,
} from "../../modules/admin/admin-change-audit-ledger.js";
import type {
  ApprovalSqlClient,
  ApprovalSqlTransaction,
} from "../../modules/approvals/approval-request.store.js";
import type { AuditSqlClient, AuditSqlTransaction } from "../../modules/audit/postgres-audit-ledger.js";
import type { SqlClient } from "../../modules/payments/payment-outcome.store.js";

export class PgSqlAdapter
  implements SqlClient, ApprovalSqlClient, AuditSqlClient, AdminAuditSqlClient
{
  public constructor(private readonly pool: Pool) {}

  public async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ readonly rows: R[]; readonly rowCount: number | null }> {
    const result = await this.pool.query<R>(text, values);
    return { rows: result.rows, rowCount: result.rowCount };
  }

  public async connect(): Promise<
    ApprovalSqlTransaction & AuditSqlTransaction & AdminAuditSqlTransaction
  > {
    return pgTransaction(await this.pool.connect());
  }
}

function pgTransaction(
  client: PoolClient,
): ApprovalSqlTransaction & AuditSqlTransaction & AdminAuditSqlTransaction {
  return {
    async query<R extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: unknown[],
    ): Promise<{ readonly rows: R[]; readonly rowCount: number | null }> {
      const result = await client.query<R>(text, values);
      return { rows: result.rows, rowCount: result.rowCount };
    },
    release(): void {
      client.release();
    },
  };
}
