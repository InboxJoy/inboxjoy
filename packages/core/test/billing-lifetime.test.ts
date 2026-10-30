import { describe, expect, it } from "vitest";

import { findWorkspaceLifetimePayment, isLifetimePayment, lifetimePaymentWorkspaceId } from "../src/index.js";

const lifetimeProductId = "pdt_test_lifetime";
const workspaceId = "11111111-1111-4111-8111-111111111111";

function payment(overrides: Record<string, unknown> = {}) {
  return {
    payment_id: "pay_lifetime",
    status: "succeeded",
    subscription_id: null,
    product_cart: [{ product_id: lifetimeProductId, quantity: 1 }],
    customer: { customer_id: "cus_owner", email: "owner@example.com", name: "Owner" },
    metadata: { workspaceId },
    total_amount: 7900,
    currency: "USD",
    created_at: "2026-10-28T10:00:00.000Z",
    refund_status: null,
    ...overrides,
  };
}

describe("lifetime license payments", () => {
  it("recognises only one-time payments for the lifetime product", () => {
    expect(isLifetimePayment(payment(), lifetimeProductId)).toBe(true);
    expect(isLifetimePayment(payment({ product_cart: [{ product_id: "pdt_test_monthly", quantity: 1 }] }), lifetimeProductId)).toBe(false);
    // A subscription renewal never counts, whatever its cart says.
    expect(isLifetimePayment(payment({ subscription_id: "sub_renewal" }), lifetimeProductId)).toBe(false);
    expect(isLifetimePayment(payment({ product_cart: null }), lifetimeProductId)).toBe(false);
    expect(isLifetimePayment(payment(), undefined)).toBe(false);
  });

  it("reads the workspace from either metadata spelling", () => {
    expect(lifetimePaymentWorkspaceId(payment())).toBe(workspaceId);
    expect(lifetimePaymentWorkspaceId(payment({ metadata: { workspace_id: workspaceId } }))).toBe(workspaceId);
    expect(lifetimePaymentWorkspaceId(payment({ metadata: {} }))).toBeUndefined();
  });

  it("finds the newest valid lifetime payment for the workspace", () => {
    const older = payment({ payment_id: "pay_older", created_at: "2026-10-01T00:00:00.000Z" });
    const newer = payment({ payment_id: "pay_newer", created_at: "2026-10-20T00:00:00.000Z" });
    expect(findWorkspaceLifetimePayment([older, newer], { workspaceId, lifetimeProductId })?.payment_id).toBe("pay_newer");
  });

  it("skips refunded, unpaid and other-workspace payments", () => {
    const candidates = [
      payment({ payment_id: "pay_refunded", refund_status: "full" }),
      payment({ payment_id: "pay_failed", status: "failed" }),
      payment({ payment_id: "pay_other", metadata: { workspaceId: "22222222-2222-4222-8222-222222222222" } }),
      payment({ payment_id: "pay_untagged_stranger", metadata: {}, customer: { customer_id: "cus_stranger" } }),
    ];
    expect(findWorkspaceLifetimePayment(candidates, { workspaceId, lifetimeProductId, dodoCustomerId: "cus_owner" })).toBeUndefined();
    // A partial refund (a goodwill credit) keeps the license.
    expect(findWorkspaceLifetimePayment([payment({ refund_status: "partial" })], { workspaceId, lifetimeProductId })?.payment_id).toBe("pay_lifetime");
  });

  it("matches an untagged payment only through the workspace's own customer", () => {
    const untagged = payment({ metadata: {} });
    expect(findWorkspaceLifetimePayment([untagged], { workspaceId, lifetimeProductId })).toBeUndefined();
    expect(findWorkspaceLifetimePayment([untagged], { workspaceId, lifetimeProductId, dodoCustomerId: "cus_owner" })?.payment_id).toBe("pay_lifetime");
  });
});
