import { describe, expect, it } from "vitest";
import { hasPermission } from "../../src/modules/admin/admin-authorizer.js";

describe("beneficiary administrative permissions", () => {
  it("keeps beneficiary mutation with finance/security owners while broader operator roles remain read-only", () => {
    expect(hasPermission(["ORGANIZATION_OWNER"], "beneficiary.create")).toBe(true);
    expect(hasPermission(["SECURITY_ADMIN"], "beneficiary.suspend")).toBe(true);
    expect(hasPermission(["FINANCE_MANAGER"], "beneficiary.create")).toBe(true);
    expect(hasPermission(["FINANCE_MANAGER"], "beneficiary.suspend")).toBe(true);

    expect(hasPermission(["AGENT_MANAGER"], "beneficiary.read")).toBe(true);
    expect(hasPermission(["AGENT_MANAGER"], "beneficiary.create")).toBe(false);
    expect(hasPermission(["APPROVER"], "beneficiary.read")).toBe(true);
    expect(hasPermission(["APPROVER"], "beneficiary.suspend")).toBe(false);
    expect(hasPermission(["AUDITOR"], "beneficiary.read")).toBe(true);
    expect(hasPermission(["AUDITOR"], "beneficiary.create")).toBe(false);
  });
});
