import type { QueryResultRow } from "pg";
import type { Ed25519KeyInput } from "../../infrastructure/crypto/ed25519.js";
import { signEd25519, verifyEd25519 } from "../../infrastructure/crypto/ed25519.js";
import { canonicalJson, sha256Base64Url } from "../../infrastructure/crypto/canonical-json.js";
import {
  redactSensitivePayload,
  type AuditSink,
  type GatewayAuditEvent,
} from "./audit-sink.js";

const AUDIT_CHAIN_VERSION = 1;
const AUDIT_SIGNATURE_TYPE = "mino.audit.chain.v1";
const AUDIT_CHECKPOINT_TYPE = "mino.audit.checkpoint.v1";

export interface AuditSigningKey {
  readonly keyId: string;
  readonly privateKey: Ed25519KeyInput;
}

export interface AuditSigningKeyProvider {
  getActiveSigningKey(organizationId: string): Promise<AuditSigningKey>;
}

export interface AuditVerificationKeyResolver {
  resolvePublicKey(keyId: string): Promise<Ed25519KeyInput | undefined>;
}

export interface AuditSqlTransaction {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ readonly rows: R[]; readonly rowCount: number | null }>;
  release(): void;
}

export interface AuditSqlClient {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ readonly rows: R[]; readonly rowCount: number | null }>;
  connect(): Promise<AuditSqlTransaction>;
}

interface ChainHeadRow extends QueryResultRow {
  chainSequence: string;
  chainDigest: string;
}

interface AuditLogRow extends QueryResultRow {
  id: string;
  organizationId: string;
  requestId: string;
  decisionId: string;
  userId: string;
  agentId: string;
  mandateId: string | null;
  timestamp: Date;
  protocol: string;
  operation: string;
  merchantDomain: string;
  merchantVendorId: string | null;
  requestedPayload: unknown;
  approvedPayload: unknown | null;
  decisionSnapshot: unknown;
  verdict: string;
  reasonCodes: string[];
  policyVersion: number | null;
  evaluationLatencyMicros: number;
  reservationId: string | null;
  upstreamStatus: number | null;
  requestDigest: string;
  eventDigest: string;
  chainVersion: number;
  chainSequence: string;
  previousChainDigest: string | null;
  chainDigest: string;
  integritySignature: string;
  signingKeyId: string;
  metadata: unknown | null;
}

export interface AuditChainCheckpoint {
  readonly version: 1;
  readonly organizationId: string;
  readonly chainSequence: string;
  readonly chainDigest: string | null;
  readonly issuedAt: string;
  readonly signingKeyId: string;
  readonly signature: string;
}

export enum AuditVerificationFailure {
  INVALID_CHECKPOINT_SIGNATURE = "INVALID_CHECKPOINT_SIGNATURE",
  CHECKPOINT_UNKNOWN_KEY = "CHECKPOINT_UNKNOWN_KEY",
  CHECKPOINT_TRUNCATED = "CHECKPOINT_TRUNCATED",
  CHECKPOINT_DIGEST_MISMATCH = "CHECKPOINT_DIGEST_MISMATCH",
  SEQUENCE_GAP = "SEQUENCE_GAP",
  PREVIOUS_DIGEST_MISMATCH = "PREVIOUS_DIGEST_MISMATCH",
  EVENT_DIGEST_MISMATCH = "EVENT_DIGEST_MISMATCH",
  CHAIN_DIGEST_MISMATCH = "CHAIN_DIGEST_MISMATCH",
  UNKNOWN_SIGNING_KEY = "UNKNOWN_SIGNING_KEY",
  INVALID_EVENT_SIGNATURE = "INVALID_EVENT_SIGNATURE",
  UNSUPPORTED_CHAIN_VERSION = "UNSUPPORTED_CHAIN_VERSION",
}

export interface AuditVerificationResult {
  readonly valid: boolean;
  readonly checkedEvents: number;
  readonly headSequence: string;
  readonly headDigest?: string;
  readonly failure?: AuditVerificationFailure;
  readonly brokenSequence?: string;
}

