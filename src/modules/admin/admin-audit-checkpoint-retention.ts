import { createHmac } from "node:crypto";
import type { QueryResultRow } from "pg";
import { canonicalJson, sha256Base64Url } from "../../infrastructure/crypto/canonical-json.js";
import { signEd25519, verifyEd25519 } from "../../infrastructure/crypto/ed25519.js";
import type {
  AuditSigningKeyProvider,
  AuditVerificationKeyResolver,
} from "../audit/postgres-audit-ledger.js";
import type {
  AdminAuditVerificationResult,
  PostgresAdminChangeAuditVerifier,
} from "./admin-change-audit-ledger.js";

const ADMIN_AUDIT_CHECKPOINT_TYPE = "mino.admin.audit.checkpoint.v1" as const;
const ADMIN_RETENTION_EVENT_TYPE = "mino.admin.audit.checkpoint.retention.v1" as const;
const ADMIN_RETENTION_EVENT_ID_TYPE = "mino.admin.audit.checkpoint.retention.event-id.v1";
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_STABLE_ISSUE_ATTEMPTS = 3;

export interface AdminAuditCheckpointSqlClient {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ readonly rows: R[]; readonly rowCount: number | null }>;
}

export interface AdminAuditChainCheckpoint {
  readonly version: 1;
  readonly organizationId: string;
  readonly chainSequence: string;
  readonly chainDigest: string | null;
  readonly issuedAt: string;
  readonly signingKeyId: string;
  readonly signature: string;
}

interface AdminAuditHeadRow extends QueryResultRow {
  organizationId: string;
  chainSequence: string;
  chainDigest: string;
  updatedAt: Date;
}

interface AdminAuditDigestRow extends QueryResultRow {
  chainDigest: string;
}

export class PostgresAdminAuditCheckpointIssuer {
  public constructor(
    private readonly sql: AdminAuditCheckpointSqlClient,
    private readonly signingKeys: AuditSigningKeyProvider,
  ) {}

  public async issueCheckpoint(
    organizationId: string,
    now: Date,
  ): Promise<AdminAuditChainCheckpoint> {
    if (!Number.isFinite(now.getTime())) {
      throw new Error("Administrative audit checkpoint time must be valid");
    }
    const head = (
      await this.sql.query<AdminAuditHeadRow>(
        `select "organizationId",
                "chainSequence"::text as "chainSequence",
                "chainDigest",
                "updatedAt"
           from "AdminAuditChainHead"
          where "organizationId" = $1::uuid`,
        [organizationId],
      )
    ).rows[0];
    const signingKey = await this.signingKeys.getActiveSigningKey(organizationId);
    const unsigned = {
      version: 1 as const,
      organizationId,
      chainSequence: head?.chainSequence ?? "0",
      chainDigest: head?.chainDigest ?? null,
      issuedAt: now.toISOString(),
      signingKeyId: signingKey.keyId,
    };
    const signature = signEd25519(
      canonicalJson({ type: ADMIN_AUDIT_CHECKPOINT_TYPE, ...unsigned }),
      signingKey.privateKey,
    ).toString("base64url");
    return { ...unsigned, signature };
  }
}

export enum AdminAuditCheckpointVerificationFailure {
  MALFORMED_CHECKPOINT = "MALFORMED_CHECKPOINT",
  CHECKPOINT_ORGANIZATION_MISMATCH = "CHECKPOINT_ORGANIZATION_MISMATCH",
  CHECKPOINT_UNKNOWN_KEY = "CHECKPOINT_UNKNOWN_KEY",
  INVALID_CHECKPOINT_SIGNATURE = "INVALID_CHECKPOINT_SIGNATURE",
  DATABASE_CHAIN_INVALID = "DATABASE_CHAIN_INVALID",
  CHECKPOINT_TRUNCATED = "CHECKPOINT_TRUNCATED",
  CHECKPOINT_DIGEST_MISMATCH = "CHECKPOINT_DIGEST_MISMATCH",
}

export interface AdminAuditCheckpointVerificationResult {
  readonly valid: boolean;
  readonly checkpointSequence: string;
  readonly currentHeadSequence: string;
  readonly currentHeadDigest?: string;
  readonly failure?: AdminAuditCheckpointVerificationFailure;
  readonly databaseVerification?: AdminAuditVerificationResult;
}

