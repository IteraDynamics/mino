import type { QueryResultRow } from "pg";
import { canonicalJson, sha256Base64Url } from "../../infrastructure/crypto/canonical-json.js";
import { signEd25519, verifyEd25519 } from "../../infrastructure/crypto/ed25519.js";
import type {
  AuditSigningKeyProvider,
  AuditVerificationKeyResolver,
} from "../audit/postgres-audit-ledger.js";
import { redactSensitivePayload } from "../audit/audit-sink.js";
import type { AdminPermission, AdminRole } from "./admin-authorizer.js";

const ADMIN_AUDIT_CHAIN_VERSION = 1;
const ADMIN_AUDIT_SIGNATURE_TYPE = "mino.admin.audit.chain.v1";

export interface AdminChangeAuditEvent {
  readonly requestId: string;
  readonly organizationId: string;
  readonly principalId: string;
  readonly membershipId: string;
  readonly timestamp: Date;
  readonly permission: AdminPermission;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string;
  readonly roles: readonly AdminRole[];
  readonly beforeState?: unknown;
  readonly afterState?: unknown;
  readonly requestDigest: string;
  readonly metadata?: unknown;
}

export interface AdminAuditSqlExecutor {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ readonly rows: R[]; readonly rowCount: number | null }>;
}

export interface AdminAuditSqlTransaction extends AdminAuditSqlExecutor {
  release(): void;
}

export interface AdminAuditSqlClient extends AdminAuditSqlExecutor {
  connect(): Promise<AdminAuditSqlTransaction>;
}

export interface AdminAuditAppendResult {
  readonly chainSequence: string;
  readonly eventDigest: string;
  readonly chainDigest: string;
  readonly signingKeyId: string;
}

interface AdminAuditChainHeadRow extends QueryResultRow {
  chainSequence: string;
  chainDigest: string | null;
}

interface AdminAuditLogRow extends QueryResultRow {
  organizationId: string;
  requestId: string;
  principalId: string;
  membershipId: string;
  timestamp: Date;
  permission: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  roles: string[];
  beforeState: unknown | null;
  afterState: unknown | null;
  metadata: unknown | null;
  requestDigest: string;
  eventDigest: string;
  chainVersion: number;
  chainSequence: string;
  previousChainDigest: string | null;
  chainDigest: string;
  integritySignature: string;
  signingKeyId: string;
}

interface PersistedAdminAuditEvent {
  readonly requestId: string;
  readonly organizationId: string;
  readonly principalId: string;
  readonly membershipId: string;
  readonly timestamp: string;
  readonly permission: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly roles: readonly string[];
  readonly beforeState: unknown | null;
  readonly afterState: unknown | null;
  readonly metadata: unknown | null;
  readonly requestDigest: string;
}

export enum AdminAuditVerificationFailure {
  SEQUENCE_GAP = "SEQUENCE_GAP",
  PREVIOUS_DIGEST_MISMATCH = "PREVIOUS_DIGEST_MISMATCH",
  EVENT_DIGEST_MISMATCH = "EVENT_DIGEST_MISMATCH",
  CHAIN_DIGEST_MISMATCH = "CHAIN_DIGEST_MISMATCH",
  UNKNOWN_SIGNING_KEY = "UNKNOWN_SIGNING_KEY",
  INVALID_EVENT_SIGNATURE = "INVALID_EVENT_SIGNATURE",
  UNSUPPORTED_CHAIN_VERSION = "UNSUPPORTED_CHAIN_VERSION",
  HEAD_SEQUENCE_MISMATCH = "HEAD_SEQUENCE_MISMATCH",
  HEAD_DIGEST_MISMATCH = "HEAD_DIGEST_MISMATCH",
}

export interface AdminAuditVerificationResult {
  readonly valid: boolean;
  readonly checkedEvents: number;
  readonly headSequence: string;
  readonly headDigest?: string;
  readonly failure?: AdminAuditVerificationFailure;
  readonly brokenSequence?: string;
}

