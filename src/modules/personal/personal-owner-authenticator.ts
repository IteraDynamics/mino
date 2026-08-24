import {
  AdminJwtAuthenticator,
  type AdminJwtIssuerConfig,
  type AdminJwtAuthenticationResult,
} from "../admin/admin-jwt-authenticator.js";

export type PersonalJwtIssuerConfig = AdminJwtIssuerConfig;

export interface PersonalOwnerBearerAuthenticator {
  authenticateAuthorizationHeader(authorization: string | undefined): AdminJwtAuthenticationResult;
}

/**
 * Personal reuses the hardened JWT verifier implementation but not administrative
 * principals, memberships, roles, or permissions. Authentication proves the external
 * human identity only; Personal ownership is resolved separately in PostgreSQL.
 */
export class PersonalOwnerJwtAuthenticator implements PersonalOwnerBearerAuthenticator {
  private readonly verifier: AdminJwtAuthenticator;

  public constructor(
    issuerConfigs: readonly PersonalJwtIssuerConfig[],
    now: () => Date = () => new Date(),
  ) {
    this.verifier = new AdminJwtAuthenticator(issuerConfigs, now);
  }

  public authenticateAuthorizationHeader(
    authorization: string | undefined,
  ): AdminJwtAuthenticationResult {
    return this.verifier.authenticateAuthorizationHeader(authorization);
  }
}
