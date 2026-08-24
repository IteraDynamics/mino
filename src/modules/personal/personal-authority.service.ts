import { randomBytes, randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import type { PersonalAuthorityProfile } from "../../domain/personal/personal-authority.types.js";
import { canonicalJson, sha256Base64Url, sha256Hex } from "../../infrastructure/crypto/canonical-json.js";
import { verifyEd25519 } from "../../infrastructure/crypto/ed25519.js";
import type { MandateSigningKey, MandateTokenService } from "../mandates/mandate-token.service.js";
import { compilePersonalAuthorityProfile } from "./personal-authority-compiler.js";
import type {
  PersonalAuthenticatedIdentity,
  PersonalSqlClient,
  PersonalSqlTransaction,
} from "./personal-pairing.service.js";

const CURRENCY_MINOR_DIGITS: Readonly<Record<string, number>> = {
  BHD: 3,
  EUR: 2,
  GBP: 2,
  JPY: 0,
  KWD: 3,
  USD: 2,
};
const AGENT_PROOF_MAX_SKEW_SECONDS = 300;
const MANDATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const POLICY_NAME_PREFIX = "__mino_personal_agent__:";

export interface PersonalCredentialNonceGuard {
  claim(agentId: string, nonce: string, ttlSeconds: number): Promise<boolean>;
}

export interface PersonalAgentMandateProof {
  readonly keyId: string;
  readonly timestamp: number;
  readonly nonce: string;
  readonly signature: string;
}

export interface PersonalAuthorityDetail {
  readonly agentId: string;
  readonly policyId: string;
  readonly version: number;
  readonly active: boolean;
  readonly profile: PersonalAuthorityProfile;
  readonly updatedAt: string;
}

export type PersonalAuthoritySetResult =
  | { readonly outcome: "CREATED" | "UPDATED" | "REPLAYED"; readonly authority: PersonalAuthorityDetail }
  | { readonly outcome: "OWNER_NOT_FOUND" | "AGENT_NOT_FOUND" | "AGENT_NOT_PAIRED" };

export type PersonalAuthorityRevokeResult =
  | { readonly outcome: "REVOKED" | "REPLAYED" }
  | { readonly outcome: "OWNER_NOT_FOUND" | "AGENT_NOT_FOUND" };

export type PersonalMandateIssueResult =
  | {
      readonly outcome: "ISSUED";
      readonly mandateId: string;
      readonly mandateToken: string;
      readonly expiresAt: string;
      readonly policyVersion: number;
    }
  | { readonly outcome: "AGENT_NOT_FOUND" | "AUTHORITY_NOT_GRANTED" | "INVALID_PROOF" | "PROOF_REPLAYED" };

interface OwnerRow extends QueryResultRow {
  id: string;
  organizationId: string;
  userId: string;
  status: string;
  organizationKind: string;
  userStatus: string;
}
interface AgentRow extends QueryResultRow {
  id: string;
  organizationId: string;
  status: string;
  publicKey: string | null;
  keyId: string | null;
}
interface PolicyRow extends QueryResultRow {
  id: string;
  organizationId: string;
  name: string;
  version: number;
  active: boolean;
  baseCurrency: string;
  maxBudgetMinor: string;
  rollingDailyLimitMinor: string;
  approvedMerchantDomains: string[];
  approvedVendorIds: string[];
  restrictedCategories: string[];
  approvalMode: "AUTO_APPROVE" | "OWNER_APPROVAL" | "DUAL_SIGNATURE_SLACK" | "HARD_BLOCK";
  maxTransactionsPerMinute: number;
  crossMerchantWindowSecs: number;
  maxDistinctMerchants: number;
  createdAt: Date;
  updatedAt: Date;
}

const POLICY_COLUMNS = `"id", "organizationId", "name", "version", "active", "baseCurrency",
  "maxBudgetMinor", "rollingDailyLimitMinor", "approvedMerchantDomains", "approvedVendorIds",
  "restrictedCategories", "approvalMode", "maxTransactionsPerMinute", "crossMerchantWindowSecs",
  "maxDistinctMerchants", "createdAt", "updatedAt"`;

export class PostgresPersonalAuthorityService {
  public constructor(
    private readonly sql: PersonalSqlClient,
    private readonly mandateTokens: Pick<MandateTokenService, "issue">,
    private readonly signingKey: MandateSigningKey,
    private readonly issuer: string,
    private readonly nonceGuard: PersonalCredentialNonceGuard,
    private readonly generateId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async getAuthority(identity: PersonalAuthenticatedIdentity, agentId: string): Promise<PersonalAuthorityDetail | undefined> {
    const owner = await ownerByIdentity(this.sql, identity);
    if (!ownerIsActive(owner)) return undefined;
    const policy = await currentPolicy(this.sql, owner.organizationId, agentId);
    return policy ? authorityResponse(agentId, policy) : undefined;
  }

  public async setAuthority(
    identity: PersonalAuthenticatedIdentity,
    agentId: string,
    profile: PersonalAuthorityProfile,
  ): Promise<PersonalAuthoritySetResult> {
    const compiled = compilePersonalAuthorityProfile(profile);
    const compiledDigest = authorityDigest(compiled);
    const timestamp = validNow(this.now());
    const tx = await this.sql.connect();
    try {
      await tx.query("begin");
      const owner = await ownerByIdentity(tx, identity, true);
      if (!ownerIsActive(owner)) {
        await tx.query("rollback");
        return { outcome: "OWNER_NOT_FOUND" };
      }
      const agent = await agentForOwner(tx, owner.organizationId, agentId, true);
      if (!agent || agent.status !== "ACTIVE" || !agent.publicKey || !agent.keyId) {
        await tx.query("rollback");
        return { outcome: "AGENT_NOT_FOUND" };
      }
      const paired = await pairingBelongsToOwner(tx, owner.id, agentId);
      if (!paired) {
        await tx.query("rollback");
        return { outcome: "AGENT_NOT_PAIRED" };
      }

      const prior = await currentPolicy(tx, owner.organizationId, agentId, true);
      if (prior && authorityDigest(policyCompiledShape(prior)) === compiledDigest) {
        await tx.query("rollback");
        return { outcome: "REPLAYED", authority: authorityResponse(agentId, prior) };
      }

      const name = policyName(agentId);
      const latestVersion = await latestPolicyVersion(tx, owner.organizationId, name);
      if (prior) {
        await tx.query(
          `update "Policy" set "active" = false, "updatedAt" = $3
            where "organizationId" = $1::uuid and "name" = $2 and "active" = true`,
          [owner.organizationId, name, timestamp],
        );
        await tx.query(
          `update "AgentMandate" m
              set "status" = 'REVOKED', "revokedAt" = $4
             from "Policy" p
            where m."organizationId" = $1::uuid and m."agentId" = $2::uuid
              and m."policyId" = p."id" and p."organizationId" = $1::uuid and p."name" = $3
              and m."status" = 'ACTIVE'`,
          [owner.organizationId, agentId, name, timestamp],
        );
      }

      const policyId = this.generateId();
      const inserted = (
        await tx.query<PolicyRow>(
          `insert into "Policy" (
             "id", "organizationId", "name", "version", "active", "baseCurrency",
             "maxBudgetMinor", "rollingDailyLimitMinor", "approvedMerchantDomains", "approvedVendorIds",
             "restrictedCategories", "approvalMode", "maxTransactionsPerMinute", "crossMerchantWindowSecs",
             "maxDistinctMerchants", "createdAt", "updatedAt"
           ) values (
             $1::uuid, $2::uuid, $3, $4, true, $5,
             $6::bigint, $7::bigint, $8::text[], $9::text[], $10::text[], $11::"ApprovalMode",
             $12, $13, $14, $15, $15
           ) returning ${POLICY_COLUMNS}`,
          [
            policyId,
            owner.organizationId,
            name,
            latestVersion + 1,
            compiled.baseCurrency,
            compiled.maxBudgetMinor,
            compiled.rollingDailyLimitMinor,
            [...compiled.approvedMerchantDomains],
            [...compiled.approvedVendorIds],
            [...compiled.restrictedCategories],
            compiled.approvalMode,
            compiled.maxTransactionsPerMinute,
            compiled.crossMerchantWindowSecs,
            compiled.maxDistinctMerchants,
            timestamp,
          ],
        )
      ).rows[0];
      if (!inserted) throw new Error("Personal authority policy creation returned no row");
      await tx.query("commit");
      return {
        outcome: prior ? "UPDATED" : "CREATED",
        authority: authorityResponse(agentId, inserted),
      };
    } catch (error) {
      await rollbackPreserving(tx);
      throw error;
    } finally {
      tx.release();
    }
  }

  public async revokeAuthority(
    identity: PersonalAuthenticatedIdentity,
    agentId: string,
  ): Promise<PersonalAuthorityRevokeResult> {
    const timestamp = validNow(this.now());
    const tx = await this.sql.connect();
    try {
      await tx.query("begin");
      const owner = await ownerByIdentity(tx, identity, true);
      if (!ownerIsActive(owner)) {
        await tx.query("rollback");
        return { outcome: "OWNER_NOT_FOUND" };
      }
      const agent = await agentForOwner(tx, owner.organizationId, agentId, true);
      if (!agent) {
        await tx.query("rollback");
        return { outcome: "AGENT_NOT_FOUND" };
      }
      const name = policyName(agentId);
      const prior = await currentPolicy(tx, owner.organizationId, agentId, true);
      if (!prior) {
        await tx.query("rollback");
        return { outcome: "REPLAYED" };
      }
      await tx.query(
        `update "Policy" set "active" = false, "updatedAt" = $3
          where "organizationId" = $1::uuid and "name" = $2 and "active" = true`,
        [owner.organizationId, name, timestamp],
      );
      await tx.query(
        `update "AgentMandate" m
            set "status" = 'REVOKED', "revokedAt" = $4
           from "Policy" p
          where m."organizationId" = $1::uuid and m."agentId" = $2::uuid
            and m."policyId" = p."id" and p."organizationId" = $1::uuid and p."name" = $3
            and m."status" = 'ACTIVE'`,
        [owner.organizationId, agentId, name, timestamp],
      );
      await tx.query("commit");
      return { outcome: "REVOKED" };
    } catch (error) {
      await rollbackPreserving(tx);
      throw error;
    } finally {
      tx.release();
    }
  }

  public async issueMandate(
    agentId: string,
    proof: PersonalAgentMandateProof,
  ): Promise<PersonalMandateIssueResult> {
    const timestamp = validNow(this.now());
    const agent = await agentForCredential(this.sql, agentId);
    if (!agent || agent.status !== "ACTIVE" || !agent.publicKey || !agent.keyId) {
      return { outcome: "AGENT_NOT_FOUND" };
    }
    if (!validProofShape(proof, timestamp) || proof.keyId !== agent.keyId) {
      return { outcome: "INVALID_PROOF" };
    }
    const payload = buildPersonalMandateSigningPayload(agentId, proof.keyId, proof.timestamp, proof.nonce);
    let signature: Buffer;
    try {
      signature = Buffer.from(proof.signature, "base64url");
    } catch {
      return { outcome: "INVALID_PROOF" };
    }
    if (signature.length !== 64 || !verifyEd25519(payload, signature, agent.publicKey)) {
      return { outcome: "INVALID_PROOF" };
    }
    if (!(await this.nonceGuard.claim(agentId, proof.nonce, AGENT_PROOF_MAX_SKEW_SECONDS * 2))) {
      return { outcome: "PROOF_REPLAYED" };
    }

    const tx = await this.sql.connect();
    try {
      await tx.query("begin");
      const lockedAgent = await agentForCredential(tx, agentId, true);
      if (!lockedAgent || lockedAgent.status !== "ACTIVE" || lockedAgent.keyId !== proof.keyId) {
        await tx.query("rollback");
        return { outcome: "AGENT_NOT_FOUND" };
      }
      const owner = await ownerForAgent(tx, lockedAgent.organizationId, agentId);
      if (!ownerIsActive(owner) || !(await pairingBelongsToOwner(tx, owner.id, agentId))) {
        await tx.query("rollback");
        return { outcome: "AUTHORITY_NOT_GRANTED" };
      }
      const policy = await currentPolicy(tx, owner.organizationId, agentId, true);
      if (!policy) {
        await tx.query("rollback");
        return { outcome: "AUTHORITY_NOT_GRANTED" };
      }

      await tx.query(
        `update "AgentMandate" set "status" = 'REVOKED', "revokedAt" = $4
          where "organizationId" = $1::uuid and "agentId" = $2::uuid and "policyId" = $3::uuid
            and "status" = 'ACTIVE'`,
        [owner.organizationId, agentId, policy.id, timestamp],
      );

      const mandateId = this.generateId();
      const tokenJti = this.generateId();
      const tokenJtiHash = sha256Hex(tokenJti);
      const expiresAt = new Date(timestamp.getTime() + MANDATE_TTL_MS);
      const issuedAtSeconds = Math.floor(timestamp.getTime() / 1000);
      const expiresAtSeconds = Math.floor(expiresAt.getTime() / 1000);
      const mandateToken = this.mandateTokens.issue(
        {
          iss: this.issuer,
          sub: agentId,
          aud: "mino",
          jti: tokenJti,
          organizationId: owner.organizationId,
          userId: owner.userId,
          agentId,
          mandateId,
          policyVersion: policy.version,
          iat: issuedAtSeconds,
          nbf: issuedAtSeconds,
          exp: expiresAtSeconds,
        },
        this.signingKey,
      );
      const snapshotDigest = sha256Base64Url(
        canonicalJson({
          type: "mino.personal.mandate.v1",
          organizationId: owner.organizationId,
          userId: owner.userId,
          agentId,
          policyId: policy.id,
          policyVersion: policy.version,
        }),
      );
      await tx.query(
        `insert into "AgentMandate" (
           "id", "organizationId", "userId", "agentId", "policyId", "issuanceKeyHash",
           "tokenJtiHash", "policyVersion", "currency", "maxBudgetMinor", "rollingDailyLimitMinor",
           "approvedMerchantDomains", "approvedVendorIds", "restrictedCategories", "approvalMode",
           "maxTransactionsPerMinute", "crossMerchantWindowSecs", "maxDistinctMerchants",
           "delegationPayloadHash", "signingKeyId", "status", "issuedAt", "expiresAt", "metadata"
         ) values (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, null,
           $6, $7, $8, $9::bigint, $10::bigint, $11::text[], $12::text[], $13::text[], $14::"ApprovalMode",
           $15, $16, $17, $18, $19, 'ACTIVE', $20, $21, $22::jsonb
         )`,
        [
          mandateId,
          owner.organizationId,
          owner.userId,
          agentId,
          policy.id,
          tokenJtiHash,
          policy.version,
          policy.baseCurrency,
          policy.maxBudgetMinor,
          policy.rollingDailyLimitMinor,
          policy.approvedMerchantDomains,
          policy.approvedVendorIds,
          policy.restrictedCategories,
          policy.approvalMode,
          policy.maxTransactionsPerMinute,
          policy.crossMerchantWindowSecs,
          policy.maxDistinctMerchants,
          snapshotDigest,
          this.signingKey.keyId,
          timestamp,
          expiresAt,
          JSON.stringify({ source: "PERSONAL", policyName: policy.name }),
        ],
      );
      await tx.query("commit");
      return {
        outcome: "ISSUED",
        mandateId,
        mandateToken,
        expiresAt: expiresAt.toISOString(),
        policyVersion: policy.version,
      };
    } catch (error) {
      await rollbackPreserving(tx);
      throw error;
    } finally {
      tx.release();
    }
  }
}

export function buildPersonalMandateSigningPayload(
  agentId: string,
  keyId: string,
  timestamp: number,
  nonce: string,
): string {
  return ["MINO-PERSONAL-MANDATE-V1", agentId, keyId, String(timestamp), nonce].join("\n");
}

function policyName(agentId: string): string {
  return `${POLICY_NAME_PREFIX}${agentId}`;
}

async function ownerByIdentity(
  sql: Pick<PersonalSqlClient, "query"> | Pick<PersonalSqlTransaction, "query">,
  identity: PersonalAuthenticatedIdentity,
  lock = false,
): Promise<OwnerRow | undefined> {
  return (
    await sql.query<OwnerRow>(
      `select p."id", p."organizationId", p."userId", p."status",
              o."kind"::text as "organizationKind", u."status"::text as "userStatus"
         from "PersonalOwner" p
         join "Organization" o on o."id" = p."organizationId"
         join "User" u on u."id" = p."userId" and u."organizationId" = p."organizationId"
        where p."issuer" = $1 and p."subject" = $2
        ${lock ? "for update of p, o, u" : ""}`,
      [identity.issuer.trim(), identity.subject.trim()],
    )
  ).rows[0];
}

async function ownerForAgent(
  sql: Pick<PersonalSqlClient, "query"> | Pick<PersonalSqlTransaction, "query">,
  organizationId: string,
  agentId: string,
): Promise<OwnerRow | undefined> {
  return (
    await sql.query<OwnerRow>(
      `select p."id", p."organizationId", p."userId", p."status",
              o."kind"::text as "organizationKind", u."status"::text as "userStatus"
         from "PersonalOwner" p
         join "Organization" o on o."id" = p."organizationId"
         join "User" u on u."id" = p."userId" and u."organizationId" = p."organizationId"
        where p."organizationId" = $1::uuid
          and exists (select 1 from "AgentIdentity" a where a."id" = $2::uuid and a."organizationId" = p."organizationId")
        for update of p, o, u`,
      [organizationId, agentId],
    )
  ).rows[0];
}

function ownerIsActive(row: OwnerRow | undefined): row is OwnerRow {
  return !!row && row.status === "ACTIVE" && row.organizationKind === "PERSONAL" && row.userStatus === "ACTIVE";
}

async function agentForOwner(
  sql: Pick<PersonalSqlClient, "query"> | Pick<PersonalSqlTransaction, "query">,
  organizationId: string,
  agentId: string,
  lock = false,
): Promise<AgentRow | undefined> {
  return (
    await sql.query<AgentRow>(
      `select "id", "organizationId", "status"::text as "status", "publicKey", "keyId"
         from "AgentIdentity"
        where "organizationId" = $1::uuid and "id" = $2::uuid
        ${lock ? "for update" : ""}`,
      [organizationId, agentId],
    )
  ).rows[0];
}

async function agentForCredential(
  sql: Pick<PersonalSqlClient, "query"> | Pick<PersonalSqlTransaction, "query">,
  agentId: string,
  lock = false,
): Promise<AgentRow | undefined> {
  return (
    await sql.query<AgentRow>(
      `select a."id", a."organizationId", a."status"::text as "status", a."publicKey", a."keyId"
         from "AgentIdentity" a
         join "Organization" o on o."id" = a."organizationId" and o."kind" = 'PERSONAL'
        where a."id" = $1::uuid
        ${lock ? "for update of a" : ""}`,
      [agentId],
    )
  ).rows[0];
}

async function pairingBelongsToOwner(
  sql: Pick<PersonalSqlClient, "query"> | Pick<PersonalSqlTransaction, "query">,
  ownerId: string,
  agentId: string,
): Promise<boolean> {
  const row = (
    await sql.query<{ exists: boolean } & QueryResultRow>(
      `select exists(
         select 1 from "PersonalPairingRequest"
          where "status" = 'CLAIMED' and "claimedByOwnerId" = $1::uuid and "agentId" = $2::uuid
       ) as "exists"`,
      [ownerId, agentId],
    )
  ).rows[0];
  return row?.exists === true;
}

async function currentPolicy(
  sql: Pick<PersonalSqlClient, "query"> | Pick<PersonalSqlTransaction, "query">,
  organizationId: string,
  agentId: string,
  lock = false,
): Promise<PolicyRow | undefined> {
  return (
    await sql.query<PolicyRow>(
      `select ${POLICY_COLUMNS} from "Policy"
        where "organizationId" = $1::uuid and "name" = $2 and "active" = true
        order by "version" desc limit 1 ${lock ? "for update" : ""}`,
      [organizationId, policyName(agentId)],
    )
  ).rows[0];
}

async function latestPolicyVersion(
  sql: Pick<PersonalSqlClient, "query"> | Pick<PersonalSqlTransaction, "query">,
  organizationId: string,
  name: string,
): Promise<number> {
  const row = (
    await sql.query<{ version: number } & QueryResultRow>(
      `select coalesce(max("version"), 0)::int as "version" from "Policy"
        where "organizationId" = $1::uuid and "name" = $2`,
      [organizationId, name],
    )
  ).rows[0];
  return row?.version ?? 0;
}

function policyCompiledShape(policy: PolicyRow) {
  return {
    baseCurrency: policy.baseCurrency,
    maxBudgetMinor: policy.maxBudgetMinor,
    rollingDailyLimitMinor: policy.rollingDailyLimitMinor,
    approvedMerchantDomains: policy.approvedMerchantDomains,
    approvedVendorIds: policy.approvedVendorIds,
    restrictedCategories: policy.restrictedCategories,
    approvalMode: policy.approvalMode,
    maxTransactionsPerMinute: policy.maxTransactionsPerMinute,
    crossMerchantWindowSecs: policy.crossMerchantWindowSecs,
    maxDistinctMerchants: policy.maxDistinctMerchants,
  };
}

function authorityDigest(value: unknown): string {
  return sha256Base64Url(canonicalJson(value));
}

function authorityResponse(agentId: string, policy: PolicyRow): PersonalAuthorityDetail {
  const digits = CURRENCY_MINOR_DIGITS[policy.baseCurrency];
  if (digits === undefined) throw new Error("Persisted Personal authority uses an unsupported currency");
  return {
    agentId,
    policyId: policy.id,
    version: policy.version,
    active: policy.active,
    profile: {
      currency: policy.baseCurrency,
      perTransactionLimit: formatMinor(policy.maxBudgetMinor, digits),
      dailyLimit: formatMinor(policy.rollingDailyLimitMinor, digits),
      allowedMerchantDomains: [...policy.approvedMerchantDomains],
      restrictedCategories: [...policy.restrictedCategories],
      overLimitBehavior: policy.approvalMode === "OWNER_APPROVAL" ? "ASK_OWNER" : "BLOCK",
      velocity: {
        maxTransactionsPerMinute: policy.maxTransactionsPerMinute,
        crossMerchantWindowSeconds: policy.crossMerchantWindowSecs,
        maxDistinctMerchantsInWindow: policy.maxDistinctMerchants,
      },
    },
    updatedAt: policy.updatedAt.toISOString(),
  };
}

function formatMinor(value: string, digits: number): string {
  const amount = BigInt(value);
  if (digits === 0) return amount.toString();
  const divisor = 10n ** BigInt(digits);
  const whole = amount / divisor;
  const fraction = (amount % divisor).toString().padStart(digits, "0");
  return `${whole}.${fraction}`;
}

function validProofShape(proof: PersonalAgentMandateProof, now: Date): boolean {
  if (!proof.keyId.trim() || !Number.isSafeInteger(proof.timestamp) || proof.timestamp <= 0) return false;
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(proof.nonce)) return false;
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(proof.signature)) return false;
  const nowSeconds = Math.floor(now.getTime() / 1000);
  return Math.abs(nowSeconds - proof.timestamp) <= AGENT_PROOF_MAX_SKEW_SECONDS;
}

function validNow(value: Date): Date {
  if (!Number.isFinite(value.getTime())) throw new Error("Personal authority clock returned an invalid timestamp");
  return value;
}

async function rollbackPreserving(tx: PersonalSqlTransaction): Promise<void> {
  try {
    await tx.query("rollback");
  } catch {
    // Preserve the original error.
  }
}

export class RedisPersonalCredentialNonceGuard implements PersonalCredentialNonceGuard {
  public constructor(
    private readonly redis: {
      set(key: string, value: string, options: { NX: true; EX: number }): Promise<string | null>;
    },
  ) {}

  public async claim(agentId: string, nonce: string, ttlSeconds: number): Promise<boolean> {
    const key = `mino:personal:mandate-proof:${agentId}:${sha256Hex(nonce)}`;
    return (await this.redis.set(key, randomBytes(8).toString("hex"), { NX: true, EX: ttlSeconds })) === "OK";
  }
}
