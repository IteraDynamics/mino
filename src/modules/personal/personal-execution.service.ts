import type { AgentRequestProof } from "../agents/agent-request-verifier.js";
import type { MandateTokenService } from "../mandates/mandate-token.service.js";
import type {
  CheckoutProxyResult,
  CheckoutProxyService,
} from "../proxy/checkout-proxy.service.js";

export interface PersonalExecutionCredentialProvider {
  getAuthorization(
    organizationId: string,
    providerTargetId: string,
  ): Promise<string | undefined>;
}

export interface PersonalExecutionSecurity {
  readonly mandateToken: string;
  readonly agentProof: AgentRequestProof;
  readonly apiVersion: string;
}

export interface PersonalCompleteCheckoutInput {
  readonly merchantId: string;
  readonly checkoutSessionId: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly path: string;
  readonly body: unknown;
  readonly security: PersonalExecutionSecurity;
  readonly now: Date;
}

export class PersonalExecutionCredentialUnavailableError extends Error {
  public constructor() {
    super("The requested Personal execution target is not configured");
    this.name = "PersonalExecutionCredentialUnavailableError";
  }
}

/**
 * Personal guards the economic choke point, not cart/session construction.
 *
 * The agent may build a cart or checkout session through its ordinary merchant
 * tooling. When it is ready to complete the economic action, it authenticates to
 * Mino with its bounded mandate + Ed25519 proof. Mino resolves the upstream
 * execution credential server-side and delegates to the existing hardened
 * CheckoutProxyService.
 *
 * CheckoutProxyService remains authoritative for durable mandate binding,
 * authoritative cart re-fetch, policy evaluation, reservations, owner approval,
 * audit, execution, payment-outcome persistence, and reconciliation semantics.
 */
export class PersonalACPExecutionService {
  public constructor(
    private readonly mandateTokens: Pick<MandateTokenService, "verify">,
    private readonly proxy: Pick<CheckoutProxyService, "completeCheckout">,
    private readonly credentials: PersonalExecutionCredentialProvider,
  ) {}

  public async completeCheckout(input: PersonalCompleteCheckoutInput): Promise<CheckoutProxyResult> {
    const verified = await this.mandateTokens.verify(input.security.mandateToken, input.now);
    const authorization = await this.credentials.getAuthorization(
      verified.claims.organizationId,
      input.merchantId,
    );
    if (!authorization || !/^Bearer\s+\S+$/i.test(authorization.trim())) {
      throw new PersonalExecutionCredentialUnavailableError();
    }

    return this.proxy.completeCheckout({
      merchantId: input.merchantId,
      checkoutSessionId: input.checkoutSessionId,
      requestId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      path: input.path,
      body: input.body,
      security: {
        mandateToken: input.security.mandateToken,
        agentProof: input.security.agentProof,
        apiVersion: input.security.apiVersion,
        authorization: authorization.trim(),
      },
      now: input.now,
    });
  }
}
