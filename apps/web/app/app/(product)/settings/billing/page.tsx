"use client";

import { useEffect, useState } from "react";
import { Button, Card, labelStatus, StatusBadge } from "@inboxjoy/ui";
import { usePlanPicker } from "@/components/plan-picker";
import { apiErrorMessage, apiFetch } from "@/lib/api";
import { formatResetDate, formatShortDate, type PlanPromptState, type WorkspaceBilling as Billing } from "@/lib/billing";
import { planOffers } from "@/lib/plans";
type BillingActionResponse = { url?: string };

// States where the owner can start a checkout from here. "confirming" waits for
// the payment to land and "fix-payment" goes through the billing portal.
const CHECKOUT_STATES: readonly PlanPromptState[] = ["license-needed", "legacy-free", "nearing-limit", "pick"];

// Cloud only: self-host has no billing, and settings/billing/layout.tsx sends it
// back to Settings.
export default function BillingSettingsPage() {
  const [billing, setBilling] = useState<Billing | null>(null);
  const { openPlans, promptState } = usePlanPicker();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { void apiFetch<Billing>("/v1/billing", {}, "Could not load billing.").then(setBilling).catch((value) => setError(apiErrorMessage(value, "Could not load billing."))); }, []);

  async function billingAction(path: string, body?: Record<string, unknown>) {
    setBusy(true); setError("");
    try { return await apiFetch<BillingActionResponse>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }, "Billing action failed."); }
    catch (value) { setError(apiErrorMessage(value, "Billing action failed.")); return null; } finally { setBusy(false); }
  }

  async function openPortal() {
    const data = await billingAction("/v1/billing/portal");
    if (data?.url) window.location.assign(data.url);
  }

  const lifetime = billing?.tier === "lifetime";
  const comp = billing?.tier === "comp";
  const legacyFree = billing?.tier === "free";
  const freeEnds = billing?.legacyFreeEndsAt ? formatShortDate(billing.legacyFreeEndsAt) : null;
  const title = !billing ? "Loading billing…" : lifetime ? "Lifetime license" : comp ? "Complimentary access" : legacyFree ? "Free plan" : "No license yet";
  const detail = !billing ? ""
    : lifetime ? "Paid once. No renewals, nothing to cancel."
    : comp ? billing.nextBillingDate ? `Ends ${new Date(billing.nextBillingDate).toLocaleDateString()}.` : "Granted by InboxJoy."
    : legacyFree ? `${freeEnds ? `Ends ${freeEnds}. ` : ""}After that, sending needs the lifetime license.`
    : "Setup is free. Get the lifetime license to start sending.";
  const badge = !billing ? null
    : billing.status === "on_hold" ? { tone: "warning" as const, label: labelStatus(billing.status) }
    : lifetime || comp ? { tone: "good" as const, label: labelStatus(billing.status) }
    : legacyFree ? { tone: "warning" as const, label: freeEnds ? `Ends ${freeEnds}` : "Ending" }
    : { tone: "warning" as const, label: "License needed" };
  const lifetimeOffer = planOffers.find((offer) => offer.key === "lifetime");
  const freeUsage = billing?.freePlan && billing.monthlySendLimit !== null ? { used: billing.sendsThisMonth, limit: billing.monthlySendLimit } : null;
  const canUpgrade = CHECKOUT_STATES.includes(promptState);
  const checkoutUnavailable = Boolean(billing?.needsLicense && !billing.configured);

  return <div className="settings-section-stack">
    {error ? <Card className="page-message page-message--error"><p role="alert">{error}</p></Card> : null}
    <Card className="settings-card settings-card--billing">
      <span className="polish-mono-label">Plan</span>
      <div className="settings-card-heading"><div><h2>{title}</h2><p>{detail}</p></div>{badge ? <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge> : null}</div>
      {freeUsage && billing ? <div className="billing-usage">
        <div className="billing-usage__line"><span><strong>{freeUsage.used.toLocaleString("en-US")}</strong> of {freeUsage.limit.toLocaleString("en-US")} sends used this month</span><span>Resets {formatResetDate(billing.monthlyResetsAt)}</span></div>
        <span aria-label={`${freeUsage.used} of ${freeUsage.limit} free sends used`} aria-valuemax={freeUsage.limit} aria-valuemin={0} aria-valuenow={Math.min(freeUsage.used, freeUsage.limit)} className="enrollment-meter" role="progressbar"><span style={{ width: `${Math.min(100, Math.round((freeUsage.used / Math.max(1, freeUsage.limit)) * 100))}%` }} /></span>
        <p>Free-plan emails end with a small "Sent via InboxJoy" link. The license removes it and the monthly limit.</p>
      </div> : null}
      {checkoutUnavailable ? <p>Checkout isn't set up on this deployment.</p> : null}
      <div className="settings-actions">
        {/* Same plan picker the billing banner opens, so the two can't drift. */}
        {canUpgrade ? <Button disabled={busy} onClick={() => openPlans({ plan: "lifetime" })}>Get lifetime license{lifetimeOffer ? ` · $${lifetimeOffer.price}` : ""}</Button> : null}
        {billing?.hasCustomer ? <Button variant="secondary" disabled={busy} onClick={() => void openPortal()}>Billing history</Button> : null}
      </div>
    </Card>
  </div>;
}
