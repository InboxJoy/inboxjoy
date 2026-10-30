import type { Edition } from "@/lib/edition";
import { planOffers, type PlanKey } from "@/lib/plans";
import { getWorkspaceId } from "@/lib/workspaces";
import { pendingBillingStorageKey, workspaceBillingStorageKey, type BillingStorageKey } from "@/lib/billing-storage";

export { CONFIRMING_PAYMENT_KEY, PLAN_HINT_KEY } from "@/lib/billing-storage";

// Mirrors the billing.get operation output (packages/core). Tiers: "lifetime"
// and "comp" (founder-granted) are entitled; "free" is a grandfathered legacy
// Free workspace until legacyFreeEndsAt; "none" is a cloud workspace that needs
// the licence to send; "selfhost" is every workspace of the open-source edition.
export type WorkspaceBilling = {
  edition: Edition;
  tier: "none" | "free" | "comp" | "selfhost" | PlanKey;
  status: string;
  nextBillingDate: string | null;
  trialEnd: string | null;
  cancelAtPeriodEnd: boolean;
  configured: boolean;
  hasCustomer: boolean;
  sendingEnabled: boolean;
  canManage: boolean;
  // Cloud and tier "none" or "free": campaign sending needs the licence (free
  // keeps sending until legacyFreeEndsAt). Always false in self-host.
  needsLicense: boolean;
  legacyFreeEndsAt: string | null;
  // Legacy Free usage. freePlan means tier "free" only;
  // monthlySendLimit is null for every other tier.
  freePlan: boolean;
  monthlySendLimit: number | null;
  sendsThisMonth: number;
  monthlyResetsAt: string;
};

// "license-needed": cloud workspace without the licence (tier none).
// "legacy-free" / "nearing-limit" / "pick": a grandfathered Free workspace: its
// plain countdown, near its monthly cap, and at it.
// "no-checkout": any of those on a cloud server without billing set up (the dev
// stack, or Dodo keys missing): the same news with no checkout to open.
export type PlanPromptState = "hidden" | "license-needed" | "legacy-free" | "nearing-limit" | "pick" | "no-checkout" | "confirming" | "fix-payment";

// Where a workspace that needs the licence stands, before any checkout state.
type LicenseSituation = "license-needed" | "legacy-free" | "nearing-limit" | "pick";

export const BILLING_UNAVAILABLE_DETAIL = "Billing isn't set up on this server. An admin can grant access with billing-admin comp.";

// Legacy Free workspaces get a usage warning once they've used this share of the month's sends.
export const FREE_PLAN_NUDGE_RATIO = 0.8;

// Mirrors billing.checkoutStart: these statuses already have a Dodo subscription,
// so a new checkout is refused and the fix lives in the Dodo billing portal.
const EXISTING_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "on_hold", "paused"]);

export const CONFIRMING_PAYMENT_WINDOW_MS = 10 * 60_000;

export function billingStorageKey(key: BillingStorageKey): string {
  const workspaceId = getWorkspaceId();
  return workspaceId ? workspaceBillingStorageKey(key, workspaceId) : pendingBillingStorageKey(key);
}

export function readBillingStorage(key: BillingStorageKey): string | null {
  const scopedKey = billingStorageKey(key);
  try { return window.sessionStorage.getItem(scopedKey); } catch { return null; }
}

export function writeBillingStorage(key: BillingStorageKey, value: string | null): void {
  const scopedKey = billingStorageKey(key);
  try {
    if (value === null) window.sessionStorage.removeItem(scopedKey);
    else window.sessionStorage.setItem(scopedKey, value);
  } catch {}
}

// The billing banner. Everything is computed server-side by the same rules
// canSend() enforces and arrives as `needsLicense`; the web app never re-derives
// entitlement from tier or status. Lifetime and comp workspaces never see the
// banner, and neither does anyone on self-host (no billing exists there).
// A cloud workspace without the licence always sees it: setup works, sending
// needs the licence. A grandfathered Free workspace sees a countdown to the end
// of the free plan, a usage warning near its monthly cap, and "pick" once the
// cap is reached (sendingEnabled false). On a cloud server without billing set
// up the worker still parks their campaign email, so they see the same news as
// "no-checkout": no checkout, portal or payment to wait for, and the way an
// admin grants access instead. Right after a Dodo return the webhook may still
// be in flight: show a confirming state so nobody starts a second checkout. A
// lapsed existing subscription (e.g. on_hold past its grace) can't start a new
// checkout, so it points at the billing portal.
export function planPromptState(billing: WorkspaceBilling | null, confirmingPayment: boolean): PlanPromptState {
  if (!billing || billing.edition !== "cloud" || !billing.needsLicense) return "hidden";
  if (!billing.configured) return "no-checkout";
  if (confirmingPayment) return "confirming";
  if (EXISTING_SUBSCRIPTION_STATUSES.has(billing.status)) return "fix-payment";
  return licenseSituation(billing);
}

function licenseSituation(billing: WorkspaceBilling): LicenseSituation {
  if (!billing.freePlan) return "license-needed";
  if (!billing.sendingEnabled) return "pick";
  if (freePlanNearingLimit(billing)) return "nearing-limit";
  return "legacy-free";
}

