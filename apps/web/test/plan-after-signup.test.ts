import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CONFIRMING_PAYMENT_WINDOW_MS, confirmingPaymentActive, planPromptState, type WorkspaceBilling } from "../lib/billing";
import { postAuthDestination } from "../lib/checkout";

const webRoot = fileURLToPath(new URL("..", import.meta.url));

function source(path: string) {
  return readFileSync(join(webRoot, path), "utf8");
}

function sourceFiles(dir: string): string[] {
  return readdirSync(join(webRoot, dir)).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(join(webRoot, path)).isDirectory()) return sourceFiles(path);
    return /\.(tsx?|css)$/.test(name) ? [path] : [];
  });
}

// A grandfathered cloud workspace on the legacy Free plan.
function billing(overrides: Partial<WorkspaceBilling> = {}): WorkspaceBilling {
  return {
    edition: "cloud",
    tier: "free",
    status: "free",
    nextBillingDate: null,
    trialEnd: null,
    cancelAtPeriodEnd: false,
    configured: true,
    hasCustomer: false,
    sendingEnabled: true,
    canManage: true,
    needsLicense: true,
    legacyFreeEndsAt: "2026-11-28T00:00:00.000Z",
    freePlan: true,
    monthlySendLimit: 10_000,
    sendsThisMonth: 0,
    monthlyResetsAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

// A cloud workspace without the licence: setup works, campaign sending doesn't.
const unlicensed = { tier: "none", status: "none", freePlan: false, monthlySendLimit: null, sendingEnabled: false, legacyFreeEndsAt: null } as const;
// Lifetime and comp: entitled, no cap.
const entitled = { needsLicense: false, freePlan: false, monthlySendLimit: null, legacyFreeEndsAt: null } as const;
// Every workspace of the open-source edition.
const selfHost = { edition: "selfhost", tier: "selfhost", status: "active", configured: false, needsLicense: false, freePlan: false, monthlySendLimit: null, legacyFreeEndsAt: null } as const;

describe("signup and login land in the product", () => {
  it("sends every new signup to /app and carries the plan hint", () => {
    expect(postAuthDestination("", { useNext: false })).toBe("/app");
    expect(postAuthDestination("?plan=lifetime", { useNext: false })).toBe("/app?plan=lifetime");
    // Old Monthly/Yearly links still carry the intent to pay.
    expect(postAuthDestination("?plan=monthly", { useNext: false })).toBe("/app?plan=lifetime");
    expect(postAuthDestination("?plan=yearly", { useNext: false })).toBe("/app?plan=lifetime");
    expect(postAuthDestination("?plan=enterprise", { useNext: false })).toBe("/app");
  });

  it("keeps a safe next destination on login and ignores unsafe ones", () => {
    expect(postAuthDestination("?next=%2Fapp%2Fleads&plan=monthly", { useNext: true })).toBe("/app/leads");
    expect(postAuthDestination("?next=https%3A%2F%2Fevil.example&plan=lifetime", { useNext: true })).toBe("/app?plan=lifetime");
    expect(postAuthDestination("?next=%2Fapp%2Fleads", { useNext: false })).toBe("/app");
    expect(postAuthDestination("?next=%2Fapp%3Fplan%3Dlifetime", { useNext: true })).toBe("/app?plan=lifetime");
    expect(postAuthDestination("?next=%2Fapp%2Finvite%2Ftoken-123", { useNext: true })).toBe("/app/invite/token-123");
  });

  it("never starts checkout from the auth pages", () => {
    for (const page of ["app/app/signup/signup-form.tsx", "app/app/login/page.tsx"]) {
      const code = source(page);
      expect(code, page).not.toMatch(/billing\/checkout|startCheckout|createCheckout|checkoutUrl|checkout_started|location\.assign/);
      expect(code, page).toContain("postAuthDestination");
    }
    expect(source("app/app/signup/signup-form.tsx")).toContain('track("signup_completed")');
  });

  it("starts checkout only from the in-app plan picker", () => {
    const callers = [...sourceFiles("app"), ...sourceFiles("components"), ...sourceFiles("lib")]
      .filter((path) => /startCheckout\(|"\/v1\/billing\/checkout"|track\("checkout_started"/.test(source(path)))
      .map((path) => relative(".", path));
    expect(callers.sort()).toEqual(["components/plan-picker.tsx", "lib/checkout.ts"]);
  });

  it("confirms a missing session before AuthGate bounces to login", () => {
    // Right after sign-up useSession briefly reports no session; bouncing then
    // flashed /app/login and dropped the ?plan= hint.
    const gate = source("components/auth-gate.tsx");
    // The login redirect only runs from inside the server session check.
    expect(gate).toMatch(/authClient\.getSession\(\)\.then\([\s\S]*else toLogin\(\)/);
    expect(gate.match(/toLogin\(\)|router\.replace\(/g)?.length).toBe(2);
    expect(gate).toContain("pathname + window.location.search");
    expect(source("app/app/login/page.tsx")).toContain("startPostLogin(true)");
    expect(source("app/app/signup/signup-form.tsx")).toContain("postAuthDestination(window.location.search, { useNext: true })");
    for (const page of ["app/app/signup/signup-form.tsx", "app/app/login/page.tsx"]) expect(source(page), page).toContain("rememberPlanHint(");
  });

  it("keeps the old payment prompt deleted", () => {
    const stale = [...sourceFiles("app"), ...sourceFiles("components"), ...sourceFiles("lib")]
      .filter((path) => /payment-completion-banner|createCheckoutWithProvisioningRetry|Complete payment/.test(source(path)));
    expect(stale).toEqual([]);
  });
});

describe("billing banner visibility", () => {
  it("always asks a cloud workspace without the licence to get it", () => {
    expect(planPromptState(billing(unlicensed), false)).toBe("license-needed");
    // History doesn't matter: a lapsed or refunded customer needs the licence too.
    expect(planPromptState(billing({ ...unlicensed, status: "cancelled", hasCustomer: true }), false)).toBe("license-needed");
    expect(planPromptState(billing({ ...unlicensed, status: "refunded", hasCustomer: true }), false)).toBe("license-needed");
  });

  it("counts a grandfathered Free workspace down to the end of the free plan", () => {
    expect(planPromptState(billing(), false)).toBe("legacy-free");
    expect(planPromptState(billing({ sendsThisMonth: 7_999 }), false)).toBe("legacy-free");
    expect(planPromptState(billing({ status: "cancelled", hasCustomer: true }), false)).toBe("legacy-free");
  });

  it("keeps the usage warning at 80% of the free monthly limit and asks for the licence once it's used up", () => {
    expect(planPromptState(billing({ sendsThisMonth: 8_000 }), false)).toBe("nearing-limit");
    expect(planPromptState(billing({ sendsThisMonth: 10_000, sendingEnabled: false }), false)).toBe("pick");
    expect(planPromptState(billing({ status: "expired", hasCustomer: true, sendsThisMonth: 10_000, sendingEnabled: false }), false)).toBe("pick");
  });

  it("sends lapsed existing subscriptions to the billing portal, where checkout would be refused", () => {
    expect(planPromptState(billing({ status: "on_hold", hasCustomer: true }), false)).toBe("fix-payment");
    expect(planPromptState(billing({ status: "paused", hasCustomer: true }), false)).toBe("fix-payment");
    expect(planPromptState(billing({ status: "trialing", hasCustomer: true }), false)).toBe("fix-payment");
    expect(planPromptState(billing({ ...unlicensed, status: "on_hold", hasCustomer: true }), false)).toBe("fix-payment");
  });

  it("hides for entitled workspaces, even mid-confirmation", () => {
    // Trialing reports tier "free" but has a paid entitlement, matching canSend().
    expect(planPromptState(billing({ ...entitled, status: "trialing" }), false)).toBe("hidden");
    expect(planPromptState(billing({ ...entitled, tier: "lifetime", status: "active" }), false)).toBe("hidden");
    expect(planPromptState(billing({ ...entitled, tier: "free", status: "on_hold" }), false)).toBe("hidden");
    // Comp grant: an active row without a lifetime license reports tier "comp".
    expect(planPromptState(billing({ ...entitled, tier: "comp", status: "active" }), true)).toBe("hidden");
  });

  it("never shows on self-host", () => {
    expect(planPromptState(billing(selfHost), false)).toBe("hidden");
    expect(planPromptState(billing(selfHost), true)).toBe("hidden");
    // Even a stale or contradictory payload can't surface billing in the open-source edition.
    expect(planPromptState(billing({ ...selfHost, needsLicense: true, configured: true }), false)).toBe("hidden");
    expect(planPromptState(billing({ ...unlicensed, edition: "selfhost" }), false)).toBe("hidden");
  });

  // The dev stack runs cloud without Dodo keys: the worker still parks campaign
  // email as payment_required there, so the banner must say why, minus checkout.
  it("still explains a missing licence on a cloud server without billing, with no checkout state", () => {
    expect(planPromptState(billing({ ...unlicensed, configured: false }), false)).toBe("no-checkout");
    expect(planPromptState(billing({ configured: false }), false)).toBe("no-checkout");
    expect(planPromptState(billing({ configured: false, sendsThisMonth: 10_000, sendingEnabled: false }), false)).toBe("no-checkout");
    // Nothing to confirm or fix in a billing portal that doesn't exist.
    expect(planPromptState(billing({ ...unlicensed, configured: false }), true)).toBe("no-checkout");
    expect(planPromptState(billing({ ...unlicensed, configured: false, status: "on_hold", hasCustomer: true }), false)).toBe("no-checkout");
    // A comp granted with billing-admin hides it, like anywhere else.
    expect(planPromptState(billing({ ...entitled, configured: false, tier: "comp", status: "active" }), false)).toBe("hidden");
  });

  it("hides while billing is still loading", () => {
    expect(planPromptState(null, false)).toBe("hidden");
    expect(planPromptState(null, true)).toBe("hidden");
  });

  it("shows a confirming state after a Dodo return instead of a second checkout", () => {
    expect(planPromptState(billing(), true)).toBe("confirming");
    expect(planPromptState(billing(unlicensed), true)).toBe("confirming");
    const now = 1_000_000_000_000;
    expect(confirmingPaymentActive(String(now - 1_000), now)).toBe(true);
    expect(confirmingPaymentActive(String(now - CONFIRMING_PAYMENT_WINDOW_MS - 1), now)).toBe(false);
    expect(confirmingPaymentActive(null, now)).toBe(false);
    expect(confirmingPaymentActive("garbage", now)).toBe(false);
  });

  it("confirms a payment on needsLicense, not freePlan (tier none has freePlan false until it pays)", () => {
    // Waiting on freePlan === false would finish "confirming" immediately for a
    // workspace without the licence. Every poll and refresh uses needsLicense.
    for (const path of ["components/plan-picker.tsx", "app/app/(product)/page.tsx"]) {
      expect(source(path), path).toContain("needsLicense");
      expect(source(path), path).not.toMatch(/\.freePlan\b/);
    }
  });
});