export class PostgresAuditLedger implements AuditSink {
  public constructor(
    private readonly sql: AuditSqlClient,
    private readonly signingKeys: AuditSigningKeyProvider,
  ) {}

  public async record(event: GatewayAuditEvent): Promise<void> {
    const signingKey = await this.signingKeys.getActiveSigningKey(event.organizationId);
    const persisted = persistedEvent(event);
    const eventDigest = sha256Base64Url(canonicalJson(persisted));
    const tx = await this.sql.connect();

    try {
      await tx.query("begin");
      await tx.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        [event.organizationId],
      );

      const headResult = await tx.query<ChainHeadRow>(
        `select "chainSequence"::text as "chainSequence", "chainDigest"
           from "AuditLog"
          where "organizationId" = $1::uuid
          order by "chainSequence" desc
          limit 1`,
        [event.organizationId],
      );
      const previous = headResult.rows[0];
      const sequence = previous ? BigInt(previous.chainSequence) + 1n : 1n;
      const previousChainDigest = previous?.chainDigest;
      const chainDigest = computeChainDigest({
        organizationId: event.organizationId,
        chainSequence: sequence,
        eventDigest,
        previousChainDigest,
      });
      const integritySignature = signEd25519(
        signaturePayload({
          organizationId: event.organizationId,
          chainSequence: sequence,
          eventDigest,
          previousChainDigest,
          chainDigest,
          signingKeyId: signingKey.keyId,
        }),
        signingKey.privateKey,
      ).toString("base64url");

      await tx.query(
        `insert into "AuditLog" (
           "organizationId", "requestId", "decisionId", "userId", "agentId", "mandateId", "timestamp",
           "protocol", "operation", "merchantDomain", "merchantVendorId", "requestedPayload", "approvedPayload",
           "decisionSnapshot", "verdict", "reasonCodes", "policyVersion", "evaluationLatencyMicros",
           "reservationId", "upstreamStatus", "requestDigest", "eventDigest", "chainVersion", "chainSequence",
           "previousChainDigest", "chainDigest", "integritySignature", "signingKeyId", "metadata"
         ) values (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7,
           $8, $9, $10, $11, $12::jsonb, $13::jsonb,
           $14::jsonb, $15::"DecisionVerdict", $16::text[], $17, $18,
           $19, $20, $21, $22, $23, $24::bigint,
           $25, $26, $27, $28, $29::jsonb
         )`,
        [
          persisted.organizationId,
          persisted.requestId,
          persisted.decisionId,
          persisted.userId,
          persisted.agentId,
          persisted.mandateId ?? null,
          event.timestamp,
          persisted.protocol,
          persisted.operation,
          persisted.merchantDomain,
          persisted.merchantVendorId ?? null,
          JSON.stringify(persisted.requestedPayload),
          persisted.approvedPayload === undefined ? null : JSON.stringify(persisted.approvedPayload),
          JSON.stringify(persisted.decisionSnapshot),
          persisted.decisionSnapshot.verdict,
          [...persisted.decisionSnapshot.reasons],
          persisted.decisionSnapshot.policyVersion ?? null,
          persisted.decisionSnapshot.evaluationLatencyMicros,
          persisted.reservationId ?? null,
          persisted.upstreamStatus ?? null,
          persisted.requestDigest,
          eventDigest,
          AUDIT_CHAIN_VERSION,
          sequence.toString(10),
          previousChainDigest ?? null,
          chainDigest,
          integritySignature,
          signingKey.keyId,
          null,
        ],
      );

      await tx.query("commit");
    } catch (error) {
      try {
        await tx.query("rollback");
      } catch {
        // Preserve the original audit persistence error.
      }
      throw error;
    } finally {
      tx.release();
    }
  }

  public async issueCheckpoint(
    organizationId: string,
    now: Date,
  ): Promise<AuditChainCheckpoint> {
    const headResult = await this.sql.query<ChainHeadRow>(
      `select "chainSequence"::text as "chainSequence", "chainDigest"
         from "AuditLog"
        where "organizationId" = $1::uuid
        order by "chainSequence" desc
        limit 1`,
      [organizationId],
    );
    const head = headResult.rows[0];
    const signingKey = await this.signingKeys.getActiveSigningKey(organizationId);
    const unsigned = {
      version: AUDIT_CHAIN_VERSION as 1,
      organizationId,
      chainSequence: head?.chainSequence ?? "0",
      chainDigest: head?.chainDigest ?? null,
      issuedAt: now.toISOString(),
      signingKeyId: signingKey.keyId,
    };
    const signature = signEd25519(
      canonicalJson({ type: AUDIT_CHECKPOINT_TYPE, ...unsigned }),
      signingKey.privateKey,
    ).toString("base64url");
    return { ...unsigned, signature };
  }
}