export function freePlanNearingLimit(billing: Pick<WorkspaceBilling, "freePlan" | "monthlySendLimit" | "sendsThisMonth">): boolean {
  return billing.freePlan && billing.monthlySendLimit !== null && billing.sendsThisMonth >= billing.monthlySendLimit * FREE_PLAN_NUDGE_RATIO;
}

export function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function formatResetDate(monthlyResetsAt: string): string {
  return formatShortDate(monthlyResetsAt);
}

function lifetimePrice(): string {
  const offer = planOffers.find((candidate) => candidate.key === "lifetime");
  return offer ? `$${offer.price}` : "the lifetime price";
}

// A legacy Free workspace whose monthly cap resets before its free plan ends
// will send again after the reset; otherwise hitting the cap is the end of sending.
function monthlyResetBeforeFreeEnds(billing: Pick<WorkspaceBilling, "monthlyResetsAt" | "legacyFreeEndsAt">): boolean {
  if (!billing.legacyFreeEndsAt) return true;
  return new Date(billing.monthlyResetsAt).getTime() < new Date(billing.legacyFreeEndsAt).getTime();
}

export type PlanBannerCopy = { title: string; detail: string; cta?: string };

// Copy for every visible banner state, as data, so the wording rules (never
// promise a reset the free plan won't live to see; no free-plan talk for a
// workspace that was never on it; no checkout where none exists) are tested
// rather than buried in JSX.
export function planBannerCopy(state: Exclude<PlanPromptState, "hidden">, billing: WorkspaceBilling | null, canManage: boolean = billing?.canManage ?? true): PlanBannerCopy {
  const price = lifetimePrice();
  const freeEnds = billing?.legacyFreeEndsAt ? formatShortDate(billing.legacyFreeEndsAt) : null;
  const limit = (billing?.monthlySendLimit ?? 0).toLocaleString("en-US");
  switch (state) {
    case "no-checkout": {
      // The free plan's countdown, meter or cap as usual; a workspace that was
      // never on it just hears that sending needs the licence.
      const situation = billing ? licenseSituation(billing) : "license-needed";
      const title = situation === "license-needed" ? "Campaign sending needs a license" : planBannerCopy(situation, billing).title;
      return { title, detail: BILLING_UNAVAILABLE_DETAIL };
    }
    case "confirming":
      return { title: "Confirming your payment", detail: "Sending unlocks as soon as it clears." };
    case "fix-payment": {
      const until = billing?.freePlan ? "you're on the free plan" : "campaign sending is paused";
      return canManage
        ? { title: "Update your payment method", detail: `${billing?.freePlan ? "You're on the free plan" : "Campaign sending is paused"} until the next payment goes through.`, cta: "Update payment" }
        : { title: "Your paid plan is on hold", detail: `Your workspace owner can update the payment method. Until then ${until}.` };
    }
    case "license-needed":
      return { title: "Get your lifetime license to start sending", detail: `Setup is free. Sending starts once you have the license: ${price} once, with a 30-day money-back guarantee.`, cta: "Get license" };
    case "legacy-free":
      return {
        title: freeEnds ? `Free plan ends ${freeEnds}` : "The free plan is ending",
        detail: `After that, sending needs the lifetime license: ${price} once, no subscription.`,
        cta: "Get license",
      };
    case "nearing-limit":
      return {
        title: `${(billing?.sendsThisMonth ?? 0).toLocaleString("en-US")} of ${limit} free sends used this month`,
        detail: `${freeEnds ? `The free plan ends ${freeEnds}. ` : ""}The lifetime license has no limits and no InboxJoy footer.`,
        cta: "Get license",
      };
    case "pick": {
      const resumes = billing ? monthlyResetBeforeFreeEnds(billing) : true;
      return {
        title: `You've used this month's ${limit} free sends`,
        detail: resumes
          ? `Sending resumes ${billing ? formatShortDate(billing.monthlyResetsAt) : "next month"}${freeEnds ? `, and the free plan ends ${freeEnds}` : ""}. Get the lifetime license to keep sending now.`
          : `${freeEnds ? `The free plan ends ${freeEnds}. ` : ""}Get the lifetime license to keep sending.`,
        cta: "Get license",
      };
    }
  }
}

export type UnpaidNudgeKind = "leads" | "campaign";

// The plan picker opens on its own after a launch or an enrollment only when
// the workspace can't send right now: no licence, or a legacy Free workspace at
// its cap. One that is sending, or merely nearing the cap, is left alone, and so
// is one on a server without billing ("no-checkout"): the picker could only
// fail at checkout, and the banner already says what to do.
export function unpaidNudgeReason(state: PlanPromptState, kind: UnpaidNudgeKind, billing: WorkspaceBilling | null): string | null {
  const queued = kind === "campaign" ? "Your campaign is live and queued." : "Your leads are enrolled and queued.";
  if (state === "license-needed") return `${queued} Sending starts as soon as you get the lifetime license.`;
  if (state !== "pick") return null;
  return billing && !monthlyResetBeforeFreeEnds(billing)
    ? `${queued} This month's free sends are used up and the free plan ends before they reset. Get the lifetime license to send.`
    : `${queued} This month's free sends are used up, so sending resumes after the monthly reset. Get the lifetime license to send now.`;
}

export function confirmingPaymentActive(returnedAt: string | null, now = Date.now()): boolean {
  const timestamp = Number(returnedAt);
  return Number.isFinite(timestamp) && timestamp > 0 && now - timestamp < CONFIRMING_PAYMENT_WINDOW_MS;
}
