import type { QueryResultRow } from "pg";
import type { Ed25519KeyInput } from "../../infrastructure/crypto/ed25519.js";
import { signEd25519, verifyEd25519 } from "../../infrastructure/crypto/ed25519.js";
import { canonicalJson, sha256Base64Url } from "../../infrastructure/crypto/canonical-json.js";
import {
  AUTHORIZATION_RECEIPT_SCHEMA_VERSION,
  type AuthorizationReceiptApprovalEvidence,
  type AuthorizationReceiptExecutionStatus,
  type AuthorizationReceiptPayload,
  type SignedAuthorizationReceipt,
} from "../../domain/economic/authorization-receipt.js";
import type {
  EconomicOperation,
  EconomicProviderProtocol,
} from "../../domain/economic/economic-intent.types.js";
import type {
  AuditSigningKeyProvider,
  AuditVerificationKeyResolver,
} from "../audit/postgres-audit-ledger.js";

const RECEIPT_SIGNATURE_TYPE = "mino.authorization.receipt.v1";
const HUMAN_APPROVAL_GRANTED = "HUMAN_APPROVAL_GRANTED";

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
  reservationId: string;
  idempotencyKey: string;
  requestDigest: string;
  checkoutSessionId: string;
  amountMinor: string;
  currency: string;
  status: string;
  upstreamStatus: number | null;
  resolvedAt: Date | null;
}

interface AuditAuthorizationRow extends QueryResultRow {
  organizationId: string;
  userId: string;
  agentId: string;
  mandateId: string | null;
  decisionId: string;
  timestamp: Date;
  protocol: string;
  operation: string;
  decisionSnapshot: unknown;
  verdict: string;
  reasonCodes: string[];
  policyVersion: number | null;
  chainSequence: string;
  eventDigest: string;
  chainDigest: string;
}

interface ApprovalVoteEvidenceRow extends QueryResultRow {
  approvalRequestId: string;
  approvalData: unknown | null;
  approvedAt: Date | null;
  approverId: string | null;
  voteApprovedAt: Date | null;
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

interface DecisionEvidence {
  readonly intentDigest: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly evaluatedAt: string;
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
 * The source records deliberately remain separated:
 * - AuditLog is the durable pre-execution authorization evidence.
 * - PaymentOutcome is the durable execution-result evidence.
 * - AuthorizationReceipt binds the two records to one canonical intent digest.
 *
 * Receipt signing uses the durable audit signing-key family. The signature is
 * domain-separated from the audit chain, so a valid audit signature cannot be
 * replayed as a receipt signature.
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
    assertTerminalOutcome(outcome);

    const authorization = await this.loadAuthorizationAudit(outcome);
    if (!authorization) {
      throw new AuthorizationReceiptEvidenceUnavailableError(
        "Authorization receipt requires the pre-execution ALLOW audit event",
      );
    }
    assertAuditIdentityBinding(outcome, authorization);

    const decision = decisionEvidence(authorization);
    const approval = authorization.reasonCodes.includes(HUMAN_APPROVAL_GRANTED)
      ? await this.loadApprovalEvidence(outcome, decision.intentDigest)
      : undefined;
    if (authorization.reasonCodes.includes(HUMAN_APPROVAL_GRANTED) && !approval) {
      throw new AuthorizationReceiptEvidenceUnavailableError(
        "Authorization receipt requires intent-bound human approval evidence",
      );
    }

