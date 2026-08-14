import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";

integration("PostgreSQL schema", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query("select 1");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("contains the authorization-control-plane tables created from the Prisma schema", async () => {
    const result = await pool.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public'",
    );
    const tables = new Set(result.rows.map((row) => row.tablename));

    for (const table of [
      "Organization",
      "User",
      "AgentIdentity",
      "Policy",
      "AgentMandate",
      "MerchantEndpoint",
      "SpendReservation",
      "PaymentOutcome",
      "ApprovalRequest",
      "ApprovalVote",
      "AuditChainHead",
      "AuditLog",
    ]) {
      expect(tables.has(table)).toBe(true);
    }
  });

  it("enforces mandate token-JTI uniqueness in PostgreSQL", async () => {
    const constraints = await pool.query<{ indexdef: string }>(
      `select indexdef
         from pg_indexes
        where schemaname = 'public'
          and tablename = 'AgentMandate'`,
    );

    expect(
      constraints.rows.some((row) =>
        row.indexdef.includes('UNIQUE') && row.indexdef.includes('"tokenJtiHash"'),
      ),
    ).toBe(true);
  });

  it("enforces organization-scoped spend idempotency in PostgreSQL", async () => {
    const constraints = await pool.query<{ indexdef: string }>(
      `select indexdef
         from pg_indexes
        where schemaname = 'public'
          and tablename = 'SpendReservation'`,
    );

    expect(
      constraints.rows.some((row) =>
        row.indexdef.includes('UNIQUE') &&
        row.indexdef.includes('"organizationId"') &&
        row.indexdef.includes('"idempotencyKey"'),
      ),
    ).toBe(true);
  });

  it("enforces organization-scoped payment-outcome idempotency in PostgreSQL", async () => {
    const constraints = await pool.query<{ indexdef: string }>(
      `select indexdef
         from pg_indexes
        where schemaname = 'public'
          and tablename = 'PaymentOutcome'`,
    );

    expect(
      constraints.rows.some((row) =>
        row.indexdef.includes('UNIQUE') &&
        row.indexdef.includes('"organizationId"') &&
        row.indexdef.includes('"idempotencyKey"'),
      ),
    ).toBe(true);
    expect(
      constraints.rows.some((row) =>
        row.indexdef.includes('UNIQUE') && row.indexdef.includes('"reservationId"'),
      ),
    ).toBe(true);
  });

  it("enforces approval request idempotency and one vote per approver", async () => {
    const approvalIndexes = await pool.query<{ indexdef: string }>(
      `select indexdef
         from pg_indexes
        where schemaname = 'public'
          and tablename = 'ApprovalRequest'`,
    );
    const voteIndexes = await pool.query<{ indexdef: string }>(
      `select indexdef
         from pg_indexes
        where schemaname = 'public'
          and tablename = 'ApprovalVote'`,
    );

    expect(
      approvalIndexes.rows.some((row) =>
        row.indexdef.includes('UNIQUE') &&
        row.indexdef.includes('"organizationId"') &&
        row.indexdef.includes('"idempotencyKey"'),
      ),
    ).toBe(true);
    expect(
      voteIndexes.rows.some((row) =>
        row.indexdef.includes('UNIQUE') &&
        row.indexdef.includes('"approvalRequestId"') &&
        row.indexdef.includes('"approverId"'),
      ),
    ).toBe(true);
  });

  it("materializes the one-row-per-organization audit chain head", async () => {
    const indexes = await pool.query<{ indexdef: string }>(
      `select indexdef
         from pg_indexes
        where schemaname = 'public'
          and tablename = 'AuditChainHead'`,
    );
    const columns = await pool.query<{ column_name: string }>(
      `select column_name
         from information_schema.columns
        where table_schema = 'public'
          and table_name = 'AuditChainHead'`,
    );
    const names = new Set(columns.rows.map((row) => row.column_name));

    expect(
      indexes.rows.some((row) =>
        row.indexdef.includes('UNIQUE') && row.indexdef.includes('"organizationId"'),
      ),
    ).toBe(true);
    for (const column of ["organizationId", "chainSequence", "chainDigest", "updatedAt"]) {
      expect(names.has(column)).toBe(true);
    }
  });

  it("enforces one audit-chain sequence per organization and materializes signed-chain fields", async () => {
    const indexes = await pool.query<{ indexdef: string }>(
      `select indexdef
         from pg_indexes
        where schemaname = 'public'
          and tablename = 'AuditLog'`,
    );
    const columns = await pool.query<{ column_name: string }>(
      `select column_name
         from information_schema.columns
        where table_schema = 'public'
          and table_name = 'AuditLog'`,
    );
    const names = new Set(columns.rows.map((row) => row.column_name));

    expect(
      indexes.rows.some((row) =>
        row.indexdef.includes('UNIQUE') &&
        row.indexdef.includes('"organizationId"') &&
        row.indexdef.includes('"chainSequence"'),
      ),
    ).toBe(true);

    for (const column of [
      "decisionSnapshot",
      "chainVersion",
      "chainSequence",
      "previousChainDigest",
      "chainDigest",
      "eventDigest",
      "integritySignature",
      "signingKeyId",
    ]) {
      expect(names.has(column)).toBe(true);
    }
  });
});