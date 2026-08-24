export interface PairingPayloadInput {
  externalAgentId: string;
  displayName?: string;
  keyId: string;
  publicKeyFingerprint: string;
  timestamp: number;
  nonce: string;
}

export interface MandatePayloadInput {
  agentId: string;
  keyId: string;
  timestamp: number;
  nonce: string;
}

export interface AgentRequestPayloadInput {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  body: unknown;
  mandateTokenJtiHash: string;
  idempotencyKey: string;
  apiVersion: string;
}

export function buildPairingPayload(input: PairingPayloadInput): string;
export function buildMandatePayload(input: MandatePayloadInput): string;
export function buildAgentRequestPayload(input: AgentRequestPayloadInput): string;
export function main(argv?: string[], environment?: NodeJS.ProcessEnv): Promise<void>;
