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

export function buildPairingPayload(input: PairingPayloadInput): string;
export function buildMandatePayload(input: MandatePayloadInput): string;
export function main(argv?: string[], environment?: NodeJS.ProcessEnv): Promise<void>;
