import { createHash, createPublicKey, randomUUID } from "node:crypto";
import { canonicalJson, sha256Base64Url } from "../../infrastructure/crypto/canonical-json.js";
import type {
  AdminAuditAppendResult,
  AdminAuditSqlClient,
  PostgresAdminChangeAuditLedger,
} from "./admin-change-audit-ledger.js";
import type { AdminRole } from "./admin-authorizer.js";

export interface AdminAgentEnrollmentActor {
  readonly principalId: string;
  readonly membershipId: string;
  readonly organizationId: string;
  readonly roles: readonly AdminRole[];
}

export interface AdminAgentEnrollmentRequest {
  readonly externalAgentId: string;
  readonly displayName?: string;
  readonly keyId: string;
  readonly publicKey: string;
}

export interface AdminEnrolledAgent {
  readonly id: string;
  readonly organizationId: string;
  readonly externalAgentId: string;
  readonly displayName?: string;
  readonly status: "ACTIVE";
  readonly keyId: string;
  readonly publicKeyFingerprint: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type AdminAgentEnrollmentResult =
  | {
      readonly outcome: "CREATED";
      readonly requestId: string;
      readonly agent: AdminEnrolledAgent;
      readonly audit: AdminAuditAppendResult;
    }
  | {
      readonly outcome: "REPLAYED";
      readonly requestId: string;
      readonly agent: AdminEnrolledAgent;
    }
  | {
      readonly outcome: "CONFLICT";
      readonly requestId: string;
    };

interface AgentRow {
  id: string;
  organizationId: string;
  externalAgentId: string;
  displayName: string | null;
  status: string;
  publicKey: string | null;
  keyId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class PostgresAdminAgentEnrollmentService {
  public constructor(
    private readonly sql: AdminAuditSqlClient,
    private readonly audit: Pick<PostgresAdminChangeAuditLedger, "appendInTransaction">,
    private readonly generateId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async enroll(
    actor: AdminAgentEnrollmentActor,
    request: AdminAgentEnrollmentRequest,
  ): Promise<AdminAgentEnrollmentResult> {
    const normalized = normalizeEnrollment(request);
    const requestId = this.generateId();
    const timestamp = this.now();
    if (!Number.isFinite(timestamp.getTime())) {
      throw new Error("Administrative agent enrollment clock returned an invalid timestamp");
    }

    const tx = await this.sql.connect();
    try {
      await tx.query("begin");
      const organization = await tx.query<{ id: string }>(
        `select "id"
           from "Organization"
          where "id" = $1::uuid
          for update`,
        [actor.organizationId],
      );
      if (organization.rowCount !== 1) {
        throw new Error("Administrative agent enrollment organization no longer exists");
      }

      const existing = (
        await tx.query<AgentRow>(
          `select "id", "organizationId", "externalAgentId", "displayName", "status",
                  "publicKey", "keyId", "createdAt", "updatedAt"
             from "AgentIdentity"
            where "organizationId" = $1::uuid
              and "externalAgentId" = $2`,
          [actor.organizationId, normalized.externalAgentId],
        )
      ).rows[0];

      if (existing) {
        await tx.query("rollback");
        if (!sameEnrollment(existing, normalized)) {
          return { outcome: "CONFLICT", requestId };
        }
        return {
          outcome: "REPLAYED",
          requestId,
          agent: agentResponse(existing),
        };
      }

      const agentId = this.generateId();
      const inserted = (
        await tx.query<AgentRow>(
          `insert into "AgentIdentity" (
             "id", "organizationId", "externalAgentId", "displayName", "status",
             "publicKey", "keyId", "createdAt", "updatedAt"
           ) values ($1::uuid, $2::uuid, $3, $4, 'ACTIVE', $5, $6, $7, $7)
           returning "id", "organizationId", "externalAgentId", "displayName", "status",
                     "publicKey", "keyId", "createdAt", "updatedAt"`,
          [
            agentId,
            actor.organizationId,
            normalized.externalAgentId,
            normalized.displayName ?? null,
            normalized.publicKey,
            normalized.keyId,
            timestamp,
          ],
        )
      ).rows[0];
      if (!inserted) {
        throw new Error("Administrative agent enrollment insert returned no row");
      }

      const agent = agentResponse(inserted);
      const requestDigest = sha256Base64Url(
        canonicalJson({
          type: "mino.admin.agent.enrollment.v1",
          organizationId: actor.organizationId,
          externalAgentId: normalized.externalAgentId,
          displayName: normalized.displayName ?? null,
          keyId: normalized.keyId,
          publicKeyFingerprint: normalized.publicKeyFingerprint,
        }),
      );
      const audit = await this.audit.appendInTransaction(tx, {
        requestId,
        organizationId: actor.organizationId,
        principalId: actor.principalId,
        membershipId: actor.membershipId,
        timestamp,
        permission: "agent.create",
        action: "agent.create",
        resourceType: "agent",
        resourceId: agent.id,
        roles: actor.roles,
        afterState: {
          id: agent.id,
          externalAgentId: agent.externalAgentId,
          displayName: agent.displayName ?? null,
          status: agent.status,
          keyId: agent.keyId,
          publicKeyFingerprint: agent.publicKeyFingerprint,
        },
        requestDigest,
      });

      await tx.query("commit");
      return { outcome: "CREATED", requestId, agent, audit };
    } catch (error) {
      try {
        await tx.query("rollback");
      } catch {
        // Preserve the original mutation/audit error.
      }
      throw error;
    } finally {
      tx.release();
    }
  }
}

interface NormalizedEnrollment {
  readonly externalAgentId: string;
  readonly displayName?: string;
  readonly keyId: string;
  readonly publicKey: string;
  readonly publicKeyFingerprint: string;
}

function normalizeEnrollment(request: AdminAgentEnrollmentRequest): NormalizedEnrollment {
  const externalAgentId = normalizedText(request.externalAgentId, "externalAgentId", 256);
  const keyId = normalizedText(request.keyId, "keyId", 256);
  const displayName = request.displayName
    ? normalizedText(request.displayName, "displayName", 256)
    : undefined;

  let key: ReturnType<typeof createPublicKey>;
  try {
    key = createPublicKey(request.publicKey);
  } catch {
    throw new AdminAgentEnrollmentValidationError("publicKey must be a valid public PEM key");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new AdminAgentEnrollmentValidationError("publicKey must be an Ed25519 public key");
  }
  const publicKey = key.export({ type: "spki", format: "pem" }).toString();
  const publicKeyDer = key.export({ type: "spki", format: "der" });
  const publicKeyFingerprint = createHash("sha256").update(publicKeyDer).digest("base64url");

  return {
    externalAgentId,
    ...(displayName ? { displayName } : {}),
    keyId,
    publicKey,
    publicKeyFingerprint,
  };
}

function normalizedText(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new AdminAgentEnrollmentValidationError(`${field} is invalid`);
  }
  return normalized;
}

function sameEnrollment(row: AgentRow, request: NormalizedEnrollment): boolean {
  if (row.status !== "ACTIVE" || !row.publicKey || !row.keyId) {
    return false;
  }
  let storedPublicKey: string;
  try {
    storedPublicKey = createPublicKey(row.publicKey)
      .export({ type: "spki", format: "pem" })
      .toString();
  } catch {
    return false;
  }
  return (
    row.externalAgentId === request.externalAgentId &&
    (row.displayName ?? undefined) === request.displayName &&
    row.keyId === request.keyId &&
    storedPublicKey === request.publicKey
  );
}

function agentResponse(row: AgentRow): AdminEnrolledAgent {
  if (row.status !== "ACTIVE" || !row.publicKey || !row.keyId) {
    throw new Error("Persisted administrative agent enrollment is incomplete or inactive");
  }
  const key = createPublicKey(row.publicKey);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("Persisted administrative agent enrollment key is not Ed25519");
  }
  const publicKeyDer = key.export({ type: "spki", format: "der" });
  return {
    id: row.id,
    organizationId: row.organizationId,
    externalAgentId: row.externalAgentId,
    ...(row.displayName ? { displayName: row.displayName } : {}),
    status: "ACTIVE",
    keyId: row.keyId,
    publicKeyFingerprint: createHash("sha256").update(publicKeyDer).digest("base64url"),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class AdminAgentEnrollmentValidationError extends Error {}
