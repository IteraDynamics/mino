import type { QueryResultRow } from "pg";
import type { Ed25519KeyInput } from "../../infrastructure/crypto/ed25519.js";
import { signEd25519, verifyEd25519 } from "../../infrastructure/crypto/ed25519.js";
import { canonicalJson, sha256Base64Url } from "../../infrastructure/crypto/canonical-json.js";
import {
  AUTHORIZATION_RECEIPT_SCHEMA_VERSION,
  type AuthorizationReceiptApprovalEvidence,
  type AuthorizationReceiptAuditEvidence,
  type AuthorizationReceiptExecutionStatus,
  type AuthorizationReceiptPayload,
  type SignedAuthorizationReceipt,
} from "../../domain/economic/authorization-receipt.js";
import type { EconomicOperation, EconomicProviderProtocol } from "../../domain/economic/economic-intent.types.js";
import type {
  AuditSigningKeyProvider,
  AuditVerificationKeyResolver,
} from "../audit/postgres-audit-ledger.js";

const RECEIPT_SIGNATURE_TYPE = "mino.authorization.receipt.v1";

export interface AuthorizationReceiptSqlClient {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ readonly rows: R[]; readonly rowCount: number | null }>;
}

interface OutcomeEvidenceRow extends QueryResultRow {
  id: string;
  organizationId: string;
  userId: string;
  agentId: string;
  mandateId: string;
  requestDigest: string;
  intentDigest: string | null;
  authoritativeStateDigest: string | null;
  decisionId: string | null;
  policyId: string | null;
  policyVersion: number | null;
  decisionReasonCodes: string[];
  decisionEvaluatedAt: Date | null;
  protocol: string | null;
  operation: string | null;
  approvalRequestId: string | null;
  checkoutSessionId: string;
  amountMinor: string;
  currency: string;
  status: string;
  upstreamStatus: number | null;
  resolvedAt: Date | null;
}

interface ApprovalVoteEvidenceRow extends QueryResultRow {
  approvalRequestId: string;
  approvedAt: Date | null;
  approverId: string | null;
  voteApprovedAt: Date | null;
}

interface AuditEvidenceRow extends QueryResultRow {
  chainSequence: string;
  eventDigest: string;
  chainDigest: string;
}

interface ReceiptRow extends QueryResultRow {
  id: string;
  paymentOutcomeId: string;
  payload: unknown;
  receiptDigest: string;
  integritySignature: string;
  signingKeyId: string;
  issuedAt: Date;
}

export class AuthorizationReceiptEvidenceUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AuthorizationReceiptEvidenceUnavailableError";
  }
}

export interface AuthorizationReceiptIssuer {
  issueForPaymentOutcome(paymentOutcomeId: string, now: Date): Promise<SignedAuthorizationReceipt>;
  getByPaymentOutcomeId(paymentOutcomeId: string): Promise<SignedAuthorizationReceipt | undefined>;
}

/**
 * Persists one immutable, signed post-execution proof per terminal PaymentOutcome.
 *
 * Receipt signing deliberately uses the durable audit signing-key family: receipts
 * are evidence, not short-lived execution capabilities. The signature is domain
 * separated from the audit chain despite sharing the rotation/verification model.
 */
export class PostgresAuthorizationReceiptService implements AuthorizationReceiptIssuer {
  public constructor(
    private readonly sql: AuthorizationReceiptSqlClient,
    private readonly signingKeys: AuditSigningKeyProvider,
    private readonly generateId: () => string,
  ) {}

  public async getByPaymentOutcomeId(
    paymentOutcomeId: string,
  ): Promise<SignedAuthorizationReceipt | undefined> {
    const result = await this.sql.query<ReceiptRow>(
      `select * from "AuthorizationReceipt" where "paymentOutcomeId" = $1::uuid`,
      [paymentOutcomeId],
    );
    return result.rows[0] ? mapReceiptRow(result.rows[0]) : undefined;
  }