export class PostgresAdminChangeAuditLedger {
  public constructor(
    private readonly sql: AdminAuditSqlClient,
    private readonly signingKeys: AuditSigningKeyProvider,
  ) {}

  public async append(event: AdminChangeAuditEvent): Promise<AdminAuditAppendResult> {
    const tx = await this.sql.connect();
    try {
      await tx.query("begin");
      const result = await this.appendInTransaction(tx, event);
      await tx.query("commit");
      return result;
    } catch (error) {
      try {
        await tx.query("rollback");
      } catch {
        // Preserve the original persistence error.
      }
      throw error;
    } finally {
      tx.release();
    }
  }

  public async appendInTransaction(
    tx: AdminAuditSqlExecutor,
    event: AdminChangeAuditEvent,
  ): Promise<AdminAuditAppendResult> {
    validateEvent(event);
    const persisted = persistedEvent(event);
    const eventDigest = sha256Base64Url(canonicalJson(persisted));
    const signingKey = await this.signingKeys.getActiveSigningKey(event.organizationId);

    await tx.query(
      `insert into "AdminAuditChainHead" (
         "organizationId", "chainSequence", "chainDigest", "updatedAt"
       ) values ($1::uuid, 0, null, $2)
       on conflict ("organizationId") do nothing`,
      [event.organizationId, event.timestamp],
    );

    const head = (
      await tx.query<AdminAuditChainHeadRow>(
        `select "chainSequence", "chainDigest"
           from "AdminAuditChainHead"
          where "organizationId" = $1::uuid
          for update`,
        [event.organizationId],
      )
    ).rows[0];
    if (!head) {
      throw new Error("Administrative audit chain head could not be initialized");
    }

    const chainSequence = BigInt(head.chainSequence) + 1n;
    const previousChainDigest = head.chainDigest ?? undefined;
    const chainDigest = computeChainDigest({
      organizationId: event.organizationId,
      chainSequence,
      eventDigest,
      previousChainDigest,
    });
    const integritySignature = signEd25519(
      signaturePayload({
        organizationId: event.organizationId,
        chainSequence,
        eventDigest,
        previousChainDigest,
        chainDigest,
        signingKeyId: signingKey.keyId,
      }),
      signingKey.privateKey,
    ).toString("base64url");

    await tx.query(
      `insert into "AdminAuditLog" (
         "organizationId", "requestId", "principalId", "membershipId", "timestamp",
         "permission", "action", "resourceType", "resourceId", "roles",
         "beforeState", "afterState", "metadata", "requestDigest", "eventDigest",
         "chainVersion", "chainSequence", "previousChainDigest", "chainDigest",
         "integritySignature", "signingKeyId"
       ) values (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
         $6, $7, $8, $9, $10::text[],
         $11::jsonb, $12::jsonb, $13::jsonb, $14, $15,
         $16, $17::bigint, $18, $19,
         $20, $21
       )`,
      [
        persisted.organizationId,
        persisted.requestId,
        persisted.principalId,
        persisted.membershipId,
        event.timestamp,
        persisted.permission,
        persisted.action,
        persisted.resourceType,
        persisted.resourceId,
        [...persisted.roles],
        JSON.stringify(persisted.beforeState),
        JSON.stringify(persisted.afterState),
        JSON.stringify(persisted.metadata),
        persisted.requestDigest,
        eventDigest,
        ADMIN_AUDIT_CHAIN_VERSION,
        chainSequence.toString(10),
        previousChainDigest ?? null,
        chainDigest,
        integritySignature,
        signingKey.keyId,
      ],
    );

    const advanced = await tx.query(
      `update "AdminAuditChainHead"
          set "chainSequence" = $2::bigint,
              "chainDigest" = $3,
              "updatedAt" = $4
        where "organizationId" = $1::uuid`,
      [event.organizationId, chainSequence.toString(10), chainDigest, event.timestamp],
    );
    if (advanced.rowCount !== 1) {
      throw new Error("Administrative audit chain head could not be advanced");
    }

    return {
      chainSequence: chainSequence.toString(10),
      eventDigest,
      chainDigest,
      signingKeyId: signingKey.keyId,
    };
  }
}

