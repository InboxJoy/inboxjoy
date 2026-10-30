import { describe, expect, it } from "vitest";

import { BILLING_UNAVAILABLE_DETAIL, planBannerCopy, planPromptState, unpaidNudgeReason, type PlanPromptState, type WorkspaceBilling } from "../lib/billing";

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

const unlicensed = { tier: "none", status: "none", freePlan: false, monthlySendLimit: null, sendingEnabled: false, legacyFreeEndsAt: null } as const;

describe("banner copy per state", () => {
  it("asks a workspace without the licence to get it, with the price and the guarantee", () => {
    const copy = planBannerCopy("license-needed", billing(unlicensed));
    expect(copy.title).toBe("Get your lifetime license to start sending");
    expect(copy.detail).toContain("Setup is free");
    expect(copy.detail).toContain("$79 once");
    expect(copy.detail).toContain("30-day money-back guarantee");
    expect(copy.cta).toBe("Get license");
  });

  it("shows when the free plan ends for a grandfathered workspace", () => {
    expect(planBannerCopy("legacy-free", billing()).title).toBe("Free plan ends Nov 28");
    expect(planBannerCopy("legacy-free", billing({ legacyFreeEndsAt: null })).title).toBe("The free plan is ending");
    expect(planBannerCopy("legacy-free", billing()).detail).toContain("sending needs the lifetime license");
  });

  it("keeps the usage meter wording and adds the end date near the cap", () => {
    const copy = planBannerCopy("nearing-limit", billing({ sendsThisMonth: 8_250 }));
    expect(copy.title).toBe("8,250 of 10,000 free sends used this month");
    expect(copy.detail).toBe("The free plan ends Nov 28. The lifetime license has no limits and no InboxJoy footer.");
  });

  it("promises a reset only when the free plan lives to see it", () => {
    const cap = { sendingEnabled: false, sendsThisMonth: 10_000 } as const;
    const resumes = planBannerCopy("pick", billing(cap));
    expect(resumes.title).toBe("You've used this month's 10,000 free sends");
    expect(resumes.detail).toBe("Sending resumes Nov 1, and the free plan ends Nov 28. Get the lifetime license to keep sending now.");
    const ends = planBannerCopy("pick", billing({ ...cap, legacyFreeEndsAt: "2026-10-30T00:00:00.000Z" }));
    expect(ends.detail).toBe("The free plan ends Oct 30. Get the lifetime license to keep sending.");
    expect(ends.detail).not.toContain("resumes");
  });

  it("keeps the confirming and fix-payment states, without free-plan talk for workspaces never on it", () => {
    expect(planBannerCopy("confirming", billing()).title).toBe("Confirming your payment");
    const owner = planBannerCopy("fix-payment", billing({ ...unlicensed, status: "on_hold", hasCustomer: true }));
    expect(owner).toMatchObject({ title: "Update your payment method", cta: "Update payment" });
    expect(owner.detail).not.toMatch(/free plan/i);
    const member = planBannerCopy("fix-payment", billing({ ...unlicensed, status: "on_hold", canManage: false }));
    expect(member.title).toBe("Your paid plan is on hold");
    expect(member.detail).not.toMatch(/free plan/i);
    expect(planBannerCopy("fix-payment", billing({ status: "on_hold" })).detail).toContain("free plan");
  });

  it("on a server without billing, keeps the news but offers no checkout and says how access is granted", () => {
    const unconfigured = { configured: false } as const;
    const none = planBannerCopy("no-checkout", billing({ ...unlicensed, ...unconfigured }));
    expect(none).toEqual({ title: "Campaign sending needs a license", detail: BILLING_UNAVAILABLE_DETAIL });
    expect(BILLING_UNAVAILABLE_DETAIL).toBe("Billing isn't set up on this server. An admin can grant access with billing-admin comp.");
    // A legacy Free workspace keeps its countdown, meter or cap as the title.
    expect(planBannerCopy("no-checkout", billing(unconfigured))).toEqual({ title: "Free plan ends Nov 28", detail: BILLING_UNAVAILABLE_DETAIL });
    expect(planBannerCopy("no-checkout", billing({ ...unconfigured, sendsThisMonth: 8_250 })).title).toBe("8,250 of 10,000 free sends used this month");
    expect(planBannerCopy("no-checkout", billing({ ...unconfigured, sendsThisMonth: 10_000, sendingEnabled: false })).title).toBe("You've used this month's 10,000 free sends");
    for (const value of [billing({ ...unlicensed, ...unconfigured }), billing(unconfigured), null]) {
      const copy = planBannerCopy("no-checkout", value);
      expect(copy.cta).toBeUndefined();
      expect(`${copy.title} ${copy.detail}`).not.toMatch(/\$\d|get license|money-back/i);
    }
  });

  it("never offers the retired plan names or an 'Upgrade' button", () => {
    const states: Array<Exclude<PlanPromptState, "hidden">> = ["license-needed", "legacy-free", "nearing-limit", "pick", "no-checkout", "confirming", "fix-payment"];
    for (const state of states) {
      const copy = planBannerCopy(state, billing());
      expect(`${copy.title} ${copy.detail} ${copy.cta ?? ""}`, state).not.toMatch(/upgrade|monthly plan|yearly|see plans|pick a plan/i);
    }
  });
});

describe("plan picker nudge after a launch or enrollment", () => {
  it("opens for a workspace without the licence, telling them sending starts once they buy", () => {
    const state = planPromptState(billing(unlicensed), false);
    expect(unpaidNudgeReason(state, "campaign", billing(unlicensed))).toBe("Your campaign is live and queued. Sending starts as soon as you get the lifetime license.");
    expect(unpaidNudgeReason(state, "leads", billing(unlicensed))).toBe("Your leads are enrolled and queued. Sending starts as soon as you get the lifetime license.");
  });

  it("opens for a legacy Free workspace at its cap, with the reset it can expect", () => {
    const capped = billing({ sendingEnabled: false, sendsThisMonth: 10_000 });
    expect(unpaidNudgeReason(planPromptState(capped, false), "leads", capped)).toBe("Your leads are enrolled and queued. This month's free sends are used up, so sending resumes after the monthly reset. Get the lifetime license to send now.");
    const endsFirst = billing({ sendingEnabled: false, sendsThisMonth: 10_000, legacyFreeEndsAt: "2026-10-30T00:00:00.000Z" });
    expect(unpaidNudgeReason(planPromptState(endsFirst, false), "campaign", endsFirst)).toContain("the free plan ends before they reset");
  });

  it("stays quiet for anyone who can send, or who can't start a checkout", () => {
    const states: Array<[PlanPromptState, WorkspaceBilling]> = [
      ["hidden", billing({ needsLicense: false, tier: "lifetime", freePlan: false })],
      ["legacy-free", billing()],
      ["nearing-limit", billing({ sendsThisMonth: 9_000 })],
      ["confirming", billing()],
      ["fix-payment", billing({ status: "on_hold" })],
      // No checkout on this server: the picker could only fail.
      ["no-checkout", billing({ ...unlicensed, configured: false })],
      ["no-checkout", billing({ configured: false, sendsThisMonth: 10_000, sendingEnabled: false })],
    ];
    for (const [state, value] of states) expect(unpaidNudgeReason(state, "campaign", value), state).toBeNull();
    expect(unpaidNudgeReason("hidden", "campaign", null)).toBeNull();
  });
});