export class PostgresRetainedAdminAuditVerifier {
  public constructor(
    private readonly sql: AdminAuditCheckpointSqlClient,
    private readonly chainVerifier: Pick<PostgresAdminChangeAuditVerifier, "verifyOrganization">,
    private readonly verificationKeys: AuditVerificationKeyResolver,
  ) {}

  public async verifyOrganization(
    organizationId: string,
    checkpoint: AdminAuditChainCheckpoint,
  ): Promise<AdminAuditCheckpointVerificationResult> {
    const checkpointSequence = parseCheckpointSequence(checkpoint);
    if (checkpointSequence === undefined) {
      return checkpointFailure(
        AdminAuditCheckpointVerificationFailure.MALFORMED_CHECKPOINT,
        checkpoint.chainSequence,
        "0",
      );
    }
    if (checkpoint.organizationId !== organizationId) {
      return checkpointFailure(
        AdminAuditCheckpointVerificationFailure.CHECKPOINT_ORGANIZATION_MISMATCH,
        checkpoint.chainSequence,
        "0",
      );
    }
    const publicKey = await this.verificationKeys.resolvePublicKey(checkpoint.signingKeyId);
    if (!publicKey) {
      return checkpointFailure(
        AdminAuditCheckpointVerificationFailure.CHECKPOINT_UNKNOWN_KEY,
        checkpoint.chainSequence,
        "0",
      );
    }
    if (
      !verifyEd25519(
        checkpointSignaturePayload(checkpoint),
        Buffer.from(checkpoint.signature, "base64url"),
        publicKey,
      )
    ) {
      return checkpointFailure(
        AdminAuditCheckpointVerificationFailure.INVALID_CHECKPOINT_SIGNATURE,
        checkpoint.chainSequence,
        "0",
      );
    }

    const databaseVerification = await this.chainVerifier.verifyOrganization(organizationId);
    if (!databaseVerification.valid) {
      return {
        valid: false,
        checkpointSequence: checkpoint.chainSequence,
        currentHeadSequence: databaseVerification.headSequence,
        ...(databaseVerification.headDigest
          ? { currentHeadDigest: databaseVerification.headDigest }
          : {}),
        failure: AdminAuditCheckpointVerificationFailure.DATABASE_CHAIN_INVALID,
        databaseVerification,
      };
    }

    const currentHeadSequence = BigInt(databaseVerification.headSequence);
    if (checkpointSequence > currentHeadSequence) {
      return {
        valid: false,
        checkpointSequence: checkpoint.chainSequence,
        currentHeadSequence: databaseVerification.headSequence,
        ...(databaseVerification.headDigest
          ? { currentHeadDigest: databaseVerification.headDigest }
          : {}),
        failure: AdminAuditCheckpointVerificationFailure.CHECKPOINT_TRUNCATED,
      };
    }

    if (checkpointSequence === 0n) {
      return {
        valid: true,
        checkpointSequence: checkpoint.chainSequence,
        currentHeadSequence: databaseVerification.headSequence,
        ...(databaseVerification.headDigest
          ? { currentHeadDigest: databaseVerification.headDigest }
          : {}),
      };
    }

    const digestAtCheckpoint = (
      await this.sql.query<AdminAuditDigestRow>(
        `select "chainDigest"
           from "AdminAuditLog"
          where "organizationId" = $1::uuid
            and "chainSequence" = $2::bigint`,
        [organizationId, checkpoint.chainSequence],
      )
    ).rows[0]?.chainDigest;
    if (!digestAtCheckpoint || digestAtCheckpoint !== checkpoint.chainDigest) {
      return {
        valid: false,
        checkpointSequence: checkpoint.chainSequence,
        currentHeadSequence: databaseVerification.headSequence,
        ...(databaseVerification.headDigest
          ? { currentHeadDigest: databaseVerification.headDigest }
          : {}),
        failure: AdminAuditCheckpointVerificationFailure.CHECKPOINT_DIGEST_MISMATCH,
      };
    }

    return {
      valid: true,
      checkpointSequence: checkpoint.chainSequence,
      currentHeadSequence: databaseVerification.headSequence,
      ...(databaseVerification.headDigest
        ? { currentHeadDigest: databaseVerification.headDigest }
        : {}),
    };
  }
}

