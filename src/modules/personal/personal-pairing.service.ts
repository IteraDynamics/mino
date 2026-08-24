import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { QueryResultRow } from "pg";

export interface PersonalAuthenticatedIdentity {
  readonly issuer: string;
  readonly subject: string;
}

export interface PersonalBootstrapRequest {
  readonly beneficiaryEmail: string;
  readonly displayName?: string;
  readonly accountName?: string;
}

export interface PersonalOwnerProfile {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly email: string;
  readonly displayName?: string;
  readonly status: "ACTIVE";
}

export type PersonalBootstrapResult =
  | { readonly outcome: "CREATED"; readonly owner: PersonalOwnerProfile }
  | { readonly outcome: "REPLAYED"; readonly owner: PersonalOwnerProfile }
  | { readonly outcome: "CONFLICT" };

export interface PersonalPairingCreateRequest {
  readonly externalAgentId: string;
  readonly displayName?: string;
  readonly keyId: string;
  readonly publicKey: string;
}

export interface PersonalPairingReceipt {
  readonly id: string;
  readonly status: "PENDING" | "CLAIMED" | "EXPIRED";
  readonly externalAgentId: string;
  readonly displayName?: string;
  readonly keyId: string;
  readonly publicKeyFingerprint: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly agentId?: string;
}

export interface PersonalPairingCreated extends PersonalPairingReceipt {
  readonly status: "PENDING";
  /** Returned once. Mino persists only a SHA-256 digest. */
  readonly claimSecret: string;
}

export type PersonalPairingClaimResult =
  | {
      readonly outcome: "CLAIMED" | "REPLAYED";
      readonly owner: PersonalOwnerProfile;
      readonly pairing: PersonalPairingReceipt & { readonly status: "CLAIMED"; readonly agentId: string };
    }
  | { readonly outcome: "NOT_FOUND" }
  | { readonly outcome: "INVALID_SECRET" }
  | { readonly outcome: "EXPIRED" }
  | { readonly outcome: "OWNER_NOT_FOUND" }
  | { readonly outcome: "CONFLICT" };

export interface PersonalSqlTransaction {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ readonly rows: R[]; readonly rowCount: number | null }>;
  release(): void;
}

export interface PersonalSqlClient {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ readonly rows: R[]; readonly rowCount: number | null }>;
  connect(): Promise<PersonalSqlTransaction>;
}

interface OwnerRow extends QueryResultRow {
  id: string;
  organizationId: string;
  userId: string;
  issuer: string;
  subject: string;
  email: string;
  displayName: string | null;
  status: string;
  organizationKind: string;
  userStatus: string;
}

interface PairingRow extends QueryResultRow {
  id: string;
  claimSecretHash: string;
  externalAgentId: string;
  displayName: string | null;
  keyId: string;
  publicKey: string;
  publicKeyFingerprint: string;
  status: "PENDING" | "CLAIMED" | "EXPIRED";
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  claimedAt: Date | null;
  claimedByOwnerId: string | null;
  claimedOrganizationId: string | null;
  agentId: string | null;
}

interface AgentRow extends QueryResultRow {
  id: string;
  externalAgentId: string;
  displayName: string | null;
  status: string;
  publicKey: string | null;
  keyId: string | null;
}

const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000;

export class PostgresPersonalPairingService {
  public constructor(
    private readonly sql: PersonalSqlClient,
    private readonly generateId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
    private readonly pairingTtlMs: number = DEFAULT_PAIRING_TTL_MS,
    private readonly generateClaimSecret: () => string = () => randomBytes(32).toString("base64url"),
  ) {
    if (!Number.isSafeInteger(pairingTtlMs) || pairingTtlMs < 60_000 || pairingTtlMs > 60 * 60 * 1000) {
      throw new Error("Personal pairing TTL must be between one minute and one hour");
    }
  }

  public async bootstrap(
    identity: PersonalAuthenticatedIdentity,
    request: PersonalBootstrapRequest,
  ): Promise<PersonalBootstrapResult> {
    const issuer = normalizedText(identity.issuer, "issuer", 2048);
    const subject = normalizedText(identity.subject, "subject", 512);
    const email = normalizeEmail(request.beneficiaryEmail);
    const displayName = request.displayName
      ? normalizedText(request.displayName, "displayName", 256)
      : undefined;
    const accountName = request.accountName
      ? normalizedText(request.accountName, "accountName", 256)
      : "Mino Personal";
    const timestamp = validNow(this.now());
    const tx = await this.sql.connect();

    try {
      await tx.query("begin");
      // Serialize bootstrap for one external principal without requiring an existing row.
      await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `mino-personal-owner:${issuer}:${subject}`,
      ]);

