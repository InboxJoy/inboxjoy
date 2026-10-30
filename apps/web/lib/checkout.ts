import { ApiError, apiFetch } from "@/lib/api";
import { PLAN_HINT_KEY, writeBillingStorage } from "@/lib/billing";
import { isPlanKey, type PlanKey } from "@/lib/plans";

export type CheckoutPlan = PlanKey;

// Monthly and Yearly no longer exist, but old links (emails, partner links,
// bookmarks) still carry the intent to pay, so they hint the lifetime license.
const LEGACY_PLAN_KEYS = new Set(["monthly", "yearly"]);

export function checkoutPlanFromSearch(search: string): CheckoutPlan | null {
  const plan = new URLSearchParams(search).get("plan");
  if (plan && LEGACY_PLAN_KEYS.has(plan)) return "lifetime";
  return isPlanKey(plan) ? plan : null;
}

// Where signup and login send people. Every account lands in the product; a
// ?plan= hint from a marketing CTA rides along so the plan picker can pre-select
// it. Checkout only ever starts from the in-app plan picker.
export function postAuthDestination(search: string, { useNext }: { useNext: boolean }): string {
  const next = new URLSearchParams(search).get("next");
  if (useNext && (next === "/app" || next?.startsWith("/app?") || (next?.startsWith("/app/") && !next.startsWith("/app//")))) return next;
  const plan = checkoutPlanFromSearch(search);
  return plan ? `/app?plan=${plan}` : "/app";
}

// Also keep the hint for this tab, so it survives any redirect that drops the query.
export function rememberPlanHint(search: string) {
  const plan = checkoutPlanFromSearch(search);
  if (!plan) return;
  writeBillingStorage(PLAN_HINT_KEY, plan);
}

export function isWorkspaceProvisioningError(reason: unknown) {
  return reason instanceof ApiError && reason.status === 403 && reason.message.includes("No active workspace membership found");
}

export function waitForWorkspaceProvisioning() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 1_500));
}

export async function startCheckout(plan: CheckoutPlan) {
  const { checkoutUrl } = await apiFetch<{ checkoutUrl: string }>("/v1/billing/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ productKey: plan }),
  }, "Checkout could not start.");
  return checkoutUrl;
}