    const receiptId = this.generateId();
    const payload: AuthorizationReceiptPayload = Object.freeze({
      schemaVersion: AUTHORIZATION_RECEIPT_SCHEMA_VERSION,
      receiptId,
      intentDigest: decision.intentDigest,
      authority: {
        organizationId: outcome.organizationId,
        userId: outcome.userId,
        agentId: outcome.agentId,
        mandateId: outcome.mandateId,
        policyId: decision.policyId,
        policyVersion: decision.policyVersion,
      },
      decision: {
        decisionId: authorization.decisionId,
        verdict: "ALLOW",
        reasonCodes: [...authorization.reasonCodes],
        evaluatedAt: decision.evaluatedAt,
      },
      ...(approval ? { approval } : {}),
      execution: {
        paymentOutcomeId: outcome.id,
        protocol: authorization.protocol as EconomicProviderProtocol,
        operation: authorization.operation as EconomicOperation,
        status: outcome.status as AuthorizationReceiptExecutionStatus,
        providerReference: outcome.checkoutSessionId,
        amountMinor: outcome.amountMinor,
        currency: outcome.currency,
        upstreamStatus: outcome.upstreamStatus!,
        resolvedAt: outcome.resolvedAt!.toISOString(),
      },
      evidence: {
        executionRequestDigest: outcome.requestDigest,
        audit: {
          chainSequence: authorization.chainSequence,
          eventDigest: authorization.eventDigest,
          chainDigest: authorization.chainDigest,
        },
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
        decision.intentDigest,
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
    if (concurrent.payload.intentDigest !== decision.intentDigest) {
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

  /**
   * Use the earliest ALLOW event for the reservation. A later reconciliation read
   * may observe provider state after the consequence (for example `completed`) and
   * therefore has a different canonical intent. The first ALLOW event is the one
   * that actually authorized dispatch.
   */
  private async loadAuthorizationAudit(
    outcome: OutcomeEvidenceRow,
  ): Promise<AuditAuthorizationRow | undefined> {
    const result = await this.sql.query<AuditAuthorizationRow>(
      `select "organizationId", "userId", "agentId", "mandateId", "decisionId",
              "timestamp", "protocol", "operation", "decisionSnapshot", "verdict",
              "reasonCodes", "policyVersion", "chainSequence"::text as "chainSequence",
              "eventDigest", "chainDigest"
         from "AuditLog"
        where "organizationId" = $1::uuid
          and "mandateId" = $2::uuid
          and "reservationId" = $3
          and "verdict" = 'ALLOW'
        order by "chainSequence" asc
        limit 1`,
      [outcome.organizationId, outcome.mandateId, outcome.reservationId],
    );
    return result.rows[0];
  }

  private async loadApprovalEvidence(
    outcome: OutcomeEvidenceRow,
    intentDigest: string,
  ): Promise<AuthorizationReceiptApprovalEvidence | undefined> {
    const result = await this.sql.query<ApprovalVoteEvidenceRow>(
      `select request."id" as "approvalRequestId",
              request."approvalData" as "approvalData",
              request."resolvedAt" as "approvedAt",
              vote."approverId" as "approverId",
              vote."createdAt" as "voteApprovedAt"
         from "ApprovalRequest" as request
         left join "ApprovalVote" as vote
           on vote."approvalRequestId" = request."id"
          and vote."decision" = 'APPROVE'
        where request."organizationId" = $1::uuid
          and request."mandateId" = $2::uuid
          and request."idempotencyKey" = $3
          and request."status" = 'APPROVED'
        order by vote."createdAt" asc, vote."id" asc`,
      [outcome.organizationId, outcome.mandateId, outcome.idempotencyKey],
    );
    if (result.rows.length === 0) return undefined;

    const first = result.rows[0]!;
    if (approvalIntentDigest(first.approvalData) !== intentDigest) {
      return undefined;
    }
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

function assertTerminalOutcome(outcome: OutcomeEvidenceRow): void {
  const terminal = outcome.status === "SUCCEEDED" || outcome.status === "FAILED_DEFINITIVE";
  if (!terminal || outcome.upstreamStatus === null || !outcome.resolvedAt) {
    throw new AuthorizationReceiptEvidenceUnavailableError(
      "Authorization receipt requires a terminal payment outcome",
    );
  }
}

function assertAuditIdentityBinding(
  outcome: OutcomeEvidenceRow,
  audit: AuditAuthorizationRow,
): void {
  if (
    audit.organizationId !== outcome.organizationId ||
    audit.userId !== outcome.userId ||
    audit.agentId !== outcome.agentId ||
    audit.mandateId !== outcome.mandateId ||
    audit.verdict !== "ALLOW"
  ) {
    throw new AuthorizationReceiptEvidenceUnavailableError(
      "Authorization audit does not bind to the terminal payment outcome",
    );
  }
}

function decisionEvidence(audit: AuditAuthorizationRow): DecisionEvidence {
  if (!audit.decisionSnapshot || typeof audit.decisionSnapshot !== "object" || Array.isArray(audit.decisionSnapshot)) {
    throw new AuthorizationReceiptEvidenceUnavailableError("Authorization decision snapshot is malformed");
  }
  const snapshot = audit.decisionSnapshot as Record<string, unknown>;
  const intentDigest = snapshot.intentDigest;
  const policyId = snapshot.policyId;
  const policyVersion = snapshot.policyVersion;
  const evaluatedAt = snapshot.evaluatedAt;

  if (typeof intentDigest !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(intentDigest)) {
    throw new AuthorizationReceiptEvidenceUnavailableError(
      "Authorization decision is not bound to a canonical economic intent",
    );
  }
  if (typeof policyId !== "string" || !policyId.trim()) {
    throw new AuthorizationReceiptEvidenceUnavailableError("Authorization decision is missing policy identity");
  }
  if (!Number.isSafeInteger(policyVersion) || policyVersion !== audit.policyVersion) {
    throw new AuthorizationReceiptEvidenceUnavailableError("Authorization decision policy version is inconsistent");
  }
  const evaluatedAtIso =
    typeof evaluatedAt === "string" && !Number.isNaN(Date.parse(evaluatedAt))
      ? new Date(evaluatedAt).toISOString()
      : audit.timestamp.toISOString();

  return {
    intentDigest,
    policyId,
    policyVersion: policyVersion as number,
    evaluatedAt: evaluatedAtIso,
  };
}

function approvalIntentDigest(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const digest = (value as Record<string, unknown>).intentDigest;
  return typeof digest === "string" && /^[A-Za-z0-9_-]{43}$/.test(digest)
    ? digest
    : undefined;
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
