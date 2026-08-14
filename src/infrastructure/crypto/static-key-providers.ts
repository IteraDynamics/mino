import type { Ed25519KeyInput } from "./ed25519.js";
import type { MandateVerificationKeyResolver } from "../../modules/mandates/mandate-token.service.js";
import type {
  AuditSigningKey,
  AuditSigningKeyProvider,
  AuditVerificationKeyResolver,
} from "../../modules/audit/postgres-audit-ledger.js";

export class StaticMandateVerificationKeyResolver implements MandateVerificationKeyResolver {
  public constructor(private readonly keys: ReadonlyMap<string, Ed25519KeyInput>) {}

  public async resolvePublicKey(keyId: string): Promise<Ed25519KeyInput | undefined> {
    return this.keys.get(keyId);
  }
}

export class StaticAuditKeyProvider
  implements AuditSigningKeyProvider, AuditVerificationKeyResolver
{
  public constructor(
    private readonly signingKey: AuditSigningKey,
    private readonly verificationKeys: ReadonlyMap<string, Ed25519KeyInput>,
  ) {}

  public async getActiveSigningKey(_organizationId: string): Promise<AuditSigningKey> {
    return this.signingKey;
  }

  public async resolvePublicKey(keyId: string): Promise<Ed25519KeyInput | undefined> {
    return this.verificationKeys.get(keyId);
  }
}