export class PostgresAuditVerifier {
  public constructor(
    private readonly sql: Pick<AuditSqlClient, "query">,
    private readonly verificationKeys: AuditVerificationKeyResolver,
  ) {}

  public async verifyOrganization(
    organizationId: string,
    checkpoint?: AuditChainCheckpoint,
  ): Promise<AuditVerificationResult> {
    if (checkpoint) {
      const checkpointFailure = await this.verifyCheckpoint(checkpoint, organizationId);
      if (checkpointFailure) {
        return {
          valid: false,
          checkedEvents: 0,
          headSequence: "0",
          failure: checkpointFailure,
        };
      }
    }

    const result = await this.sql.query<AuditLogRow>(
      `select *, "id"::text as "id", "chainSequence"::text as "chainSequence"
         from "AuditLog"
        where "organizationId" = $1::uuid
        order by "chainSequence" asc`,
      [organizationId],
    );

    let expectedSequence = 1n;
    let previousChainDigest: string | undefined;
    let checkedEvents = 0;
    const digestAtSequence = new Map<string, string>();

    for (const row of result.rows) {
      const sequence = BigInt(row.chainSequence);
      if (row.chainVersion !== AUDIT_CHAIN_VERSION) {
        return failureResult(
          AuditVerificationFailure.UNSUPPORTED_CHAIN_VERSION,
          checkedEvents,
          expectedSequence - 1n,
          previousChainDigest,
          sequence,
        );
      }
      if (sequence !== expectedSequence) {
        return failureResult(
          AuditVerificationFailure.SEQUENCE_GAP,
          checkedEvents,
          expectedSequence - 1n,
          previousChainDigest,
          sequence,
        );
      }
      if ((row.previousChainDigest ?? undefined) !== previousChainDigest) {
        return failureResult(
          AuditVerificationFailure.PREVIOUS_DIGEST_MISMATCH,
          checkedEvents,
          expectedSequence - 1n,
          previousChainDigest,
          sequence,
        );
      }

      const computedEventDigest = sha256Base64Url(canonicalJson(persistedEventFromRow(row)));
      if (computedEventDigest !== row.eventDigest) {
        return failureResult(
          AuditVerificationFailure.EVENT_DIGEST_MISMATCH,
          checkedEvents,
          expectedSequence - 1n,
          previousChainDigest,
          sequence,
        );
      }

      const computedChainDigest = computeChainDigest({
        organizationId: row.organizationId,
        chainSequence: sequence,
        eventDigest: row.eventDigest,
        previousChainDigest,
      });
      if (computedChainDigest !== row.chainDigest) {
        return failureResult(
          AuditVerificationFailure.CHAIN_DIGEST_MISMATCH,
          checkedEvents,
          expectedSequence - 1n,
          previousChainDigest,
          sequence,
        );
      }

      const publicKey = await this.verificationKeys.resolvePublicKey(row.signingKeyId);
      if (!publicKey) {
        return failureResult(
          AuditVerificationFailure.UNKNOWN_SIGNING_KEY,
          checkedEvents,
          expectedSequence - 1n,
          previousChainDigest,
          sequence,
        );
      }
      if (
        !verifyEd25519(
          signaturePayload({
            organizationId: row.organizationId,
            chainSequence: sequence,
            eventDigest: row.eventDigest,
            previousChainDigest,
            chainDigest: row.chainDigest,
            signingKeyId: row.signingKeyId,
          }),
          Buffer.from(row.integritySignature, "base64url"),
          publicKey,
        )
      ) {
        return failureResult(
          AuditVerificationFailure.INVALID_EVENT_SIGNATURE,
          checkedEvents,
          expectedSequence - 1n,
          previousChainDigest,
          sequence,
        );
      }

      checkedEvents += 1;
      digestAtSequence.set(row.chainSequence, row.chainDigest);
      previousChainDigest = row.chainDigest;
      expectedSequence += 1n;
    }

    const headSequence = expectedSequence - 1n;
    if (checkpoint) {
      const checkpointSequence = BigInt(checkpoint.chainSequence);
      if (checkpointSequence > headSequence) {
        return {
          valid: false,
          checkedEvents,
          headSequence: headSequence.toString(10),
          ...(previousChainDigest ? { headDigest: previousChainDigest } : {}),
          failure: AuditVerificationFailure.CHECKPOINT_TRUNCATED,
          brokenSequence: checkpoint.chainSequence,
        };
      }
      if (checkpointSequence > 0n) {
        const localDigest = digestAtSequence.get(checkpoint.chainSequence);
        if (localDigest !== checkpoint.chainDigest) {
          return {
            valid: false,
            checkedEvents,
            headSequence: headSequence.toString(10),
            ...(previousChainDigest ? { headDigest: previousChainDigest } : {}),
            failure: AuditVerificationFailure.CHECKPOINT_DIGEST_MISMATCH,
            brokenSequence: checkpoint.chainSequence,
          };
        }
      }
    }

    return {
      valid: true,
      checkedEvents,
      headSequence: headSequence.toString(10),
      ...(previousChainDigest ? { headDigest: previousChainDigest } : {}),
    };
  }

