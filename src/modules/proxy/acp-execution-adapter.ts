import type { AuthorizationDecision } from "../../domain/economic/authorization-decision.js";
import type { SignedAuthorizationGrant } from "../../domain/economic/authorization-grant.types.js";
import type { CheckoutIntent } from "../../domain/checkout/checkout.types.js";
import type { PolicyDecision } from "../../domain/evaluation/evaluation.types.js";
import type { AuthorizationGrantIssuer } from "../authorization/authorization-grant.service.js";
import type {
  EconomicExecutionAdapter,
  EconomicExecutionInput,
} from "../execution/execution-adapter.js";
import type { DelegationAssertionIssuer } from "./delegation-assertion.service.js";
import type {
  ACPMerchantClient,
  MerchantEndpoint,
  MerchantRequestHeaders,
  MerchantResponse,
} from "./merchant-client.js";

export interface ACPExecutionContext {
  readonly merchant: MerchantEndpoint;
  readonly checkoutSessionId: string;
  readonly payload: unknown;
  readonly headers: MerchantRequestHeaders;
  readonly delegationAssertion: string;
}

interface PreparedACPExecution {
  readonly intent: CheckoutIntent;
  readonly decision: AuthorizationDecision;
  readonly grant: SignedAuthorizationGrant;
  readonly delegationAssertion: string;
}

/** ACP adapter for the provider-neutral execution boundary. */
export class ACPExecutionAdapter
  implements
    EconomicExecutionAdapter<ACPExecutionContext, MerchantResponse>,
    ACPMerchantClient,
    DelegationAssertionIssuer
{
  public readonly protocol = "ACP" as const;
  private readonly prepared = new Map<string, PreparedACPExecution>();

  public constructor(
    private readonly client: ACPMerchantClient,
    private readonly grants: AuthorizationGrantIssuer,
    private readonly legacyDelegation: DelegationAssertionIssuer,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public issue(intent: CheckoutIntent, decision: PolicyDecision, now: Date): string {
    if (!("intentDigest" in decision) || typeof decision.intentDigest !== "string") {
      throw new Error("ACP execution requires an EconomicIntent-bound authorization decision");
    }
    const boundDecision = decision as AuthorizationDecision;
    this.removeExpired(now);
    const grant = this.grants.issue(intent, boundDecision, now);
    const delegationAssertion = this.legacyDelegation.issue(intent, decision, now);
    this.prepared.set(delegationAssertion, {
      intent,
      decision: boundDecision,
      grant,
      delegationAssertion,
    });
    return delegationAssertion;
  }

  public async execute(
    input: EconomicExecutionInput<ACPExecutionContext>,
  ): Promise<MerchantResponse> {
    if (input.intent.protocol !== this.protocol) {
      throw new Error("ACP execution adapter refuses non-ACP economic intent");
    }
    this.assertGrantBinding(input.grant, input.intent, input.decision);

    return this.client.completeCheckout(
      input.context.merchant,
      input.context.checkoutSessionId,
      input.context.payload,
      {
        ...input.context.headers,
        delegationAssertion: input.context.delegationAssertion,
      },
    );
  }

  public createCheckout(
    merchant: MerchantEndpoint,
    payload: unknown,
    headers: MerchantRequestHeaders,
  ): Promise<MerchantResponse> {
    return this.client.createCheckout(merchant, payload, headers);
  }

  public getCheckout(
    merchant: MerchantEndpoint,
    checkoutSessionId: string,
    headers: MerchantRequestHeaders,
  ): Promise<MerchantResponse> {
    return this.client.getCheckout(merchant, checkoutSessionId, headers);
  }

  public updateCheckout(
    merchant: MerchantEndpoint,
    checkoutSessionId: string,
    payload: unknown,
    headers: MerchantRequestHeaders,
  ): Promise<MerchantResponse> {
    if (!this.client.updateCheckout) {
      throw new Error("ACP merchant client does not support checkout updates");
    }
    return this.client.updateCheckout(merchant, checkoutSessionId, payload, headers);
  }

  public async completeCheckout(
    merchant: MerchantEndpoint,
    checkoutSessionId: string,
    payload: unknown,
    headers: MerchantRequestHeaders,
  ): Promise<MerchantResponse> {
    const delegationAssertion = headers.delegationAssertion;
    if (!delegationAssertion) {
      throw new Error("ACP execution requires a prepared authorization grant");
    }

    const now = this.clock();
    const prepared = this.prepared.get(delegationAssertion);
    if (!prepared) {
      throw new Error("ACP execution authorization is missing, expired, or already consumed");
    }
    this.prepared.delete(delegationAssertion);

    if (prepared.grant.claims.exp <= Math.floor(now.getTime() / 1000)) {
      throw new Error("ACP execution authorization grant is expired");
    }

    return this.execute({
      intent: prepared.intent,
      decision: prepared.decision,
      grant: prepared.grant,
      now,
      context: {
        merchant,
        checkoutSessionId,
        payload,
        headers,
        delegationAssertion,
      },
    });
  }

  public cancelCheckout(
    merchant: MerchantEndpoint,
    checkoutSessionId: string,
    headers: MerchantRequestHeaders,
    payload?: unknown,
  ): Promise<MerchantResponse> {
    return this.client.cancelCheckout(merchant, checkoutSessionId, headers, payload);
  }

  private assertGrantBinding(
    grant: SignedAuthorizationGrant,
    intent: CheckoutIntent,
    decision: AuthorizationDecision,
  ): void {
    if (
      grant.claims.request_id !== intent.requestId ||
      grant.claims.decision_id !== decision.decisionId ||
      grant.claims.mandate_id !== decision.mandateId ||
      grant.claims.operation !== intent.operation ||
      grant.claims.agent_id !== intent.agentId ||
      grant.claims.intent_digest !== decision.intentDigest
    ) {
      throw new Error("Authorization grant does not bind to the requested ACP execution");
    }
  }

  private removeExpired(now: Date): void {
    const nowSeconds = Math.floor(now.getTime() / 1000);
    for (const [assertion, prepared] of this.prepared.entries()) {
      if (prepared.grant.claims.exp <= nowSeconds) {
        this.prepared.delete(assertion);
      }
    }
  }
}
