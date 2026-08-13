import type { NonceReplayGuard } from "./agent-request-verifier.js";

export interface RedisSetClient {
  set(
    key: string,
    value: string,
    options: { readonly NX: true; readonly EX: number },
  ): Promise<string | null>;
}

export class RedisNonceReplayGuard implements NonceReplayGuard {
  public constructor(
    private readonly redis: RedisSetClient,
    private readonly keyPrefix = "mino:v1:nonce",
  ) {}

  public async claim(agentId: string, nonce: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.redis.set(
      `${this.keyPrefix}:${encodeURIComponent(agentId)}:${nonce}`,
      "1",
      { NX: true, EX: ttlSeconds },
    );
    return result === "OK";
  }
}