  private async verifyCheckpoint(
    checkpoint: AuditChainCheckpoint,
    expectedOrganizationId: string,
  ): Promise<AuditVerificationFailure | undefined> {
    if (
      checkpoint.version !== AUDIT_CHAIN_VERSION ||
      checkpoint.organizationId !== expectedOrganizationId
    ) {
      return AuditVerificationFailure.INVALID_CHECKPOINT_SIGNATURE;
    }
    const publicKey = await this.verificationKeys.resolvePublicKey(checkpoint.signingKeyId);
    if (!publicKey) {
      return AuditVerificationFailure.CHECKPOINT_UNKNOWN_KEY;
    }
    const { signature, ...unsigned } = checkpoint;
    return verifyEd25519(
      canonicalJson({ type: AUDIT_CHECKPOINT_TYPE, ...unsigned }),
      Buffer.from(signature, "base64url"),
      publicKey,
    )
      ? undefined
      : AuditVerificationFailure.INVALID_CHECKPOINT_SIGNATURE;
  }
}

interface PersistedAuditEvent {
  readonly requestId: string;
  readonly decisionId: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly mandateId: string;
  readonly timestamp: string;
  readonly protocol: "ACP";
  readonly operation: string;
  readonly merchantDomain: string;
  readonly merchantVendorId?: string;
  readonly requestedPayload: unknown;
  readonly approvedPayload?: unknown;
  readonly decisionSnapshot: {
    readonly decisionId: string;
    readonly requestId: string;
    readonly verdict: string;
    readonly reasons: readonly string[];
    readonly requestedAmount: unknown;
    readonly policyAmount?: unknown;
    readonly approvedAmount?: unknown;
    readonly mandateId: string;
    readonly policyId: string;
    readonly policyVersion: number;
    readonly eligibleForDelegationAssertion: boolean;
    readonly approval?: unknown;
    readonly evaluationLatencyMicros: number;
    readonly evaluatedAt: string;
  };
  readonly requestDigest: string;
  readonly reservationId?: string;
  readonly upstreamStatus?: number;
}

