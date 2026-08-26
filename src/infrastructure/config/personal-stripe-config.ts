import { z } from "zod";
import { readRequiredSecret } from "./secret-input.js";
import type { StripeExecutionTarget } from "../../modules/providers/stripe/stripe-authoritative-intent.js";

export interface PersonalStripeConfig {
  readonly target: StripeExecutionTarget;
  readonly authorization: string;
}

const schema = z.object({
  MINO_PERSONAL_STRIPE_TARGET_ID: z.string().min(1).optional(),
  MINO_PERSONAL_STRIPE_ORGANIZATION_ID: z.string().uuid().optional(),
  MINO_PERSONAL_STRIPE_DOMAIN: z.string().min(1).optional(),
  MINO_PERSONAL_STRIPE_ACCOUNT_ID: z.string().regex(/^acct_[A-Za-z0-9]+$/).optional(),
  MINO_PERSONAL_STRIPE_LIVEMODE: z.enum(["0", "1"]).optional(),
  MINO_PERSONAL_STRIPE_SECRET_KEY: z.string().min(1).optional(),
  MINO_PERSONAL_STRIPE_SECRET_KEY_FILE: z.string().min(1).optional(),
});

/**
 * Optional User #1 Stripe target. Nothing is enabled unless the target is fully
 * configured. The provider secret remains server-side and may be file-mounted.
 */
export function loadPersonalStripeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): PersonalStripeConfig | undefined {
  const parsed = schema.safeParse(environment);
  if (!parsed.success) {
    throw new Error("Mino Personal Stripe configuration is invalid");
  }
  const values = parsed.data;
  const touched = [
    values.MINO_PERSONAL_STRIPE_TARGET_ID,
    values.MINO_PERSONAL_STRIPE_ORGANIZATION_ID,
    values.MINO_PERSONAL_STRIPE_DOMAIN,
    values.MINO_PERSONAL_STRIPE_ACCOUNT_ID,
    values.MINO_PERSONAL_STRIPE_LIVEMODE,
    values.MINO_PERSONAL_STRIPE_SECRET_KEY,
    values.MINO_PERSONAL_STRIPE_SECRET_KEY_FILE,
  ].some((value) => value !== undefined);
  if (!touched) return undefined;

  if (
    !values.MINO_PERSONAL_STRIPE_TARGET_ID ||
    !values.MINO_PERSONAL_STRIPE_ORGANIZATION_ID ||
    !values.MINO_PERSONAL_STRIPE_DOMAIN ||
    !values.MINO_PERSONAL_STRIPE_LIVEMODE
  ) {
    throw new Error("Mino Personal Stripe target configuration is incomplete");
  }
  if (values.MINO_PERSONAL_STRIPE_SECRET_KEY && values.MINO_PERSONAL_STRIPE_SECRET_KEY_FILE) {
    throw new Error("Mino Personal Stripe secret must use exactly one source");
  }

  const secret = readRequiredSecret(
    {
      ...(values.MINO_PERSONAL_STRIPE_SECRET_KEY
        ? { inline: values.MINO_PERSONAL_STRIPE_SECRET_KEY }
        : {}),
      ...(values.MINO_PERSONAL_STRIPE_SECRET_KEY_FILE
        ? { file: values.MINO_PERSONAL_STRIPE_SECRET_KEY_FILE }
        : {}),
    },
    "MINO_PERSONAL_STRIPE_SECRET_KEY",
  ).trim();
  if (!/^(?:sk|rk)_(?:test|live)_[A-Za-z0-9_]+$/.test(secret)) {
    throw new Error("Mino Personal Stripe secret key format is invalid");
  }

  const expectedLivemode = values.MINO_PERSONAL_STRIPE_LIVEMODE === "1";
  const secretIsLive = /^(?:sk|rk)_live_/.test(secret);
  if (expectedLivemode !== secretIsLive) {
    throw new Error("Mino Personal Stripe secret key mode does not match configured livemode");
  }

  const domain = canonicalDomain(values.MINO_PERSONAL_STRIPE_DOMAIN);
  return {
    target: {
      id: values.MINO_PERSONAL_STRIPE_TARGET_ID.trim(),
      organizationId: values.MINO_PERSONAL_STRIPE_ORGANIZATION_ID,
      domain,
      expectedLivemode,
      ...(values.MINO_PERSONAL_STRIPE_ACCOUNT_ID
        ? { accountId: values.MINO_PERSONAL_STRIPE_ACCOUNT_ID }
        : {}),
      active: true,
    },
    authorization: `Bearer ${secret}`,
  };
}

function canonicalDomain(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (
    !normalized ||
    !normalized.includes(".") ||
    normalized.includes("://") ||
    normalized.includes("/") ||
    normalized.includes("@") ||
    normalized.includes(":")
  ) {
    throw new Error("Mino Personal Stripe domain is invalid");
  }
  return normalized;
}