  public async issueForPaymentOutcome(
    paymentOutcomeId: string,
    now: Date,
  ): Promise<SignedAuthorizationReceipt> {
    const existing = await this.getByPaymentOutcomeId(paymentOutcomeId);
    if (existing) return existing;

    const outcome = await this.loadOutcome(paymentOutcomeId);
    assertTerminalOutcomeEvidence(outcome);

    const audit = await this.loadAuditEvidence(outcome);
    if (!audit) {
      throw new AuthorizationReceiptEvidenceUnavailableError(
        "Authorization receipt requires the terminal execution audit event",
      );
    }

    const approval = outcome.approvalRequestId
      ? await this.loadApprovalEvidence(outcome.approvalRequestId)
      : undefined;
    if (outcome.approvalRequestId && !approval) {
      throw new AuthorizationReceiptEvidenceUnavailableError(
        "Authorization receipt requires the referenced approval evidence",
      );
    }

    const receiptId = this.generateId();
    const payload: AuthorizationReceiptPayload = Object.freeze({
      schemaVersion: AUTHORIZATION_RECEIPT_SCHEMA_VERSION,
      receiptId,
      intentDigest: outcome.intentDigest!,
      authority: {
        organizationId: outcome.organizationId,
        userId: outcome.userId,
        agentId: outcome.agentId,
        mandateId: outcome.mandateId,
        policyId: outcome.policyId!,
        policyVersion: outcome.policyVersion!,
      },
      decision: {
        decisionId: outcome.decisionId!,
        verdict: "ALLOW",
        reasonCodes: [...outcome.decisionReasonCodes],
        evaluatedAt: outcome.decisionEvaluatedAt!.toISOString(),
      },
      ...(approval ? { approval } : {}),
      execution: {
        paymentOutcomeId: outcome.id,
        protocol: outcome.protocol as EconomicProviderProtocol,
        operation: outcome.operation as EconomicOperation,
        status: outcome.status as AuthorizationReceiptExecutionStatus,
        providerReference: outcome.checkoutSessionId,
        amountMinor: outcome.amountMinor,
        currency: outcome.currency,
        upstreamStatus: outcome.upstreamStatus!,
        resolvedAt: outcome.resolvedAt!.toISOString(),
      },
      evidence: {
        authoritativeStateDigest: outcome.authoritativeStateDigest!,
        requestDigest: outcome.requestDigest,
        audit,
      },
      issuedAt: now.toISOString(),
    });

    const signingKey = await this.signingKeys.getActiveSigningKey(outcome.organizationId);
    const receiptDigest = receiptPayloadDigest(payload);
    const signature = signEd25519(
      receiptSignaturePayload(receiptDigest),
      signingKey.privateKey,
    ).toString("base64url");

    const inserted = await this.sql.query<ReceiptRow>(
      `insert into "AuthorizationReceipt" (
         "id", "paymentOutcomeId", "organizationId", "userId", "agentId", "mandateId",
         "intentDigest", "payload", "receiptDigest", "integritySignature", "signingKeyId", "issuedAt"
       ) values (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
         $7, $8::jsonb, $9, $10, $11, $12
       )
       on conflict ("paymentOutcomeId") do nothing
       returning *`,
      [
        receiptId,
        outcome.id,
        outcome.organizationId,
        outcome.userId,
        outcome.agentId,
        outcome.mandateId,
        outcome.intentDigest,
        JSON.stringify(payload),
        receiptDigest,
        signature,
        signingKey.keyId,
        now,
      ],
    );

    const created = inserted.rows[0];
    if (created) return mapReceiptRow(created);

    const concurrent = await this.getByPaymentOutcomeId(paymentOutcomeId);
    if (!concurrent) {
      throw new Error("Authorization receipt uniqueness conflict could not be reloaded");
    }
    if (concurrent.payload.intentDigest !== outcome.intentDigest) {
      throw new Error("Authorization receipt conflicts with the persisted economic intent");
    }
    return concurrent;
  }

