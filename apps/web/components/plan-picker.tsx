"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, cx } from "@inboxjoy/ui";
import { AppDialog } from "@/components/app-dialog";
import { useEditionFeatures } from "@/components/edition-provider";
import { Toast } from "@/components/toast";
import { ApiError, apiErrorMessage, apiFetch } from "@/lib/api";
import { track } from "@/lib/analytics";
import {
  CONFIRMING_PAYMENT_KEY,
  PLAN_HINT_KEY,
  confirmingPaymentActive,
  planBannerCopy,
  planPromptState,
  readBillingStorage,
  unpaidNudgeReason,
  writeBillingStorage,
  type PlanPromptState,
  type UnpaidNudgeKind,
  type WorkspaceBilling,
} from "@/lib/billing";
import { checkoutPlanFromSearch, isWorkspaceProvisioningError, startCheckout, waitForWorkspaceProvisioning } from "@/lib/checkout";
import { isPlanKey, planOffers, type PlanKey } from "@/lib/plans";

type OpenPlansOptions = { plan?: PlanKey; reason?: string };

type PlanPickerContextValue = {
  billing: WorkspaceBilling | null;
  planHint: PlanKey | null;
  promptState: PlanPromptState;
  openPlans: (options?: OpenPlansOptions) => void;
  // Opens the picker only when the workspace can't send right now: no licence,
  // or a legacy Free workspace that has used up this month's sends.
  nudgeIfUnpaid: (kind: UnpaidNudgeKind) => void;
  refreshBilling: () => Promise<void>;
  openBillingPortal: () => Promise<void>;
  applyBilling: (next: Partial<WorkspaceBilling>) => void;
  beginConfirmingPayment: () => void;
};

const PlanPickerContext = createContext<PlanPickerContextValue | null>(null);

