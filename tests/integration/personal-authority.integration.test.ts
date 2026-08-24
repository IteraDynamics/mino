import { createHash, generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { signEd25519 } from "../../src/infrastructure/crypto/ed25519.js";
import { StaticMandateVerificationKeyResolver } from "../../src/infrastructure/crypto/static-key-providers.js";
import { PgSqlAdapter } from "../../src/infrastructure/postgres/pg-sql-adapter.js";
import { MandateTokenService } from "../../src/modules/mandates/mandate-token.service.js";
import {
  PostgresPersonalAuthorityService,
  buildPersonalMandateSigningPayload,
  type PersonalCredentialNonceGuard,
} from "../../src/modules/personal/personal-authority.service.js";
import {
  PostgresPersonalPairingService,
  buildPersonalPairingSigningPayload,
} from "../../src/modules/personal/personal-pairing.service.js";

const integration = process.env.RUN_INTEGRATION_TESTS === "1" ? describe : describe.skip;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://mino:mino@127.0.0.1:5432/mino?schema=public";
const now = new Date("2026-08-24T17:00:00.000Z");
const ownerIdentity = { issuer: "https://personal.test", subject: "authority-owner" };

integration("Mino Personal authority", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  beforeEach(async () => {
    await cleanupPersonal(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("keeps pairing powerless, grants bounded policy separately, mints an agent credential, and revokes immediately", async () => {
    const sql = new PgSqlAdapter(pool);
    const pairingService = new PostgresPersonalPairingService(sql, undefined, () => now);
    const owner = await pairingService.bootstrap(ownerIdentity, {
      beneficiaryEmail: "owner@example.test",
      displayName: "Owner",
    });
    expect(owner.outcome).toBe("CREATED");
    if (owner.outcome !== "CREATED") throw new Error("owner bootstrap failed");

    const agentKeys = generateKeyPairSync("ed25519");
    const agentPublic = agentKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const agentPrivate = agentKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const keyId = "openclaw-authority-k1";
    const externalAgentId = "openclaw-authority";
    const pairingNonce = "pairing-authority-nonce-1234";
    const pairingTimestamp = Math.floor(now.getTime() / 1000);
    const fingerprint = createHash("sha256")
      .update(agentKeys.publicKey.export({ type: "spki", format: "der" }))
      .digest("base64url");
    const pairingPayload = buildPersonalPairingSigningPayload({
      externalAgentId,
      displayName: "OpenClaw",
      keyId,
      publicKeyFingerprint: fingerprint,
      timestamp: pairingTimestamp,
      nonce: pairingNonce,
    });
    const pairing = await pairingService.createPairingRequest({
      externalAgentId,
      displayName: "OpenClaw",
      keyId,
      publicKey: agentPublic,
      proof: {
        timestamp: pairingTimestamp,
        nonce: pairingNonce,
        signature: signEd25519(pairingPayload, agentPrivate).toString("base64url"),
      },
    });
    const claimed = await pairingService.claimPairingRequest(ownerIdentity, pairing.id, pairing.claimSecret);
    expect(claimed.outcome).toBe("CLAIMED");
    if (claimed.outcome !== "CLAIMED") throw new Error("pairing claim failed");
    const agentId = claimed.pairing.agentId;

    const beforeAuthority = await pool.query<{ policies: string; mandates: string }>(
      `select
         (select count(*) from "Policy" where "organizationId" = $1::uuid)::text as "policies",
         (select count(*) from "AgentMandate" where "organizationId" = $1::uuid)::text as "mandates"`,
      [owner.owner.organizationId],
    );
    expect(beforeAuthority.rows[0]).toEqual({ policies: "0", mandates: "0" });

    const mandateKeys = generateKeyPairSync("ed25519");
    const mandatePublic = mandateKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const mandatePrivate = mandateKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const tokens = new MandateTokenService(
      new StaticMandateVerificationKeyResolver(new Map([["personal-m1", mandatePublic]])),
      { issuer: "https://mino.example" },
    );
    const nonceGuard = new MemoryNonceGuard();
    const authority = new PostgresPersonalAuthorityService(
      sql,
      tokens,
      { keyId: "personal-m1", privateKey: mandatePrivate },
      "https://mino.example",
      nonceGuard,
      undefined,
      () => now,
    );

    const created = await authority.setAuthority(ownerIdentity, agentId, {
      currency: "USD",
      perTransactionLimit: "100.00",
      dailyLimit: "300.00",
      allowedMerchantDomains: ["shop.example"],
      restrictedCategories: ["GIFT_CARDS"],
      overLimitBehavior: "ASK_OWNER",
    });
    expect(created.outcome).toBe("CREATED");
    if (!("authority" in created)) throw new Error("authority creation failed");
    expect(created.authority).toMatchObject({
      agentId,
      version: 1,
      profile: {
        currency: "USD",
        perTransactionLimit: "100.00",
        dailyLimit: "300.00",
        overLimitBehavior: "ASK_OWNER",
      },
    });

    const replay = await authority.setAuthority(ownerIdentity, agentId, {
      currency: "USD",
      perTransactionLimit: "100.00",
      dailyLimit: "300.00",
      allowedMerchantDomains: ["shop.example"],
      restrictedCategories: ["GIFT_CARDS"],
      overLimitBehavior: "ASK_OWNER",
    });
    expect(replay.outcome).toBe("REPLAYED");

    const beforeCredential = await pool.query<{ count: string }>(
      `select count(*)::text as "count" from "AgentMandate" where "agentId" = $1::uuid`,
      [agentId],
    );
    expect(beforeCredential.rows[0]?.count).toBe("0");

    const mandateNonce = "mandate-authority-nonce-1234";
    const mandateTimestamp = Math.floor(now.getTime() / 1000);
    const mandatePayload = buildPersonalMandateSigningPayload(agentId, keyId, mandateTimestamp, mandateNonce);
    const proof = {
      keyId,
      timestamp: mandateTimestamp,
      nonce: mandateNonce,
      signature: signEd25519(mandatePayload, agentPrivate).toString("base64url"),
    };
    const issued = await authority.issueMandate(agentId, proof);
    expect(issued.outcome).toBe("ISSUED");
    if (issued.outcome !== "ISSUED") throw new Error("mandate issuance failed");
    const verified = await tokens.verify(issued.mandateToken, now);
    expect(verified.claims).toMatchObject({
      organizationId: owner.owner.organizationId,
      userId: owner.owner.userId,
      agentId,
      mandateId: issued.mandateId,
      policyVersion: 1,
    });
    expect(await authority.issueMandate(agentId, proof)).toEqual({ outcome: "PROOF_REPLAYED" });

    const updated = await authority.setAuthority(ownerIdentity, agentId, {
      currency: "USD",
      perTransactionLimit: "50.00",
      dailyLimit: "200.00",
      allowedMerchantDomains: ["shop.example"],
      overLimitBehavior: "BLOCK",
    });
    expect(updated.outcome).toBe("UPDATED");
    if (!("authority" in updated)) throw new Error("authority update failed");
    expect(updated.authority.version).toBe(2);

    const oldMandate = await pool.query<{ status: string }>(
      `select "status"::text as "status" from "AgentMandate" where "id" = $1::uuid`,
      [issued.mandateId],
    );
    expect(oldMandate.rows[0]?.status).toBe("REVOKED");

    const newNonce = "mandate-authority-nonce-5678";
    const newPayload = buildPersonalMandateSigningPayload(agentId, keyId, mandateTimestamp, newNonce);
    const refreshed = await authority.issueMandate(agentId, {
      keyId,
      timestamp: mandateTimestamp,
      nonce: newNonce,
      signature: signEd25519(newPayload, agentPrivate).toString("base64url"),
    });
    expect(refreshed.outcome).toBe("ISSUED");
    if (refreshed.outcome !== "ISSUED") throw new Error("refreshed mandate failed");
    expect(refreshed.policyVersion).toBe(2);

    expect(await authority.revokeAuthority(ownerIdentity, agentId)).toEqual({ outcome: "REVOKED" });
    expect(await authority.issueMandate(agentId, {
      keyId,
      timestamp: mandateTimestamp,
      nonce: "mandate-authority-nonce-9999",
      signature: signEd25519(
        buildPersonalMandateSigningPayload(agentId, keyId, mandateTimestamp, "mandate-authority-nonce-9999"),
        agentPrivate,
      ).toString("base64url"),
    })).toEqual({ outcome: "AUTHORITY_NOT_GRANTED" });

    const activeMandates = await pool.query<{ count: string }>(
      `select count(*)::text as "count" from "AgentMandate" where "agentId" = $1::uuid and "status" = 'ACTIVE'`,
      [agentId],
    );
    expect(activeMandates.rows[0]?.count).toBe("0");
  });
});

class MemoryNonceGuard implements PersonalCredentialNonceGuard {
  private readonly seen = new Set<string>();
  public async claim(agentId: string, nonce: string): Promise<boolean> {
    const key = `${agentId}:${nonce}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}

async function cleanupPersonal(pool: Pool): Promise<void> {
  await pool.query('delete from "PersonalPairingRequest"');
  const organizations = await pool.query<{ id: string }>(`select "id" from "Organization" where "kind" = 'PERSONAL'`);
  const ids = organizations.rows.map((row) => row.id);
  if (ids.length > 0) {
    await pool.query('delete from "PaymentOutcome" where "organizationId" = any($1::uuid[])', [ids]);
    await pool.query('delete from "SpendReservation" where "organizationId" = any($1::uuid[])', [ids]);
    await pool.query('delete from "ApprovalRequest" where "organizationId" = any($1::uuid[])', [ids]);
    await pool.query('delete from "AuditLog" where "organizationId" = any($1::uuid[])', [ids]);
    await pool.query('delete from "AgentMandate" where "organizationId" = any($1::uuid[])', [ids]);
    await pool.query('delete from "Policy" where "organizationId" = any($1::uuid[])', [ids]);
    await pool.query('delete from "MerchantEndpoint" where "organizationId" = any($1::uuid[])', [ids]);
    await pool.query('delete from "AgentIdentity" where "organizationId" = any($1::uuid[])', [ids]);
    await pool.query('delete from "User" where "organizationId" = any($1::uuid[])', [ids]);
  }
  await pool.query('delete from "PersonalOwner"');
  await pool.query(`delete from "Organization" where "kind" = 'PERSONAL'`);
}