export class PostgresAdminChangeAuditVerifier {
  public constructor(
    private readonly sql: Pick<AdminAuditSqlClient, "query">,
    private readonly verificationKeys: AuditVerificationKeyResolver,
  ) {}

  public async verifyOrganization(organizationId: string): Promise<AdminAuditVerificationResult> {
    const rows = (
      await this.sql.query<AdminAuditLogRow>(
        `select a.*
           from "AdminAuditLog" a
          where a."organizationId" = $1::uuid
          order by a."chainSequence" asc`,
        [organizationId],
      )
    ).rows;

    let expectedSequence = 1n;
    let previousChainDigest: string | undefined;
    let checkedEvents = 0;

    for (const row of rows) {
      const sequence = BigInt(row.chainSequence);
      if (row.chainVersion !== ADMIN_AUDIT_CHAIN_VERSION) {
        return failureResult(
          AdminAuditVerificationFailure.UNSUPPORTED_CHAIN_VERSION,
          checkedEvents,
          expectedSequence - 1n,
          previousChainDigest,
          sequence,
        );
      }
      if (sequence !== expectedSequence) {
        return failureResult(
          AdminAuditVerificationFailure.SEQUENCE_GAP,
          checkedEvents,
          expectedSequence - 1n,
          previousChainDigest,
          sequence,
        );
      }
      if ((row.previousChainDigest ?? undefined) !== previousChainDigest) {
        return failureResult(
          AdminAuditVerificationFailure.PREVIOUS_DIGEST_MISMATCH,
          checkedEvents,
          expectedSequence - 1n,
          previousChainDigest,
          sequence,
        );
      }

      const computedEventDigest = sha256Base64Url(canonicalJson(persistedEventFromRow(row)));
      if (computedEventDigest !== row.eventDigest) {
        return failureResult(
          AdminAuditVerificationFailure.EVENT_DIGEST_MISMATCH,
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
          AdminAuditVerificationFailure.CHAIN_DIGEST_MISMATCH,
          checkedEvents,
          expectedSequence - 1n,
          previousChainDigest,
          sequence,
        );
      }

      const publicKey = await this.verificationKeys.resolvePublicKey(row.signingKeyId);
      if (!publicKey) {
        return failureResult(
          AdminAuditVerificationFailure.UNKNOWN_SIGNING_KEY,
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
          AdminAuditVerificationFailure.INVALID_EVENT_SIGNATURE,
          checkedEvents,
          expectedSequence - 1n,
          previousChainDigest,
          sequence,
        );
      }

      checkedEvents += 1;
      previousChainDigest = row.chainDigest;
      expectedSequence += 1n;
    }

    const headSequence = expectedSequence - 1n;
    const storedHead = (
      await this.sql.query<AdminAuditChainHeadRow>(
        `select "chainSequence", "chainDigest"
           from "AdminAuditChainHead"
          where "organizationId" = $1::uuid`,
        [organizationId],
      )
    ).rows[0];
    const storedHeadSequence = storedHead ? BigInt(storedHead.chainSequence) : 0n;
    if (storedHeadSequence !== headSequence) {
      return {
        valid: false,
        checkedEvents,
        headSequence: headSequence.toString(10),
        ...(previousChainDigest ? { headDigest: previousChainDigest } : {}),
        failure: AdminAuditVerificationFailure.HEAD_SEQUENCE_MISMATCH,
        brokenSequence: storedHeadSequence.toString(10),
      };
    }
    if ((storedHead?.chainDigest ?? undefined) !== previousChainDigest) {
      return {
        valid: false,
        checkedEvents,
        headSequence: headSequence.toString(10),
        ...(previousChainDigest ? { headDigest: previousChainDigest } : {}),
        failure: AdminAuditVerificationFailure.HEAD_DIGEST_MISMATCH,
        brokenSequence: headSequence.toString(10),
      };
    }

    return {
      valid: true,
      checkedEvents,
      headSequence: headSequence.toString(10),
      ...(previousChainDigest ? { headDigest: previousChainDigest } : {}),
    };
  }
}