      const existing = await ownerByIdentity(tx, { issuer, subject });
      if (existing) {
        await tx.query("rollback");
        if (!ownerIsActive(existing) || existing.email.toLowerCase() !== email) {
          return { outcome: "CONFLICT" };
        }
        return { outcome: "REPLAYED", owner: ownerResponse(existing) };
      }

      const organizationId = this.generateId();
      const userId = this.generateId();
      const ownerId = this.generateId();
      await tx.query(
        `insert into "Organization" ("id", "name", "kind", "createdAt", "updatedAt")
         values ($1::uuid, $2, 'PERSONAL', $3, $3)`,
        [organizationId, accountName, timestamp],
      );
      await tx.query(
        `insert into "User" ("id", "organizationId", "email", "status", "createdAt", "updatedAt")
         values ($1::uuid, $2::uuid, $3, 'ACTIVE', $4, $4)`,
        [userId, organizationId, email, timestamp],
      );
      await tx.query(
        `insert into "PersonalOwner" (
           "id", "organizationId", "userId", "issuer", "subject", "email", "displayName",
           "status", "createdAt", "updatedAt"
         ) values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, 'ACTIVE', $8, $8)`,
        [ownerId, organizationId, userId, issuer, subject, email, displayName ?? null, timestamp],
      );

