import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Base64Url } from "../../src/infrastructure/crypto/canonical-json.js";
import { HmacApprovalResolutionAuthenticator } from "../../src/modules/approvals/approval-resolution-authenticator.js";

const secret = "test-approval-resolution-secret-at-least-32-bytes";
const now = new Date("2026-08-14T16:00:00.000Z");
const timestamp = Math.floor(now.getTime() / 1000).toString(10);
const path = "/v1/approvals/10000000-0000-4000-8000-000000000001/votes";

function sign(args: {
  method?: string;
  path?: string;
  approverId?: string;
  body?: unknown;
  timestamp?: string;
}) {
  const method = args.method ?? "POST";
  const targetPath = args.path ?? path;
  const approverId = args.approverId ?? "finance-alice@example.test";
  const body = args.body ?? { decision: "APPROVE", comment: "reviewed" };
  const at = args.timestamp ?? timestamp;
  const bodyDigest = sha256Base64Url(canonicalJson(body));
  const signature = createHmac("sha256", secret)
    .update([at, method, targetPath, approverId, bodyDigest].join("\n"))
    .digest("hex");
  return { method, path: targetPath, approverId, body, timestamp: at, signature };
}

describe("HmacApprovalResolutionAuthenticator", () => {
  it("accepts a valid timestamped actor/path/body-bound signature", async () => {
    const signed = sign({});
    const auth = new HmacApprovalResolutionAuthenticator({ secret });

    await expect(
      auth.verify({
        method: signed.method,
        path: signed.path,
        body: signed.body,
        proof: {
          approverId: signed.approverId,
          timestamp: signed.timestamp,
          signature: signed.signature,
        },
        now,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects signatures replayed with a changed vote body, path, or approver", async () => {
    const signed = sign({});
    const auth = new HmacApprovalResolutionAuthenticator({ secret });

    for (const changed of [
      { body: { decision: "REJECT" }, path: signed.path, approverId: signed.approverId },
      { body: signed.body, path: `${signed.path}/other`, approverId: signed.approverId },
      { body: signed.body, path: signed.path, approverId: "finance-bob@example.test" },
    ]) {
      await expect(
        auth.verify({
          method: signed.method,
          path: changed.path,
          body: changed.body,
          proof: {
            approverId: changed.approverId,
            timestamp: signed.timestamp,
            signature: signed.signature,
          },
          now,
        }),
      ).rejects.toMatchObject({
        code: "INVALID_SIGNATURE",
      });
    }
  });

  it("rejects otherwise valid signatures outside the clock-skew window", async () => {
    const staleTimestamp = Math.floor((now.getTime() - 301_000) / 1000).toString(10);
    const signed = sign({ timestamp: staleTimestamp });
    const auth = new HmacApprovalResolutionAuthenticator({ secret, maxClockSkewSeconds: 300 });

    await expect(
      auth.verify({
        method: signed.method,
        path: signed.path,
        body: signed.body,
        proof: {
          approverId: signed.approverId,
          timestamp: signed.timestamp,
          signature: signed.signature,
        },
        now,
      }),
    ).rejects.toMatchObject({
      code: "TIMESTAMP_OUT_OF_RANGE",
    });
  });
});