export interface AdminAuditCheckpointRetentionEvent {
  readonly eventId: string;
  readonly type: typeof ADMIN_RETENTION_EVENT_TYPE;
  readonly checkpoint: AdminAuditChainCheckpoint;
}

export interface AdminAuditCheckpointRetainer {
  retain(event: AdminAuditCheckpointRetentionEvent): Promise<void>;
}

export interface WebhookAdminAuditCheckpointRetainerOptions {
  readonly endpoint: string;
  readonly secret: string;
  readonly timeoutMs?: number;
}

export class WebhookAdminAuditCheckpointRetainer implements AdminAuditCheckpointRetainer {
  private readonly timeoutMs: number;

  public constructor(private readonly options: WebhookAdminAuditCheckpointRetainerOptions) {
    const url = new URL(options.endpoint);
    if (url.protocol !== "https:") {
      throw new Error("Administrative audit checkpoint retention endpoint must use HTTPS");
    }
    if (options.secret.length < 32) {
      throw new Error("Administrative audit checkpoint retention secret must contain at least 32 characters");
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("Administrative audit checkpoint retention timeout must be a positive integer");
    }
  }

  public async retain(event: AdminAuditCheckpointRetentionEvent): Promise<void> {
    const body = canonicalJson(event);
    const timestamp = Math.floor(Date.now() / 1_000).toString(10);
    const signature = createHmac("sha256", this.options.secret)
      .update(`${timestamp}.${body}`)
      .digest("hex");

    const response = await fetch(this.options.endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        "X-Mino-Event-Id": event.eventId,
        "X-Mino-Audit-Kind": "admin",
        "X-Mino-Audit-Organization-Id": event.checkpoint.organizationId,
        "X-Mino-Audit-Sequence": event.checkpoint.chainSequence,
        "X-Mino-Signature": `t=${timestamp},v1=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(
        `Administrative audit checkpoint retention endpoint rejected event with HTTP ${response.status}`,
      );
    }
  }
}

export interface AdminAuditCheckpointRetentionWorkerOptions {
  readonly batchSize?: number;
}

export interface AdminAuditCheckpointRetentionRunResult {
  readonly considered: number;
  readonly delivered: number;
  readonly alreadyDelivered: number;
  readonly failed: number;
}

interface AdminCheckpointIssuer {
  issueCheckpoint(organizationId: string, now: Date): Promise<AdminAuditChainCheckpoint>;
}

export class AdminAuditCheckpointRetentionWorker {
  private readonly batchSize: number;
  private cursorOrganizationId: string | undefined;
  private readonly deliveredEventByOrganization = new Map<string, string>();

  public constructor(
    private readonly sql: AdminAuditCheckpointSqlClient,
    private readonly issuer: AdminCheckpointIssuer,
    private readonly retainer: AdminAuditCheckpointRetainer,
    options: AdminAuditCheckpointRetentionWorkerOptions = {},
  ) {
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize <= 0) {
      throw new Error("Administrative audit checkpoint retention batch size must be a positive integer");
    }
  }

  public async runOnce(): Promise<AdminAuditCheckpointRetentionRunResult> {
    let heads = await this.loadHeads(this.cursorOrganizationId);
    if (heads.length === 0 && this.cursorOrganizationId) {
      this.cursorOrganizationId = undefined;
      heads = await this.loadHeads(undefined);
    }
    this.cursorOrganizationId =
      heads.length === this.batchSize ? heads[heads.length - 1]?.organizationId : undefined;

    let delivered = 0;
    let alreadyDelivered = 0;
    let failed = 0;
    for (const head of heads) {
      try {
        const checkpoint = await this.issueStableCheckpoint(head.organizationId);
        const event = adminRetentionEvent(checkpoint);
        if (this.deliveredEventByOrganization.get(head.organizationId) === event.eventId) {
          alreadyDelivered += 1;
          continue;
        }
        await this.retainer.retain(event);
        this.deliveredEventByOrganization.set(head.organizationId, event.eventId);
        delivered += 1;
      } catch {
        failed += 1;
      }
    }

    return { considered: heads.length, delivered, alreadyDelivered, failed };
  }

  private async loadHeads(afterOrganizationId: string | undefined): Promise<AdminAuditHeadRow[]> {
    const result = await this.sql.query<AdminAuditHeadRow>(
      `select h."organizationId",
              h."chainSequence"::text as "chainSequence",
              h."chainDigest",
              h."updatedAt"
         from "AdminAuditChainHead" h
        where h."chainSequence" > 0
          and h."chainDigest" is not null
          and ($1::uuid is null or h."organizationId" > $1::uuid)
        order by h."organizationId" asc
        limit $2`,
      [afterOrganizationId ?? null, this.batchSize],
    );
    return result.rows;
  }

  private async issueStableCheckpoint(organizationId: string): Promise<AdminAuditChainCheckpoint> {
    for (let attempt = 0; attempt < MAX_STABLE_ISSUE_ATTEMPTS; attempt += 1) {
      const before = await this.loadHead(organizationId);
      if (!before) {
        throw new Error("Administrative audit chain head disappeared before checkpoint issuance");
      }
      const checkpoint = await this.issuer.issueCheckpoint(organizationId, before.updatedAt);
      if (
        checkpoint.chainSequence === before.chainSequence &&
        checkpoint.chainDigest === before.chainDigest
      ) {
        return checkpoint;
      }
    }
    throw new Error("Administrative audit chain advanced repeatedly while issuing retention checkpoint");
  }

  private async loadHead(organizationId: string): Promise<AdminAuditHeadRow | undefined> {
    const result = await this.sql.query<AdminAuditHeadRow>(
      `select h."organizationId",
              h."chainSequence"::text as "chainSequence",
              h."chainDigest",
              h."updatedAt"
         from "AdminAuditChainHead" h
        where h."organizationId" = $1::uuid
          and h."chainSequence" > 0
          and h."chainDigest" is not null`,
      [organizationId],
    );
    return result.rows[0];
  }
}

export function adminRetentionEvent(
  checkpoint: AdminAuditChainCheckpoint,
): AdminAuditCheckpointRetentionEvent {
  const eventId = sha256Base64Url(
    canonicalJson({
      type: ADMIN_RETENTION_EVENT_ID_TYPE,
      version: checkpoint.version,
      organizationId: checkpoint.organizationId,
      chainSequence: checkpoint.chainSequence,
      chainDigest: checkpoint.chainDigest,
      issuedAt: checkpoint.issuedAt,
      signingKeyId: checkpoint.signingKeyId,
      signature: checkpoint.signature,
    }),
  );
  return { eventId, type: ADMIN_RETENTION_EVENT_TYPE, checkpoint };
}

function checkpointSignaturePayload(checkpoint: AdminAuditChainCheckpoint): string {
  return canonicalJson({
    type: ADMIN_AUDIT_CHECKPOINT_TYPE,
    version: checkpoint.version,
    organizationId: checkpoint.organizationId,
    chainSequence: checkpoint.chainSequence,
    chainDigest: checkpoint.chainDigest,
    issuedAt: checkpoint.issuedAt,
    signingKeyId: checkpoint.signingKeyId,
  });
}

function parseCheckpointSequence(checkpoint: AdminAuditChainCheckpoint): bigint | undefined {
  if (
    checkpoint.version !== 1 ||
    !checkpoint.organizationId ||
    !checkpoint.signingKeyId ||
    !checkpoint.signature ||
    !Number.isFinite(new Date(checkpoint.issuedAt).getTime()) ||
    !/^(0|[1-9][0-9]*)$/.test(checkpoint.chainSequence)
  ) {
    return undefined;
  }
  const sequence = BigInt(checkpoint.chainSequence);
  if ((sequence === 0n) !== (checkpoint.chainDigest === null)) {
    return undefined;
  }
  if (sequence > 0n && !checkpoint.chainDigest) {
    return undefined;
  }
  return sequence;
}

function checkpointFailure(
  failure: AdminAuditCheckpointVerificationFailure,
  checkpointSequence: string,
  currentHeadSequence: string,
): AdminAuditCheckpointVerificationResult {
  return { valid: false, checkpointSequence, currentHeadSequence, failure };
}
