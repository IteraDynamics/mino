# Mino agent integration kit

PR #43 provides a small Node.js reference client for a design partner's agent. It wraps the existing Mino agent-proof and ACP HTTP contract; it does not create a second authorization model.

The implementation lives at:

```text
src/client/mino-agent-client.ts
```

The pilot goal is deliberately narrow: an engineer who already has an agent and merchant/payment workflow should be able to call Mino correctly without reimplementing the signing payload, nonce handling, mandate-token binding, or payment retry semantics from prose.

## What the client owns

The reference client owns only request construction:

- Ed25519 agent request signing;
- fresh Unix-second timestamp and replay nonce per HTTP attempt;
- binding the signature to the mandate-token JTI digest;
- binding method, exact Mino path, canonical body, ACP version, and idempotency key;
- current ACP route construction;
- Mino control headers;
- exact caller-owned idempotency-key reuse;
- safe classification of approval-required and unresolved-payment responses.

It does **not** decide whether a transaction is allowed.

Mino still verifies, server-side:

- the mandate token signature, issuer, audience, time window, and durable mandate snapshot;
- current beneficiary, agent, key, policy, merchant, and revocation state;
- the Ed25519 request proof;
- nonce replay through Redis;
- merchant-authoritative checkout state;
- policy and machine controls;
- human-approval binding;
- spend reservation;
- payment outcome and reconciliation state.

The client decodes the mandate token locally only to obtain the JTI digest and to reject an obvious agent-ID mismatch before sending. That decode is **not mandate verification** and must never be treated as authorization.

## Key bootstrap

The helper can generate an Ed25519 key pair:

```ts
import { generateEd25519AgentKeyPair } from "../src/client/mino-agent-client.js";

const keys = generateEd25519AgentKeyPair("procurement-agent-k1");
console.log(keys.publicKeyPem);
```

Enroll only the **public** key in Mino. The private key belongs in the agent's credential boundary, not in Mino, the administrative console, source control, logs, browser storage, or audit payloads.

The built-in generator is a reference/bootstrap convenience. A design partner may instead generate or hold the Ed25519 private key in its normal secrets/KMS/HSM boundary as long as the signing operation produces the same Ed25519 signature over Mino's exact signing payload.

## Construct the client

After four-eyes mandate issuance is applied, the administrator receives the mandate bearer token once. Deliver that token to the intended agent credential boundary.

```ts
import {
  MinoACPAgentClient,
  createMinoIdempotencyKey,
} from "../src/client/mino-agent-client.js";

const mino = new MinoACPAgentClient({
  baseUrl: "https://mino.pilot.example",
  agentId: process.env.MINO_AGENT_ID!,
  keyId: "procurement-agent-k1",
  privateKey: process.env.MINO_AGENT_PRIVATE_KEY_PEM!,
  mandateToken: process.env.MINO_MANDATE_TOKEN!,

  // This is the ACP merchant/upstream bearer credential that Mino forwards only
  // to the registered merchant route. It is not an administrator JWT.
  merchantAuthorization: `Bearer ${process.env.MERCHANT_ACP_TOKEN!}`,
});
```

The client is Node.js 22-oriented, matching the Mino repository runtime.

## Request proof

Every request is signed over the same payload consumed by `AgentRequestVerifier`:

```text
MINO-AGENT-REQUEST-V1
<METHOD>
<EXACT MINO PATH>
<UNIX TIMESTAMP>
<FRESH NONCE>
<SHA-256 HEX OF MANDATE JTI>
<ACP API VERSION>
<IDEMPOTENCY KEY OR EMPTY STRING>
<SHA-256 BASE64URL OF CANONICAL BODY>
```

The resulting request carries:

```text
X-Mino-Mandate-Token
X-Mino-Agent-Id
X-Mino-Agent-Key-Id
X-Mino-Agent-Timestamp
X-Mino-Agent-Nonce
X-Mino-Agent-Signature
API-Version: 2026-04-17
```

Mutating ACP operations also carry the exact caller-owned `Idempotency-Key`.

Changing the method, path, body, mandate, API version, or idempotency key after signing invalidates the proof. Reusing the exact nonce is rejected as replay.

## Checkout lifecycle

The reference client exposes the existing Mino ACP edge:

```ts
const createKey = createMinoIdempotencyKey();
const created = await mino.createCheckout(
  "northstar-supplier",
  {
    line_items: [
      { item: { id: "paper-a4" }, quantity: 2 },
    ],
  },
  createKey,
);
```