function persistedEvent(event: GatewayAuditEvent): PersistedAuditEvent {
  return {
    requestId: event.requestId,
    decisionId: event.decisionId,
    organizationId: event.organizationId,
    userId: event.userId,
    agentId: event.agentId,
    mandateId: event.mandateId,
    timestamp: event.timestamp.toISOString(),
    protocol: event.protocol,
    operation: event.operation,
    merchantDomain: event.merchantDomain,
    ...(event.merchantVendorId ? { merchantVendorId: event.merchantVendorId } : {}),
    requestedPayload: jsonValue(redactSensitivePayload(event.requestedPayload)),
    ...(event.approvedPayload !== undefined
      ? { approvedPayload: jsonValue(redactSensitivePayload(event.approvedPayload)) }
      : {}),
    decisionSnapshot: jsonValue(event.decision) as PersistedAuditEvent["decisionSnapshot"],
    requestDigest: event.requestDigest,
    ...(event.reservationId ? { reservationId: event.reservationId } : {}),
    ...(event.upstreamStatus !== undefined ? { upstreamStatus: event.upstreamStatus } : {}),
  };
}

function persistedEventFromRow(row: AuditLogRow): PersistedAuditEvent {
  return {
    requestId: row.requestId,
    decisionId: row.decisionId,
    organizationId: row.organizationId,
    userId: row.userId,
    agentId: row.agentId,
    mandateId: row.mandateId ?? "",
    timestamp: row.timestamp.toISOString(),
    protocol: "ACP",
    operation: row.operation,
    merchantDomain: row.merchantDomain,
    ...(row.merchantVendorId ? { merchantVendorId: row.merchantVendorId } : {}),
    requestedPayload: row.requestedPayload,
    ...(row.approvedPayload !== null ? { approvedPayload: row.approvedPayload } : {}),
    decisionSnapshot: row.decisionSnapshot as PersistedAuditEvent["decisionSnapshot"],
    requestDigest: row.requestDigest,
    ...(row.reservationId ? { reservationId: row.reservationId } : {}),
    ...(row.upstreamStatus !== null ? { upstreamStatus: row.upstreamStatus } : {}),
  };
}

function jsonValue(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(canonicalJson(value));
}

function computeChainDigest(args: {
  readonly organizationId: string;
  readonly chainSequence: bigint;
  readonly eventDigest: string;
  readonly previousChainDigest?: string;
}): string {
  return sha256Base64Url(
    canonicalJson({
      type: AUDIT_SIGNATURE_TYPE,
      version: AUDIT_CHAIN_VERSION,
      organizationId: args.organizationId,
      chainSequence: args.chainSequence.toString(10),
      previousChainDigest: args.previousChainDigest ?? null,
      eventDigest: args.eventDigest,
    }),
  );
}

function signaturePayload(args: {
  readonly organizationId: string;
  readonly chainSequence: bigint;
  readonly eventDigest: string;
  readonly previousChainDigest?: string;
  readonly chainDigest: string;
  readonly signingKeyId: string;
}): string {
  return canonicalJson({
    type: AUDIT_SIGNATURE_TYPE,
    version: AUDIT_CHAIN_VERSION,
    organizationId: args.organizationId,
    chainSequence: args.chainSequence.toString(10),
    previousChainDigest: args.previousChainDigest ?? null,
    eventDigest: args.eventDigest,
    chainDigest: args.chainDigest,
    signingKeyId: args.signingKeyId,
  });
}

function failureResult(
  failure: AuditVerificationFailure,
  checkedEvents: number,
  headSequence: bigint,
  headDigest: string | undefined,
  brokenSequence: bigint,
): AuditVerificationResult {
  return {
    valid: false,
    checkedEvents,
    headSequence: headSequence.toString(10),
    ...(headDigest ? { headDigest } : {}),
    failure,
    brokenSequence: brokenSequence.toString(10),
  };
}