      const owner = await ownerByIdentity(tx, { issuer, subject });
      if (!owner || !ownerIsActive(owner)) {
        throw new Error("Personal owner bootstrap did not produce an active owner");
      }
      await tx.query("commit");
      return { outcome: "CREATED", owner: ownerResponse(owner) };
    } catch (error) {
      await rollbackPreserving(tx);
      throw error;
    } finally {
      tx.release();
    }
  }

  public async getOwner(
    identity: PersonalAuthenticatedIdentity,
  ): Promise<PersonalOwnerProfile | undefined> {
    const row = await ownerByIdentity(this.sql, {
      issuer: normalizedText(identity.issuer, "issuer", 2048),
      subject: normalizedText(identity.subject, "subject", 512),
    });
    return row && ownerIsActive(row) ? ownerResponse(row) : undefined;
  }

  public async createPairingRequest(
    request: PersonalPairingCreateRequest,
  ): Promise<PersonalPairingCreated> {
    const normalized = normalizeAgentEnrollment(request);
    const timestamp = validNow(this.now());
    const expiresAt = new Date(timestamp.getTime() + this.pairingTtlMs);
    const claimSecret = this.generateClaimSecret();
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(claimSecret)) {
      throw new Error("Personal pairing claim-secret generator returned an invalid secret");
    }
    const id = this.generateId();
    const row = (
      await this.sql.query<PairingRow>(
        `insert into "PersonalPairingRequest" (
           "id", "claimSecretHash", "externalAgentId", "displayName", "keyId", "publicKey",
           "publicKeyFingerprint", "status", "createdAt", "updatedAt", "expiresAt"
         ) values ($1::uuid, $2, $3, $4, $5, $6, $7, 'PENDING', $8, $8, $9)
         returning *`,
        [
          id,
          hashSecret(claimSecret),
          normalized.externalAgentId,
          normalized.displayName ?? null,
          normalized.keyId,
          normalized.publicKey,
          normalized.publicKeyFingerprint,
          timestamp,
          expiresAt,
        ],
      )
    ).rows[0];
    if (!row) {
      throw new Error("Personal pairing creation returned no row");
    }
    return { ...pairingResponse(row), status: "PENDING", claimSecret };
  }

  public async getPairingRequest(
    pairingRequestId: string,
  ): Promise<PersonalPairingReceipt | undefined> {
    const now = validNow(this.now());
    let row = (
      await this.sql.query<PairingRow>(
        `select * from "PersonalPairingRequest" where "id" = $1::uuid`,
        [pairingRequestId],
      )
    ).rows[0];
    if (!row) return undefined;

    if (row.status === "PENDING" && now >= row.expiresAt) {
      row = (
        await this.sql.query<PairingRow>(
          `update "PersonalPairingRequest"
              set "status" = 'EXPIRED', "updatedAt" = $2
            where "id" = $1::uuid and "status" = 'PENDING'
            returning *`,
          [pairingRequestId, now],
        )
      ).rows[0] ?? row;
    }
    return pairingResponse(row);
  }

  public async claimPairingRequest(
    identity: PersonalAuthenticatedIdentity,
    pairingRequestId: string,
    claimSecret: string,
  ): Promise<PersonalPairingClaimResult> {
    const issuer = normalizedText(identity.issuer, "issuer", 2048);
    const subject = normalizedText(identity.subject, "subject", 512);
    const timestamp = validNow(this.now());
    const suppliedSecretHash = hashSecret(claimSecret);
    const tx = await this.sql.connect();

    try {
      await tx.query("begin");
      const owner = await ownerByIdentity(tx, { issuer, subject }, true);
      if (!owner || !ownerIsActive(owner)) {
        await tx.query("rollback");
        return { outcome: "OWNER_NOT_FOUND" };
      }

      const pairing = (
        await tx.query<PairingRow>(
          `select * from "PersonalPairingRequest" where "id" = $1::uuid for update`,
          [pairingRequestId],
        )
      ).rows[0];
      if (!pairing) {
        await tx.query("rollback");
        return { outcome: "NOT_FOUND" };
      }
      if (!secretHashesEqual(pairing.claimSecretHash, suppliedSecretHash)) {
        await tx.query("rollback");
        return { outcome: "INVALID_SECRET" };
      }

      if (pairing.status === "EXPIRED" || (pairing.status === "PENDING" && timestamp >= pairing.expiresAt)) {
        if (pairing.status === "PENDING") {
          await tx.query(
            `update "PersonalPairingRequest"
                set "status" = 'EXPIRED', "updatedAt" = $2
              where "id" = $1::uuid`,
            [pairing.id, timestamp],
          );
          await tx.query("commit");
        } else {
          await tx.query("rollback");
        }
        return { outcome: "EXPIRED" };
      }

      if (pairing.status === "CLAIMED") {
        await tx.query("rollback");
        if (pairing.claimedByOwnerId !== owner.id || !pairing.agentId) {
          return { outcome: "CONFLICT" };
        }
        return {
          outcome: "REPLAYED",
          owner: ownerResponse(owner),
          pairing: claimedPairingResponse(pairing),
        };
      }

      const existingAgent = (
        await tx.query<AgentRow>(
          `select "id", "externalAgentId", "displayName", "status", "publicKey", "keyId"
             from "AgentIdentity"
            where "organizationId" = $1::uuid and "externalAgentId" = $2
            for update`,
          [owner.organizationId, pairing.externalAgentId],
        )
      ).rows[0];

      let agentId: string;
      if (existingAgent) {
        if (!sameAgentIdentity(existingAgent, pairing)) {
          await tx.query("rollback");
          return { outcome: "CONFLICT" };
        }
        agentId = existingAgent.id;
      } else {
        agentId = this.generateId();
        await tx.query(
          `insert into "AgentIdentity" (
             "id", "organizationId", "externalAgentId", "displayName", "status", "publicKey", "keyId",
             "createdAt", "updatedAt"
           ) values ($1::uuid, $2::uuid, $3, $4, 'ACTIVE', $5, $6, $7, $7)`,
          [
            agentId,
            owner.organizationId,
            pairing.externalAgentId,
            pairing.displayName,
            pairing.publicKey,
            pairing.keyId,
            timestamp,
          ],
        );
      }

      const claimed = (
        await tx.query<PairingRow>(
          `update "PersonalPairingRequest"
              set "status" = 'CLAIMED', "claimedAt" = $2, "claimedByOwnerId" = $3::uuid,
                  "claimedOrganizationId" = $4::uuid, "agentId" = $5::uuid, "updatedAt" = $2
            where "id" = $1::uuid
            returning *`,
          [pairing.id, timestamp, owner.id, owner.organizationId, agentId],
        )
      ).rows[0];
      if (!claimed) {
        throw new Error("Personal pairing claim returned no row");
      }

      await tx.query("commit");
      return {
        outcome: "CLAIMED",
        owner: ownerResponse(owner),
        pairing: claimedPairingResponse(claimed),
      };
    } catch (error) {
      await rollbackPreserving(tx);
      throw error;
    } finally {
      tx.release();
    }
  }
}

