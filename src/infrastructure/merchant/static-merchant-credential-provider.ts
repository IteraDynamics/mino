import type { MerchantCredentialProvider } from "../../modules/payments/background-payment-reconciler.js";
import { merchantCredentialKey } from "../config/production-config.js";

export class StaticMerchantCredentialProvider implements MerchantCredentialProvider {
  public constructor(private readonly credentials: ReadonlyMap<string, string>) {}

  public async getAuthorization(
    organizationId: string,
    merchantId: string,
  ): Promise<string | undefined> {
    return this.credentials.get(merchantCredentialKey(organizationId, merchantId));
  }
}