function stripSearchParams(...names: string[]) {
  const url = new URL(window.location.href);
  if (!names.some((name) => url.searchParams.has(name))) return;
  names.forEach((name) => url.searchParams.delete(name));
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

export function usePlanPicker() {
  const value = useContext(PlanPickerContext);
  if (!value) throw new Error("usePlanPicker must be used inside BillingProvider.");
  return value;
}

export function BillingProvider({ children }: { children: ReactNode }) {
  // Self-host has no billing at all: nothing to load, no banner, no checkout.
  const billingEnabled = useEditionFeatures().billing;
  const [billing, setBilling] = useState<WorkspaceBilling | null>(null);
  const [confirmingPayment, setConfirmingPayment] = useState(false);
  const [dialog, setDialog] = useState<OpenPlansOptions | null>(null);
  const [planHint, setPlanHint] = useState<PlanKey | null>(null);
  const [notice, setNotice] = useState("");
  const billingRequestId = useRef(0);
  const reconcileAttempted = useRef(false);
  const confirmingReturnedAt = useRef<string | null>(null);

  const loadBilling = useCallback(async () => {
    if (!billingEnabled) return;
    const requestId = ++billingRequestId.current;
    const request = () => apiFetch<WorkspaceBilling>("/v1/billing");
    try {
      let nextBilling: WorkspaceBilling;
      try {
        nextBilling = await request();
      } catch (reason) {
        // A brand-new signup can reach the product before its workspace exists.
        if (!isWorkspaceProvisioningError(reason)) throw reason;
        await waitForWorkspaceProvisioning();
        nextBilling = await request();
      }
      if (requestId === billingRequestId.current) setBilling(nextBilling);
    } catch {
      // Keep the last known billing state when a background refresh fails.
    }
  }, [billingEnabled]);

  const applyBilling = useCallback((next: Partial<WorkspaceBilling>) => {
    billingRequestId.current += 1;
    setBilling((current) => current ? { ...current, ...next } : null);
    if (next.needsLicense === false) void loadBilling();
  }, [loadBilling]);

  const beginConfirmingPayment = useCallback(() => {
    confirmingReturnedAt.current = String(Date.now());
    writeBillingStorage(CONFIRMING_PAYMENT_KEY, confirmingReturnedAt.current);
    setConfirmingPayment(true);
  }, []);

  useEffect(() => {
    if (!billingEnabled) return;
    const search = window.location.search;
    const hintedPlan = checkoutPlanFromSearch(search);
    if (hintedPlan) writeBillingStorage(PLAN_HINT_KEY, hintedPlan);
    const storedHint = hintedPlan ?? readBillingStorage(PLAN_HINT_KEY);
    setPlanHint(isPlanKey(storedHint) ? storedHint : null);

    if (new URLSearchParams(search).get("checkout") === "cancelled") {
      writeBillingStorage(CONFIRMING_PAYMENT_KEY, null);
      confirmingReturnedAt.current = null;
      setNotice("Checkout closed. Get your license whenever you're ready.");
    }
    const storedReturnedAt = readBillingStorage(CONFIRMING_PAYMENT_KEY);
    if (confirmingPaymentActive(storedReturnedAt)) {
      confirmingReturnedAt.current = storedReturnedAt;
      setConfirmingPayment(true);
    }
    stripSearchParams("plan", "checkout");
    void loadBilling();
  }, [billingEnabled, loadBilling]);

  useEffect(() => {
    if (!billingEnabled) return;
    const refresh = () => { void loadBilling(); };
    const handleVisibilityChange = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [billingEnabled, loadBilling]);

  // After a Dodo return the webhook may land late. While confirming, keep asking
  // (and reconcile once) until the plan shows up or the window expires.
  useEffect(() => {
    if (!confirmingPayment || !billing) return;
    if (!billing.needsLicense || !billing.configured) {
      writeBillingStorage(CONFIRMING_PAYMENT_KEY, null);
      confirmingReturnedAt.current = null;
      setConfirmingPayment(false);
      return;
    }
    if (!reconcileAttempted.current && billing.canManage) {
      reconcileAttempted.current = true;
      void apiFetch<WorkspaceBilling>("/v1/billing/reconcile", { method: "POST" }).then((next) => {
        billingRequestId.current += 1;
        setBilling(next);
      }).catch(() => undefined);
    }
    const timer = window.setTimeout(() => {
      if (confirmingPaymentActive(readBillingStorage(CONFIRMING_PAYMENT_KEY) ?? confirmingReturnedAt.current)) void loadBilling();
      else setConfirmingPayment(false);
    }, 5_000);
    return () => window.clearTimeout(timer);
  }, [billing, confirmingPayment, loadBilling]);

  const promptState = planPromptState(billing, confirmingPayment);

  const openPlans = useCallback((options: OpenPlansOptions = {}) => setDialog(options), []);
  const openBillingPortal = useCallback(async () => {
    try {
      const { url } = await apiFetch<{ url: string }>("/v1/billing/portal", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, "The billing portal could not open.");
      window.location.assign(url);
    } catch (reason) {
      setNotice(apiErrorMessage(reason, "The billing portal could not open."));
    }
  }, []);
  const nudgeIfUnpaid = useCallback((kind: UnpaidNudgeKind) => {
    const reason = unpaidNudgeReason(promptState, kind, billing);
    if (reason) setDialog({ reason });
  }, [billing, promptState]);

  const value = useMemo<PlanPickerContextValue>(() => ({
    billing,
    planHint,
    promptState,
    openPlans,
    nudgeIfUnpaid,
    refreshBilling: loadBilling,
    openBillingPortal,
    applyBilling,
    beginConfirmingPayment,
  }), [applyBilling, beginConfirmingPayment, billing, loadBilling, nudgeIfUnpaid, openBillingPortal, openPlans, planHint, promptState]);

  return <PlanPickerContext.Provider value={value}>
    {children}
    {dialog ? <PlanPickerDialog
      canManage={billing?.canManage ?? true}
      initialPlan={dialog.plan ?? planHint ?? "lifetime"}
      onClose={() => setDialog(null)}
      onPlanTaken={() => { setDialog(null); void loadBilling(); }}
      reason={dialog.reason}
    /> : null}
    {notice ? <Toast message={notice} onDismiss={() => setNotice("")} tone="info" /> : null}
  </PlanPickerContext.Provider>;
}

export function PlanBanner() {
  const { billing, openBillingPortal, openPlans, promptState } = usePlanPicker();
  const [openingPortal, setOpeningPortal] = useState(false);
  if (promptState === "hidden") return null;

  const copy = planBannerCopy(promptState, billing);

  // Nothing to click: no checkout on this server, or an on-hold plan only the
  // owner can fix.
  if (promptState === "no-checkout" || (promptState === "fix-payment" && !billing?.canManage)) {
    return <div aria-label="Billing" className="plan-banner-region" role="region">
      <div className="plan-banner plan-banner--static">
        <span className="plan-banner__copy"><strong>{copy.title}</strong><span>{copy.detail}</span></span>
      </div>
    </div>;
  }

  if (promptState === "fix-payment") {
    return <div aria-label="Billing" className="plan-banner-region" role="region">
      <button className="plan-banner" disabled={openingPortal} onClick={() => { setOpeningPortal(true); void openBillingPortal().finally(() => setOpeningPortal(false)); }} type="button">
        <span className="plan-banner__copy"><strong>{copy.title}</strong><span>{copy.detail}</span></span>
        <span aria-hidden="true" className="plan-banner__cta">{openingPortal ? "Opening…" : copy.cta}</span>
      </button>
    </div>;
  }

  if (promptState === "confirming") {
    return <div aria-label="Billing" className="plan-banner-region" role="region">
      <div className="plan-banner plan-banner--confirming" role="status">
        <span aria-hidden="true" className="plan-banner__spinner" />
        <span className="plan-banner__copy"><strong>{copy.title}</strong><span>{copy.detail}</span></span>
      </div>
    </div>;
  }

  return <div aria-label="Billing" className="plan-banner-region" role="region">
    <button aria-haspopup="dialog" className="plan-banner" onClick={() => openPlans()} type="button">
      <span className="plan-banner__copy"><strong>{copy.title}</strong><span>{copy.detail}</span></span>
      <span aria-hidden="true" className="plan-banner__cta">{copy.cta}</span>
    </button>
  </div>;
}

function PlanPickerDialog({ canManage, initialPlan, onClose, onPlanTaken, reason }: {
  canManage: boolean;
  initialPlan: PlanKey;
  onClose: () => void;
  onPlanTaken: () => void;
  reason?: string;
}) {
  const [plan, setPlan] = useState<PlanKey>(initialPlan);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const choose = async () => {
    setBusy(true);
    setError("");
    try {
      const checkoutUrl = await startCheckout(plan);
      track("checkout_started", { plan });
      window.location.assign(checkoutUrl);
    } catch (reason) {
      setBusy(false);
      if (reason instanceof ApiError && reason.status === 409) {
        onPlanTaken();
        return;
      }
      setError(reason instanceof ApiError && reason.status >= 500
        ? "Checkout could not start. Try again in a moment, or email hey@inboxjoy.online."
        : apiErrorMessage(reason, "Checkout could not start."));
    }
  };

  const actions = canManage
    ? <>
      <Button disabled={busy} onClick={() => void choose()}>{busy ? "Opening secure checkout…" : `Pay $${planOffers.find((offer) => offer.key === plan)?.price} once`}</Button>
      <Button disabled={busy} onClick={onClose} variant="ghost">Not now</Button>
    </>
    : <Button onClick={onClose} variant="ghost">Close</Button>;

  return <AppDialog actions={actions} dismissible={!busy} eyebrow="License" onClose={onClose} title="Get your lifetime license">
    <div className="plan-picker">
      {reason ? <p className="plan-picker__reason">{reason}</p> : null}
      {canManage ? <>
        <fieldset className="plan-picker__options">
          <legend className="sr-only">License</legend>
          {planOffers.map((offer) => <label className={cx("plan-picker-option", plan === offer.key && "is-selected")} key={offer.key}>
            <input checked={plan === offer.key} disabled={busy} name="plan" onChange={() => setPlan(offer.key)} type="radio" value={offer.key} />
            <span className="plan-picker-option__head">
              <strong>{offer.name}</strong>
              {offer.badge ? <span className="plan-picker-option__badge">{offer.badge}</span> : null}
            </span>
            <span className="plan-picker-option__price">
              {offer.regularPrice ? <s><span className="sr-only">Regular price </span>${offer.regularPrice}</s> : null}
              <strong>${offer.price}</strong>
              <span>{offer.period}</span>
            </span>
            <span className="plan-picker-option__tagline">{offer.tagline}</span>
            {offer.support ? <span className="plan-picker-option__support">{offer.support}</span> : null}
          </label>)}
        </fieldset>
        <p className="plan-picker__footnote">Every feature for life: unlimited mailboxes, sends and campaigns, with no "Sent via InboxJoy" footer. Secure checkout by Dodo Payments.</p>
      </> : <p>Only your workspace owner can buy the license. Ask them to get it from Settings so everyone here can send.</p>}
      {error ? <p className="plan-picker__error" role="alert">{error}</p> : null}
    </div>
  </AppDialog>;
}
