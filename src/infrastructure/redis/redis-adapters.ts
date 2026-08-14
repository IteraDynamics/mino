import type { RedisClientType } from "redis";
import type { NonceReplayGuard } from "../../modules/agents/agent-request-verifier.js";
import type { RedisScriptClient } from "../../modules/spending/authorization-reservation.service.js";

export class RedisAuthorizationScriptClient implements RedisScriptClient {
  public constructor(private readonly client: RedisClientType) {}

  public eval(
    script: string,
    options: {
      readonly keys: readonly string[];
      readonly arguments: readonly string[];
    },
  ): Promise<unknown> {
    return this.client.eval(script, {
      keys: [...options.keys],
      arguments: [...options.arguments],
    });
  }
}

export class RedisNonceReplayGuard implements NonceReplayGuard {
  public constructor(
    private readonly client: RedisClientType,
    private readonly keyPrefix = "mino:v1:nonce",
  ) {}

  public async claim(agentId: string, nonce: string, ttlSeconds: number): Promise<boolean> {
    const key = `${this.keyPrefix}:${encodeURIComponent(agentId)}:${encodeURIComponent(nonce)}`;
    const result = await this.client.set(key, "1", {
      NX: true,
      EX: ttlSeconds,
    });
    return result === "OK";
  }
}
