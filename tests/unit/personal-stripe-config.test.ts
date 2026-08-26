import { describe, expect, it } from "vitest";
import { loadPersonalStripeConfig } from "../../src/infrastructure/config/personal-stripe-config.js";

const ORG_ID = "11111111-1111-4111-8111-111111111111";

function configured(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    MINO_PERSONAL_STRIPE_TARGET_ID: "stripe-user-1",
    MINO_PERSONAL_STRIPE_ORGANIZATION_ID: ORG_ID,
    MINO_PERSONAL_STRIPE_DOMAIN: "supplier.example",
    MINO_PERSONAL_STRIPE_ACCOUNT_ID: "acct_123",
    MINO_PERSONAL_STRIPE_LIVEMODE: "0",
    MINO_PERSONAL_STRIPE_SECRET_KEY: "rk_test_mino51",
    ...overrides,
  };
}

describe("Personal Stripe configuration", () => {
  it("is completely disabled when no Stripe configuration is present", () => {
    expect(loadPersonalStripeConfig({})).toBeUndefined();
  });

  it("requires a complete target if any Stripe configuration is touched", () => {
    expect(() =>
      loadPersonalStripeConfig({ MINO_PERSONAL_STRIPE_TARGET_ID: "stripe-user-1" }),
    ).toThrowError("Mino Personal Stripe target configuration is incomplete");
  });

  it("rejects a secret whose test/live mode disagrees with the target", () => {
    expect(() =>
      loadPersonalStripeConfig(
        configured({
          MINO_PERSONAL_STRIPE_LIVEMODE: "1",
          MINO_PERSONAL_STRIPE_SECRET_KEY: "sk_test_wrong_mode",
        }),
      ),
    ).toThrowError("Mino Personal Stripe secret key mode does not match configured livemode");
  });

  it("returns the provider credential only in server-side configuration", () => {
    const config = loadPersonalStripeConfig(configured());
    expect(config).toEqual({
      target: {
        id: "stripe-user-1",
        organizationId: ORG_ID,
        domain: "supplier.example",
        accountId: "acct_123",
        expectedLivemode: false,
        active: true,
      },
      authorization: "Bearer rk_test_mino51",
    });
  });
});