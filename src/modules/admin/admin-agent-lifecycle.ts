import { createHash, createPublicKey, randomUUID } from "node:crypto";
import { canonicalJson, sha256Base64Url } from "../../infrastructure/crypto/canonical-json.js";
import type {
  AdminAuditAppendResult,
  AdminAuditSqlClient,
  PostgresAdminChangeAuditLedger,
} from "./admin-change-audit-ledger.js";
import type { AdminRole } from "./admin-authorizer.js";

export type AdminAgentLifecycleStatus = "ACTIVE" | "SUSPENDED" | "REVOKED";

export interface AdminAgentLifecycleActor {
  readonly principalId: string;
  readonly membershipId: string;
  readonly organizationId: string;
  readonly roles: readonly AdminRole[];
}

export interface AdminAgentDetail {
  readonly id: string;
  readonly organizationId: string;
  readonly externalAgentId: string;
  readonly displayName?: string;
  readonly status: AdminAgentLifecycleStatus;
  readonly keyId?: string;
  readonly publicKeyFingerprint?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type AdminAgentLifecycleMutationResult =
  | {
      readonly outcome: "UPDATED";
      readonly requestId: string;
      readonly agent: AdminAgentDetail;
      readonly audit: AdminAuditAppendResult;
    }
  | {
      readonly outcome: "REPLAYED";
      readonly requestId: string;
      readonly agent: AdminAgentDetail;
    }
  | {
      readonly outcome: "NOT_FOUND";
      readonly requestId: string;
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
  status: AdminAgentLifecycleStatus;
  publicKey: string | null;
  keyId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class PostgresAdminAgentLifecycleService {
  public constructor(
    private readonly sql: AdminAuditSqlClient,
    private readonly audit: Pick<PostgresAdminChangeAuditLedger, "appendInTransaction">,
    private readonly generateId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async getAgent(
    organizationId: string,
    agentId: string,
  ): Promise<AdminAgentDetail | undefined> {
    const client = await this.sql.connect();
    try {
      const row = (
        await client.query<AgentRow>(
          `select "id", "organizationId", "externalAgentId", "displayName", "status",
                  "publicKey", "keyId", "createdAt", "updatedAt"
             from "AgentIdentity"
            where "organizationId" = $1::uuid and "id" = $2::uuid`,
          [organizationId, agentId],
        )
      ).rows[0];
      return row ? agentResponse(row) : undefined;
    } finally {
      client.release();
    }
  }

  public suspend(
    actor: AdminAgentLifecycleActor,
    agentId: string,
  ): Promise<AdminAgentLifecycleMutationResult> {
    return this.changeStatus(actor, agentId, "SUSPENDED", "agent.suspend", "agent.suspend");
  }

  public reactivate(
    actor: AdminAgentLifecycleActor,
    agentId: string,
  ): Promise<AdminAgentLifecycleMutationResult> {
    return this.changeStatus(actor, agentId, "ACTIVE", "agent.reactivate", "agent.reactivate");
  }

  public async rotateKey(
    actor: AdminAgentLifecycleActor,
    agentId: string,
    request: { readonly keyId: string; readonly publicKey: string },
  ): Promise<AdminAgentLifecycleMutationResult> {
    const normalized = normalizeKey(request.keyId, request.publicKey);
    const requestId = this.generateId();
    const timestamp = validNow(this.now());
    const tx = await this.sql.connect();
    try {
      await tx.query("begin");
      const row = await lockAgent(tx, actor.organizationId, agentId);
      if (!row) {
        await tx.query("rollback");
        return { outcome: "NOT_FOUND", requestId };
      }
      if (row.status === "REVOKED") {
        await tx.query("rollback");
        return { outcome: "CONFLICT", requestId };
      }
      if (sameKey(row, normalized.keyId, normalized.publicKey)) {
        await tx.query("rollback");
        return { outcome: "REPLAYED", requestId, agent: agentResponse(row) };
      }

      const beforeState = agentAuditState(row);
      const updated = (
        await tx.query<AgentRow>(
          `update "AgentIdentity"
              set "keyId" = $3, "publicKey" = $4, "updatedAt" = $5
            where "organizationId" = $1::uuid and "id" = $2::uuid
            returning "id", "organizationId", "externalAgentId", "displayName", "status",
                      "publicKey", "keyId", "createdAt", "updatedAt"`,
          [actor.organizationId, agentId, normalized.keyId, normalized.publicKey, timestamp],
        )
      ).rows[0];
      if (!updated) {
        throw new Error("Administrative agent key rotation returned no row");
      }
      const agent = agentResponse(updated);
      const audit = await this.audit.appendInTransaction(tx, {
        requestId,
        organizationId: actor.organizationId,
        principalId: actor.principalId,
        membershipId: actor.membershipId,
        timestamp,
        permission: "agent.rotate_key",
        action: "agent.rotate_key",
        resourceType: "agent",
        resourceId: agentId,
        roles: actor.roles,
        beforeState,
        afterState: agentAuditState(updated),
        requestDigest: sha256Base64Url(
          canonicalJson({
            type: "mino.admin.agent.key-rotation.v1",
            organizationId: actor.organizationId,
            agentId,
            keyId: normalized.keyId,
            publicKeyFingerprint: normalized.fingerprint,
          }),
        ),
      });
      await tx.query("commit");
      return { outcome: "UPDATED", requestId, agent, audit };
    } catch (error) {
      await rollbackPreserving(tx, error);
      throw error;
    } finally {
      tx.release();
    }
  }

  private async changeStatus(
    actor: AdminAgentLifecycleActor,
    agentId: string,
    targetStatus: "ACTIVE" | "SUSPENDED",
    permission: "agent.suspend" | "agent.reactivate",
    action: "agent.suspend" | "agent.reactivate",
  ): Promise<AdminAgentLifecycleMutationResult> {
    const requestId = this.generateId();
    const timestamp = validNow(this.now());
    const tx = await this.sql.connect();
    try {
      await tx.query("begin");
      const row = await lockAgent(tx, actor.organizationId, agentId);
      if (!row) {
        await tx.query("rollback");
        return { outcome: "NOT_FOUND", requestId };
      }
      if (row.status === "REVOKED") {
        await tx.query("rollback");
        return { outcome: "CONFLICT", requestId };
      }
      if (row.status === targetStatus) {
        await tx.query("rollback");
        return { outcome: "REPLAYED", requestId, agent: agentResponse(row) };
      }

      const beforeState = agentAuditState(row);
      const updated = (
        await tx.query<AgentRow>(
          `update "AgentIdentity"
              set "status" = $3::"AgentStatus", "updatedAt" = $4
            where "organizationId" = $1::uuid and "id" = $2::uuid
            returning "id", "organizationId", "externalAgentId", "displayName", "status",
                      "publicKey", "keyId", "createdAt", "updatedAt"`,
          [actor.organizationId, agentId, targetStatus, timestamp],
        )
      ).rows[0];
      if (!updated) {
        throw new Error("Administrative agent status transition returned no row");
      }
      const agent = agentResponse(updated);
      const audit = await this.audit.appendInTransaction(tx, {
        requestId,
        organizationId: actor.organizationId,
        principalId: actor.principalId,
        membershipId: actor.membershipId,
        timestamp,
        permission,
        action,
        resourceType: "agent",
        resourceId: agentId,
        roles: actor.roles,
        beforeState,
        afterState: agentAuditState(updated),
        requestDigest: sha256Base64Url(
          canonicalJson({
            type: "mino.admin.agent.status-transition.v1",
            organizationId: actor.organizationId,
            agentId,
            targetStatus,
          }),
        ),
      });
      await tx.query("commit");
      return { outcome: "UPDATED", requestId, agent, audit };
    } catch (error) {
      await rollbackPreserving(tx, error);
      throw error;
    } finally {
      tx.release();
    }
  }
}

async function lockAgent(
  client: Awaited<ReturnType<AdminAuditSqlClient["connect"]>>,
  organizationId: string,
  agentId: string,
): Promise<AgentRow | undefined> {
  return (
    await client.query<AgentRow>(
      `select "id", "organizationId", "externalAgentId", "displayName", "status",
              "publicKey", "keyId", "createdAt", "updatedAt"
         from "AgentIdentity"
        where "organizationId" = $1::uuid and "id" = $2::uuid
        for update`,
      [organizationId, agentId],
    )
  ).rows[0];
}

function normalizeKey(keyIdValue: string, publicKeyValue: string): {
  keyId: string;
  publicKey: string;
  fingerprint: string;
} {
  const keyId = keyIdValue.trim();
  if (keyId.length === 0 || keyId.length > 256 || /[\u0000-\u001f\u007f]/.test(keyId)) {
    throw new AdminAgentLifecycleValidationError("keyId is invalid");
  }
  let key: ReturnType<typeof createPublicKey>;
  try {
    key = createPublicKey(publicKeyValue);
  } catch {
    throw new AdminAgentLifecycleValidationError("publicKey must be a valid public PEM key");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new AdminAgentLifecycleValidationError("publicKey must be an Ed25519 public key");
  }
  const publicKey = key.export({ type: "spki", format: "pem" }).toString();
  const der = key.export({ type: "spki", format: "der" });
  return {
    keyId,
    publicKey,
    fingerprint: createHash("sha256").update(der).digest("base64url"),
  };
}

function sameKey(row: AgentRow, keyId: string, publicKey: string): boolean {
  if (!row.publicKey || !row.keyId || row.keyId !== keyId) {
    return false;
  }
  try {
    return createPublicKey(row.publicKey).export({ type: "spki", format: "pem" }).toString() === publicKey;
  } catch {
    return false;
  }
}

function agentResponse(row: AgentRow): AdminAgentDetail {
  const fingerprint = publicKeyFingerprint(row.publicKey);
  return {
    id: row.id,
    organizationId: row.organizationId,
    externalAgentId: row.externalAgentId,
    ...(row.displayName ? { displayName: row.displayName } : {}),
    status: row.status,
    ...(row.keyId ? { keyId: row.keyId } : {}),
    ...(fingerprint ? { publicKeyFingerprint: fingerprint } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function agentAuditState(row: AgentRow): Record<string, unknown> {
  return {
    id: row.id,
    externalAgentId: row.externalAgentId,
    displayName: row.displayName,
    status: row.status,
    keyId: row.keyId,
    publicKeyFingerprint: publicKeyFingerprint(row.publicKey) ?? null,
  };
}

function publicKeyFingerprint(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const key = createPublicKey(value);
    const der = key.export({ type: "spki", format: "der" });
    return createHash("sha256").update(der).digest("base64url");
  } catch {
    return undefined;
  }
}

function validNow(value: Date): Date {
  if (!Number.isFinite(value.getTime())) {
    throw new Error("Administrative agent lifecycle clock returned an invalid timestamp");
  }
  return value;
}

async function rollbackPreserving(
  client: Awaited<ReturnType<AdminAuditSqlClient["connect"]>>,
  error: unknown,
): Promise<void> {
  try {
    await client.query("rollback");
  } catch {
    // Preserve the original mutation/audit error.
  }
  void error;
}

export class AdminAgentLifecycleValidationError extends Error {}