  private async loadOutcome(paymentOutcomeId: string): Promise<OutcomeEvidenceRow> {
    const result = await this.sql.query<OutcomeEvidenceRow>(
      `select * from "PaymentOutcome" where "id" = $1::uuid`,
      [paymentOutcomeId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new AuthorizationReceiptEvidenceUnavailableError("Payment outcome was not found");
    }
    return row;
  }

  private async loadAuditEvidence(
    outcome: OutcomeEvidenceRow,
  ): Promise<AuthorizationReceiptAuditEvidence | undefined> {
    if (!outcome.decisionId) return undefined;
    const result = await this.sql.query<AuditEvidenceRow>(
      `select "chainSequence"::text as "chainSequence", "eventDigest", "chainDigest"
         from "AuditLog"
        where "organizationId" = $1::uuid
          and "decisionId" = $2::uuid
          and "reservationId" = $3
        order by "chainSequence" desc
        limit 1`,
      [outcome.organizationId, outcome.decisionId, outcome.reservationId],
    );
    const row = result.rows[0];
    return row
      ? {
          chainSequence: row.chainSequence,
          eventDigest: row.eventDigest,
          chainDigest: row.chainDigest,
        }
      : undefined;
  }

  private async loadApprovalEvidence(
    approvalRequestId: string,
  ): Promise<AuthorizationReceiptApprovalEvidence | undefined> {
    const result = await this.sql.query<ApprovalVoteEvidenceRow>(
      `select request."id" as "approvalRequestId",
              request."resolvedAt" as "approvedAt",
              vote."approverId" as "approverId",
              vote."createdAt" as "voteApprovedAt"
         from "ApprovalRequest" as request
         left join "ApprovalVote" as vote
           on vote."approvalRequestId" = request."id"
          and vote."decision" = 'APPROVE'
        where request."id" = $1::uuid
          and request."status" = 'APPROVED'
        order by vote."createdAt" asc, vote."id" asc`,
      [approvalRequestId],
    );
    if (result.rows.length === 0) return undefined;
    const first = result.rows[0]!;
    return {
      approvalRequestId: first.approvalRequestId,
      ...(first.approvedAt ? { approvedAt: first.approvedAt.toISOString() } : {}),
      approvers: result.rows.flatMap((row) =>
        row.approverId && row.voteApprovedAt
          ? [{ approverId: row.approverId, approvedAt: row.voteApprovedAt.toISOString() }]
          : [],
      ),
    };
  }
}

export async function verifyAuthorizationReceipt(
  receipt: SignedAuthorizationReceipt,
  keys: AuditVerificationKeyResolver,
): Promise<boolean> {
  if (receipt.payload.schemaVersion !== AUTHORIZATION_RECEIPT_SCHEMA_VERSION) return false;
  const digest = receiptPayloadDigest(receipt.payload);
  if (digest !== receipt.receiptDigest) return false;
  const publicKey = await keys.resolvePublicKey(receipt.signingKeyId);
  if (!publicKey) return false;
  return verifyReceiptSignature(receipt, publicKey);
}

export function receiptPayloadDigest(payload: AuthorizationReceiptPayload): string {
  return sha256Base64Url(canonicalJson(payload));
}

function receiptSignaturePayload(receiptDigest: string): string {
  return `${RECEIPT_SIGNATURE_TYPE}\n${receiptDigest}`;
}

function verifyReceiptSignature(
  receipt: SignedAuthorizationReceipt,
  publicKey: Ed25519KeyInput,
): boolean {
  try {
    return verifyEd25519(
      receiptSignaturePayload(receipt.receiptDigest),
      Buffer.from(receipt.signature, "base64url"),
      publicKey,
    );
  } catch {
    return false;
  }
}

function assertTerminalOutcomeEvidence(outcome: OutcomeEvidenceRow): void {
  const terminal = outcome.status === "SUCCEEDED" || outcome.status === "FAILED_DEFINITIVE";
  if (!terminal || outcome.upstreamStatus === null || !outcome.resolvedAt) {
    throw new AuthorizationReceiptEvidenceUnavailableError(
      "Authorization receipt requires a terminal payment outcome",
    );
  }

  const requiredStrings = [
    outcome.intentDigest,
    outcome.authoritativeStateDigest,
    outcome.decisionId,
    outcome.policyId,
    outcome.protocol,
    outcome.operation,
  ];
  if (requiredStrings.some((value) => !value?.trim()) || outcome.policyVersion === null || !outcome.decisionEvaluatedAt) {
    throw new AuthorizationReceiptEvidenceUnavailableError(
      "Payment outcome predates canonical authorization-receipt evidence",
    );
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(outcome.intentDigest!)) {
    throw new AuthorizationReceiptEvidenceUnavailableError("Payment outcome has an invalid intent digest");
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(outcome.authoritativeStateDigest!)) {
    throw new AuthorizationReceiptEvidenceUnavailableError(
      "Payment outcome has an invalid authoritative-state digest",
    );
  }
}

function mapReceiptRow(row: ReceiptRow): SignedAuthorizationReceipt {
  if (!isAuthorizationReceiptPayload(row.payload)) {
    throw new Error(`Authorization receipt ${row.id} has malformed persisted payload`);
  }
  return {
    payload: row.payload,
    receiptDigest: row.receiptDigest,
    signingKeyId: row.signingKeyId,
    signature: row.integritySignature,
  };
}

function isAuthorizationReceiptPayload(value: unknown): value is AuthorizationReceiptPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === AUTHORIZATION_RECEIPT_SCHEMA_VERSION &&
    typeof record.receiptId === "string" &&
    typeof record.intentDigest === "string" &&
    typeof record.authority === "object" &&
    record.authority !== null &&
    typeof record.decision === "object" &&
    record.decision !== null &&
    typeof record.execution === "object" &&
    record.execution !== null &&
    typeof record.evidence === "object" &&
    record.evidence !== null &&
    typeof record.issuedAt === "string"
  );
}
