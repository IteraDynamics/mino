import type { EconomicProviderCredentialProvider } from "../../modules/execution/economic-reconciliation-adapter.js";
import { merchantCredentialKey } from "../config/production-config.js";

export class StaticMerchantCredentialProvider implements EconomicProviderCredentialProvider {
  public constructor(private readonly credentials: ReadonlyMap<string, string>) {}

  public async getAuthorization(
    organizationId: string,
    providerTargetId: string,
  ): Promise<string | undefined> {
    return this.credentials.get(merchantCredentialKey(organizationId, providerTargetId));
  }
}