function persistedEvent(event: AdminChangeAuditEvent): PersistedAdminAuditEvent {
  return {
    requestId: event.requestId,
    organizationId: event.organizationId,
    principalId: event.principalId,
    membershipId: event.membershipId,
    timestamp: event.timestamp.toISOString(),
    permission: event.permission,
    action: event.action,
    resourceType: event.resourceType,
    resourceId: event.resourceId ?? null,
    roles: [...new Set(event.roles)].sort(),
    beforeState:
      event.beforeState === undefined ? null : jsonValue(redactAdminAuditValue(event.beforeState)),
    afterState:
      event.afterState === undefined ? null : jsonValue(redactAdminAuditValue(event.afterState)),
    metadata: event.metadata === undefined ? null : jsonValue(redactAdminAuditValue(event.metadata)),
    requestDigest: event.requestDigest,
  };
}

function persistedEventFromRow(row: AdminAuditLogRow): PersistedAdminAuditEvent {
  return {
    requestId: row.requestId,
    organizationId: row.organizationId,
    principalId: row.principalId,
    membershipId: row.membershipId,
    timestamp: row.timestamp.toISOString(),
    permission: row.permission,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    roles: row.roles,
    beforeState: row.beforeState,
    afterState: row.afterState,
    metadata: row.metadata,
    requestDigest: row.requestDigest,
  };
}

function computeChainDigest(args: {
  readonly organizationId: string;
  readonly chainSequence: bigint;
  readonly eventDigest: string;
  readonly previousChainDigest: string | undefined;
}): string {
  return sha256Base64Url(
    canonicalJson({
      type: ADMIN_AUDIT_SIGNATURE_TYPE,
      version: ADMIN_AUDIT_CHAIN_VERSION,
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
  readonly previousChainDigest: string | undefined;
  readonly chainDigest: string;
  readonly signingKeyId: string;
}): string {
  return canonicalJson({
    type: ADMIN_AUDIT_SIGNATURE_TYPE,
    version: ADMIN_AUDIT_CHAIN_VERSION,
    organizationId: args.organizationId,
    chainSequence: args.chainSequence.toString(10),
    previousChainDigest: args.previousChainDigest ?? null,
    eventDigest: args.eventDigest,
    chainDigest: args.chainDigest,
    signingKeyId: args.signingKeyId,
  });
}

function redactAdminAuditValue(value: unknown): unknown {
  return redactAdditionalSecrets(redactSensitivePayload(value), "");
}

const ADMIN_REDACT_KEYS = new Set([
  "secret",
  "password",
  "privatekey",
  "private_key",
  "clientsecret",
  "client_secret",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "bearer",
]);

function redactAdditionalSecrets(value: unknown, key: string): unknown {
  if (ADMIN_REDACT_KEYS.has(key.toLowerCase())) {
    return "[REDACTED]";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactAdditionalSecrets(entry, key));
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      output[entryKey] = redactAdditionalSecrets(entryValue, entryKey);
    }
    return output;
  }
  return value;
}

function jsonValue(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(canonicalJson(value));
}

function validateEvent(event: AdminChangeAuditEvent): void {
  if (!event.action.trim() || !event.resourceType.trim() || !event.requestDigest.trim()) {
    throw new Error("Administrative audit action, resource type, and request digest are required");
  }
  if (event.roles.length === 0) {
    throw new Error("Administrative audit event must snapshot at least one authorized role");
  }
  if (!Number.isFinite(event.timestamp.getTime())) {
    throw new Error("Administrative audit timestamp must be valid");
  }
}

function failureResult(
  failure: AdminAuditVerificationFailure,
  checkedEvents: number,
  headSequence: bigint,
  headDigest: string | undefined,
  brokenSequence: bigint,
): AdminAuditVerificationResult {
  return {
    valid: false,
    checkedEvents,
    headSequence: headSequence.toString(10),
    ...(headDigest ? { headDigest } : {}),
    failure,
    brokenSequence: brokenSequence.toString(10),
  };
}
