import { createHmac } from "node:crypto";
import { canonicalJson } from "../../infrastructure/crypto/canonical-json.js";

export interface HumanApprovalEvent {
  readonly eventId: string;
  readonly type: "mino.approval.required";
  readonly createdAt: string;
  readonly decisionId: string;
  readonly requestId: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly mandateId: string;
  readonly merchantDomain: string;
  readonly checkoutSessionId?: string;
  readonly amountMinor: string;
  readonly currency: string;
  readonly approvalMode: string;
  readonly expiresAt: string;
}

export interface HumanApprovalEmitter {
  emit(event: HumanApprovalEvent): Promise<void>;
}

export class NoopHumanApprovalEmitter implements HumanApprovalEmitter {
  public async emit(_event: HumanApprovalEvent): Promise<void> {}
}

export interface WebhookApprovalEmitterOptions {
  readonly endpoint: string;
  readonly secret: string;
  readonly timeoutMs?: number;
}

export class WebhookApprovalEmitter implements HumanApprovalEmitter {
  private readonly timeoutMs: number;

  public constructor(private readonly options: WebhookApprovalEmitterOptions) {
    this.timeoutMs = options.timeoutMs ?? 5_000;
    const url = new URL(options.endpoint);
    if (url.protocol !== "https:") {
      throw new Error("Approval webhook endpoint must use HTTPS");
    }
    if (options.secret.length < 32) {
      throw new Error("Approval webhook secret must contain at least 32 characters");
    }
  }

  public async emit(event: HumanApprovalEvent): Promise<void> {
    const body = canonicalJson(event);
    const timestamp = Math.floor(Date.now() / 1000).toString(10);
    const signature = createHmac("sha256", this.options.secret)
      .update(`${timestamp}.${body}`)
      .digest("hex");

    const response = await fetch(this.options.endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        "X-Mino-Event-Id": event.eventId,
        "X-Mino-Signature": `t=${timestamp},v1=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Approval webhook rejected event with HTTP ${response.status}`);
    }
  }
}