After the merchant creates the checkout, use the returned checkout-session ID for lifecycle operations:

```ts
await mino.retrieveCheckout("northstar-supplier", "cs_123");

await mino.updateCheckout(
  "northstar-supplier",
  "cs_123",
  { fulfillment_option_id: "standard" },
  createMinoIdempotencyKey(),
);

await mino.cancelCheckout(
  "northstar-supplier",
  "cs_123",
  {},
  createMinoIdempotencyKey(),
);
```

Retrieve is intentionally bodyless and has no merchant `Idempotency-Key`; its signature binds canonical `null` and an empty idempotency string. Update and cancel are authenticated control operations, not payment delegation.

## Payment completion

Completion is the payment-bearing operation. The caller creates one semantic idempotency key and keeps it with the exact request until the outcome is terminal:

```ts
const completionKey = createMinoIdempotencyKey();
const completionBody = { confirmation: true };

let result = await mino.completeCheckout(
  "northstar-supplier",
  "cs_123",
  completionBody,
  completionKey,
);
```

Possible high-level classifications include:

- `success` — the request reached a successful Mino/merchant state;
- `blocked` — current policy or hard controls refused it;
- `approval_required` — the exact completion needs transaction-level human approval;
- `payment_pending` — payment was dispatched or may have been dispatched, but merchant-authoritative final state is unresolved;
- `idempotency_conflict` — the key was reused for a different semantic request;
- `unauthorized` — mandate or agent authentication failed;
- `protocol_error` — the request violated the pinned protocol boundary;
- `upstream_error` — the registered merchant returned an upstream failure;
- `error` — another non-success response.

The client does not auto-retry mutations.

## Human-approval retry

For `COMPLETE_CHECKOUT`, an `approval_required` response includes retry advice:

```ts
if (result.kind === "approval_required") {
  // Wait for the human approval workflow outside the agent client.
  // Then retry the exact body/path with the SAME semantic idempotency key.
  result = await mino.completeCheckout(
    "northstar-supplier",
    "cs_123",
    completionBody,
    completionKey,
  );
}
```

The second call deliberately creates a **fresh timestamp, nonce, and Ed25519 signature** while preserving the same body/path/idempotency semantics.

This distinction matters:

```text
same semantic retry
  = same request body/path + same idempotency key + fresh proof

replay attack
  = reused signed proof / reused nonce
```

Mino rejects the second form.

An approved transaction is still not blindly forwarded. Mino refetches current merchant checkout state and re-runs current mandate, policy, reservation, and machine controls before payment authorization can become `ALLOW`.

## Unresolved payment retry

If completion returns `payment_pending`, Mino has intentionally **not** assumed failure. Allowance remains protected while Mino reconciles against merchant/provider-authoritative state.

The response exposes bounded retry guidance derived from `Retry-After` when present:

```ts
if (result.kind === "payment_pending") {
  await new Promise((resolve) => setTimeout(resolve, result.retry.retryAfterMs ?? 2000));

  result = await mino.completeCheckout(
    "northstar-supplier",
    "cs_123",
    completionBody,
    completionKey, // same key
  );
}
```

The same-idempotency completion path reconciles the existing durable payment outcome instead of blindly dispatching a second payment.

Background reconciliation may also resolve the payment independently of an agent retry.

## Transport uncertainty

A socket timeout or connection loss throws `MinoAgentTransportError` and preserves the operation and idempotency key in the error object.

Transport failure is not proof that the mutation did not reach Mino. Do not mint a new idempotency key merely because the HTTP connection failed. For a payment completion, retry the exact request with the same key and a fresh proof so Mino can recover against durable outcome state.

The client intentionally does not hide transport uncertainty behind an automatic retry loop.

## Idempotency conflict

`idempotency_conflict` is not a transient response. It means the supplied key is already bound to different request semantics. Do not repeatedly retry the conflicting request under that key.

A new idempotency key represents a new semantic operation; it must never be used to bypass an unresolved prior payment attempt.

## Security boundary

The reference client is convenience code, not trusted authorization state.

Compromise or modification of the client cannot make Mino accept:

- an invalid or revoked mandate;
- a suspended beneficiary or agent;
- an unknown/rotated key;
- an unregistered merchant route;
- a changed signed body/path/idempotency value;
- a replayed nonce;
- a policy `BLOCK`;
- an unapproved soft-limit exception;
- a payment outcome unsupported by merchant/provider evidence.

The client makes the correct protocol easier to use; the server remains the authority.