async function ownerByIdentity(
  sql: Pick<PersonalSqlClient, "query"> | Pick<PersonalSqlTransaction, "query">,
  identity: PersonalAuthenticatedIdentity,
  lock = false,
): Promise<OwnerRow | undefined> {
  const row = (
    await sql.query<OwnerRow>(
      `select p."id", p."organizationId", p."userId", p."issuer", p."subject", p."email",
              p."displayName", p."status", o."kind"::text as "organizationKind",
              u."status"::text as "userStatus"
         from "PersonalOwner" p
         join "Organization" o on o."id" = p."organizationId"
         join "User" u on u."id" = p."userId" and u."organizationId" = p."organizationId"
        where p."issuer" = $1 and p."subject" = $2
        ${lock ? "for update of p, o, u" : ""}`,
      [identity.issuer, identity.subject],
    )
  ).rows[0];
  return row;
}

function ownerIsActive(row: OwnerRow): boolean {
  return row.status === "ACTIVE" && row.organizationKind === "PERSONAL" && row.userStatus === "ACTIVE";
}

function ownerResponse(row: OwnerRow): PersonalOwnerProfile {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    email: row.email,
    ...(row.displayName ? { displayName: row.displayName } : {}),
    status: "ACTIVE",
  };
}

function pairingResponse(row: PairingRow): PersonalPairingReceipt {
  return {
    id: row.id,
    status: row.status,
    externalAgentId: row.externalAgentId,
    ...(row.displayName ? { displayName: row.displayName } : {}),
    keyId: row.keyId,
    publicKeyFingerprint: row.publicKeyFingerprint,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    ...(row.agentId ? { agentId: row.agentId } : {}),
  };
}

function claimedPairingResponse(
  row: PairingRow,
): PersonalPairingReceipt & { readonly status: "CLAIMED"; readonly agentId: string } {
  if (row.status !== "CLAIMED" || !row.agentId) {
    throw new Error("Persisted Personal pairing is not a complete claimed pairing");
  }
  return { ...pairingResponse(row), status: "CLAIMED", agentId: row.agentId };
}

interface NormalizedAgentEnrollment {
  readonly externalAgentId: string;
  readonly displayName?: string;
  readonly keyId: string;
  readonly publicKey: string;
  readonly publicKeyFingerprint: string;
}

function normalizeAgentEnrollment(request: PersonalPairingCreateRequest): NormalizedAgentEnrollment {
  const externalAgentId = normalizedText(request.externalAgentId, "externalAgentId", 256);
  const keyId = normalizedText(request.keyId, "keyId", 256);
  const displayName = request.displayName
    ? normalizedText(request.displayName, "displayName", 256)
    : undefined;

  let key: ReturnType<typeof createPublicKey>;
  try {
    key = createPublicKey(request.publicKey);
  } catch {
    throw new PersonalPairingValidationError("publicKey must be a valid public PEM key");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new PersonalPairingValidationError("publicKey must be an Ed25519 public key");
  }
  const publicKey = key.export({ type: "spki", format: "pem" }).toString();
  const publicKeyDer = key.export({ type: "spki", format: "der" });
  return {
    externalAgentId,
    ...(displayName ? { displayName } : {}),
    keyId,
    publicKey,
    publicKeyFingerprint: createHash("sha256").update(publicKeyDer).digest("base64url"),
  };
}

function sameAgentIdentity(agent: AgentRow, pairing: PairingRow): boolean {
  if (agent.status !== "ACTIVE" || !agent.publicKey || !agent.keyId) return false;
  let publicKey: string;
  try {
    publicKey = createPublicKey(agent.publicKey).export({ type: "spki", format: "pem" }).toString();
  } catch {
    return false;
  }
  return (
    agent.externalAgentId === pairing.externalAgentId &&
    (agent.displayName ?? undefined) === (pairing.displayName ?? undefined) &&
    agent.keyId === pairing.keyId &&
    publicKey === pairing.publicKey
  );
}

function normalizeEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new PersonalPairingValidationError("beneficiaryEmail is invalid");
  }
  return normalized;
}

function normalizedText(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new PersonalPairingValidationError(`${field} is invalid`);
  }
  return normalized;
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("base64url");
}

function secretHashesEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function validNow(value: Date): Date {
  if (!Number.isFinite(value.getTime())) {
    throw new Error("Personal pairing clock returned an invalid timestamp");
  }
  return value;
}

async function rollbackPreserving(tx: PersonalSqlTransaction): Promise<void> {
  try {
    await tx.query("rollback");
  } catch {
    // Preserve the original error.
  }
}

export class PersonalPairingValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PersonalPairingValidationError";
  }
}
