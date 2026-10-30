"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, campaignDisplayStatus, campaignStatusLabel, campaignStatusTone, Card, EmptyState, PageHeader, ProgressBar, StatusBadge, type CampaignStatusFields } from "@inboxjoy/ui";
import { AppDialog } from "@/components/app-dialog";
import { useEditionFeatures } from "@/components/edition-provider";
import { EmailVerificationBanner } from "@/components/email-verification";
import { usePlanPicker } from "@/components/plan-picker";
import { track } from "@/lib/analytics";
import { apiErrorMessage, apiFetch } from "@/lib/api";
import type { WorkspaceBilling } from "@/lib/billing";
import { isWorkspaceProvisioningError, waitForWorkspaceProvisioning } from "@/lib/checkout";
import { campaignTargetsBySequence, withCampaignStatus, type CampaignTarget } from "./sequences/campaign-data";

type DailyMetric = { date: string; sent: number; replied: number };
type SequenceMetric = { sequenceId: string; name: string; sent: number; replied: number };
type Summary = {
  activeSequences?: number;
  sent?: number;
  replied?: number;
  replyRate?: number;
  bySequence?: SequenceMetric[];
  series?: DailyMetric[];
};
type Sequence = CampaignStatusFields & { id: string; name: string; steps: unknown[]; enrolledCount?: number };
type Notification = { id: string; type: string; title: string; body: string; readAt: string | null; createdAt: string };
type Inbox = { id: string; email: string | null; status: string; dailyLimit: number; sentToday: number; warmupPercent: number };
type Lead = { id: string };
type WorkspaceSummary = { postalAddress: string | null };
type DashboardSection = "summary" | "sequences" | "notifications" | "inboxes" | "leads" | "workspace";
type BillingActivation = "pending" | "active" | "delayed" | null;
type ProvisioningState = "idle" | "waiting" | "failed";

function relativeTime(value: string) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "";
  const elapsed = Date.now() - timestamp;
  const minutes = Math.max(1, Math.round(elapsed / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(value).toLocaleDateString();
}

export default function DashboardPage() {
  const [summary, setSummary] = useState<Summary>({});
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [inboxes, setInboxes] = useState<Inbox[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceSummary>({ postalAddress: null });
  const { applyBilling, beginConfirmingPayment } = usePlanPicker();
  const billingEnabled = useEditionFeatures().billing;
  const [billingActivation, setBillingActivation] = useState<BillingActivation>(null);
  const [billingModalOpen, setBillingModalOpen] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<DashboardSection, string>>>({});
  const [loading, setLoading] = useState(true);
  const [provisioningState, setProvisioningState] = useState<ProvisioningState>("idle");
  const billingSuccess = useRef(false);
  const loadGeneration = useRef(0);

  const loadDashboard = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setProvisioningState("idle");
    const request = () => Promise.allSettled([
          apiFetch<{ summary: Summary }>("/v1/analytics/summary?range=30", {}, "Dashboard analytics are temporarily unavailable."),
          Promise.all([
            apiFetch<{ sequences: Sequence[] }>("/v1/sequences", {}, "Could not load campaigns."),
            apiFetch<{ campaigns: CampaignTarget[] }>("/v1/campaigns", {}, "Could not load campaign statuses.").catch(() => ({ campaigns: [] as CampaignTarget[] })),
          ]).then(([data, campaignData]) => {
            const campaignsBySequence = campaignTargetsBySequence(campaignData.campaigns);
            return { sequences: data.sequences.map((sequence) => withCampaignStatus(sequence, campaignsBySequence.get(sequence.id))) };
          }),
          apiFetch<{ notifications: Notification[] }>("/v1/notifications?limit=6", {}, "Could not load recent activity."),
          apiFetch<{ inboxes: Inbox[] }>("/v1/inboxes", {}, "Could not load mailboxes."),
          apiFetch<{ leads: Lead[] }>("/v1/leads", {}, "Could not load leads."),
          apiFetch<{ workspace: WorkspaceSummary }>("/v1/workspace", {}, "Could not load workspace settings."),
    ]);

    let results = await request();
    if (results.some((result) => result.status === "rejected" && isWorkspaceProvisioningError(result.reason))) {
      if (generation !== loadGeneration.current) return;
      setProvisioningState("waiting");
      await waitForWorkspaceProvisioning();
      results = await request();
      if (generation !== loadGeneration.current) return;
      if (results.some((result) => result.status === "rejected" && isWorkspaceProvisioningError(result.reason))) {
        setProvisioningState("failed");
        setLoading(false);
        return;
      }
    }

    const sections: DashboardSection[] = ["summary", "sequences", "notifications", "inboxes", "leads", "workspace"];
    const nextErrors: Partial<Record<DashboardSection, string>> = {};
    results.forEach((result, index) => {
      const section = sections[index]!;
      if (result.status === "rejected") nextErrors[section] = apiErrorMessage(result.reason, "This section is temporarily unavailable.");
    });
    if (results[0]?.status === "fulfilled") setSummary(results[0].value.summary);
    if (results[1]?.status === "fulfilled") setSequences(results[1].value.sequences);
    if (results[2]?.status === "fulfilled") setNotifications(results[2].value.notifications);
    if (results[3]?.status === "fulfilled") setInboxes(results[3].value.inboxes);
    if (results[4]?.status === "fulfilled") setLeads(results[4].value.leads);
    if (results[5]?.status === "fulfilled") setWorkspace(results[5].value.workspace);
    setErrors(nextErrors);
    setProvisioningState("idle");
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadDashboard();
    return () => { loadGeneration.current += 1; };
  }, [loadDashboard]);

  useEffect(() => {
    // The Dodo return only exists on the hosted edition.
    if (!billingEnabled) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("billing") === "success") {
      billingSuccess.current = true;
      setBillingModalOpen(true);
      url.searchParams.delete("billing");
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    }
    if (!billingSuccess.current) return;

    setBillingActivation("pending");
    // Keeps the banner in a "confirming" state (no second checkout) until the plan lands.
    beginConfirmingPayment();

    let stopped = false;
    let activated = false;
    let attempts = 0;
    let pollsFinished = false;
    let reconcileFinished = false;
    let pollTimer: ReturnType<typeof setTimeout>;
    let reconcileTimer: ReturnType<typeof setTimeout>;

    const activate = (nextBilling: WorkspaceBilling) => {
      if (stopped || activated) return;
      activated = true;
      track("checkout_completed");
      applyBilling(nextBilling);
      setBillingActivation("active");
      clearTimeout(pollTimer);
      clearTimeout(reconcileTimer);
    };

    const showDelayedIfFinished = () => {
      if (!stopped && !activated && pollsFinished && reconcileFinished) {
        setBillingActivation("delayed");
      }
    };

    const poll = async () => {
      if (stopped || activated) return;
      attempts += 1;
      try {
        const nextBilling = await apiFetch<WorkspaceBilling>("/v1/billing", {}, "Could not confirm billing activation.");
        if (stopped || activated) return;
        if (!nextBilling.needsLicense) {
          activate(nextBilling);
          return;
        }
      } catch {
        if (stopped || activated) return;
      }

      if (attempts >= 15) {
        pollsFinished = true;
        showDelayedIfFinished();
        return;
      }
      pollTimer = setTimeout(() => void poll(), 2_000);
    };

    const reconcile = async () => {
      if (stopped || activated) return;
      try {
        const nextBilling = await apiFetch<WorkspaceBilling>("/v1/billing/reconcile", { method: "POST" }, "Could not reconcile billing activation.");
        if (stopped || activated) return;
        if (!nextBilling.needsLicense) {
          activate(nextBilling);
          return;
        }
      } catch {
        if (stopped || activated) return;
      } finally {
        reconcileFinished = true;
        showDelayedIfFinished();
      }
    };

    pollTimer = setTimeout(() => void poll(), 2_000);
    reconcileTimer = setTimeout(() => void reconcile(), 6_000);
    return () => {
      stopped = true;
      clearTimeout(pollTimer);
      clearTimeout(reconcileTimer);
    };
  }, [applyBilling, beginConfirmingPayment, billingEnabled]);

  const recentSeries = useMemo(() => (summary.series ?? []).slice(-12), [summary.series]);
  const sequenceActivity = useMemo(() => new Map((summary.bySequence ?? []).map((item) => [item.sequenceId, item])), [summary.bySequence]);
  const hasActiveInbox = inboxes.some((inbox) => inbox.status === "active");
  const hasLeads = leads.length > 0;
  const hasCampaign = sequences.length > 0;
  const hasPostalAddress = Boolean(workspace.postalAddress?.trim());
  const onboardingAvailable = !loading && !errors.inboxes && !errors.leads && !errors.sequences && !errors.workspace;
  const showOnboarding = onboardingAvailable && !(hasActiveInbox && hasLeads && hasCampaign && hasPostalAddress);
  const headerAction = loading || hasActiveInbox && hasLeads
    ? { href: "/app/sequences/new", label: "New campaign" }
    : hasActiveInbox
      ? { href: "/app/leads", label: "Add leads" }
      : { href: "/app/inboxes", label: "Connect mailbox" };
  const kpis = [
    { label: "Emails sent", value: summary.sent ?? 0, helper: "Last 30 days", metric: "sent" as const },
    { label: "Replies", value: summary.replied ?? 0, helper: "Last 30 days", metric: "replied" as const },
    { label: "Reply rate", value: `${summary.replyRate ?? 0}%`, helper: "Replies per delivered email", metric: "replyRate" as const },
    { label: "Active campaigns", value: summary.activeSequences ?? 0, helper: "Currently published", metric: "active" as const },
  ];

  if (provisioningState !== "idle") {
    return <div className="page-stack dashboard-page dashboard-polish-page">
      <EmailVerificationBanner />
      <PageHeader eyebrow="Workspace" title="Dashboard" description="Your workspace is being prepared." />
      <Card className="workspace-provisioning-card">
        <p role={provisioningState === "failed" ? "alert" : "status"}>{provisioningState === "failed" ? "We could not finish setting up your workspace." : "Setting up your workspace…"}</p>
        {provisioningState === "failed" ? <Button onClick={() => void loadDashboard()} variant="secondary">Try again</Button> : null}
      </Card>
    </div>;
  }

  return (
    <div className="page-stack dashboard-page dashboard-polish-page">
      <EmailVerificationBanner />
      {billingModalOpen && billingActivation ? <AppDialog
        actions={billingActivation === "active" ? <><a className="ij-button ij-button--primary" href="/app/sequences/new">Start your first campaign</a><Button onClick={() => setBillingModalOpen(false)} variant="ghost">Later</Button></> : billingActivation === "delayed" ? <><Button onClick={() => window.location.reload()}>Refresh now</Button><Button onClick={() => setBillingModalOpen(false)} variant="ghost">Close</Button></> : undefined}
        dismissible={billingActivation !== "pending"}
        onClose={() => setBillingModalOpen(false)}
        title={billingActivation === "active" ? "You're all set." : billingActivation === "delayed" ? "Payment recorded" : "Confirming your payment"}
      >
        <div className={`billing-activation billing-activation--${billingActivation}`}>
          {billingActivation === "pending" ? <div aria-hidden="true" className="billing-activation__spinner"><span /></div> : null}
          {billingActivation === "active" ? <div aria-hidden="true" className="billing-activation__celebration">
            <div className="billing-confetti">{Array.from({ length: 18 }, (_, index) => <span key={index} />)}</div>
            <svg className="billing-success-icon" viewBox="0 0 96 96">
              <defs>
                <linearGradient id="billing-success-gradient" x1="15" x2="81" y1="15" y2="81" gradientUnits="userSpaceOnUse">
                  <stop className="billing-success-icon__green" />
                  <stop className="billing-success-icon__violet" offset="1" />
                </linearGradient>
              </defs>
              <circle className="billing-success-icon__backdrop" cx="48" cy="48" r="43" />
              <circle className="billing-success-icon__ring" cx="48" cy="48" r="39" />
              <path className="billing-success-icon__check" d="m29 49 12 12 27-29" pathLength="1" />
            </svg>
          </div> : null}
          {billingActivation === "delayed" ? <p role="status">Nothing to worry about — we have your payment and your plan will switch on shortly. Refresh in a minute, or reach us at <a href="mailto:hey@inboxjoy.online">hey@inboxjoy.online</a> if it stays this way.</p> : billingActivation === "pending" ? <p role="status">This takes a few seconds. Nothing to worry about — your payment is recorded.</p> : <p role="status">Your plan is active and sending is unlocked.</p>}
        </div>
      </AppDialog> : null}
      <PageHeader eyebrow="Last 30 days" title="Dashboard" description="Campaign performance, recent workspace activity, and mailbox warm-up at a glance." action={<a className="ij-button ij-button--primary" href={headerAction.href}>{headerAction.label}</a>} />

      {showOnboarding ? <Card className="onboarding-card">
        <div className="polish-card-heading"><div><span className="polish-mono-label">Getting started</span><h2>Send your first campaign</h2><p>Complete these steps in order so your first launch has a sender and an audience.</p></div><span className="onboarding-progress">{[hasActiveInbox, hasLeads, hasCampaign, hasPostalAddress].filter(Boolean).length}/4</span></div>
        <div className="onboarding-steps">
          <a className={hasActiveInbox ? "is-complete" : ""} href="/app/inboxes"><span className="onboarding-check" aria-hidden="true">{hasActiveInbox ? "✓" : "1"}</span><span><strong>Connect a mailbox</strong><small>{hasActiveInbox ? "An active sender is ready." : "Connect Gmail or Outlook and finish authorization."}</small></span><span className="onboarding-action">{hasActiveInbox ? "Done" : "Connect"}</span></a>
          <a className={hasLeads ? "is-complete" : ""} href="/app/leads"><span className="onboarding-check" aria-hidden="true">{hasLeads ? "✓" : "2"}</span><span><strong>Add leads</strong><small>{hasLeads ? `${leads.length} ${leads.length === 1 ? "lead is" : "leads are"} available.` : "Upload a CSV or paste contacts to build your audience."}</small></span><span className="onboarding-action">{hasLeads ? "Done" : "Add leads"}</span></a>
          {hasActiveInbox && hasLeads ? <a className={hasCampaign ? "is-complete" : ""} href="/app/sequences/new"><span className="onboarding-check" aria-hidden="true">{hasCampaign ? "✓" : "3"}</span><span><strong>Create your first campaign</strong><small>{hasCampaign ? "Your first campaign has been created." : "Choose an audience, write the sequence, and launch."}</small></span><span className="onboarding-action">{hasCampaign ? "Done" : "Create"}</span></a> : <div className="is-disabled" aria-disabled="true"><span className="onboarding-check" aria-hidden="true">3</span><span><strong>Create your first campaign</strong><small>Connect a mailbox and add leads to unlock this step.</small></span><span className="onboarding-action">Locked</span></div>}
          <a className={hasPostalAddress ? "is-complete" : ""} href="/app/settings/workspace"><span className="onboarding-check" aria-hidden="true">{hasPostalAddress ? "✓" : "4"}</span><span><strong>Add your sender address</strong><small>Optional — shown in your email footers and builds trust with spam filters.</small></span><span className="onboarding-action">{hasPostalAddress ? "Done" : "Add address"}</span></a>
        </div>
      </Card> : null}

      <div className="polish-kpi-grid" aria-label="Workspace performance">
        {kpis.map((kpi) => {
          const values = recentSeries.map((item) => kpi.metric === "sent" ? item.sent : kpi.metric === "replied" ? item.replied : item.sent ? (item.replied / item.sent) * 100 : 0);
          const maximum = Math.max(1, ...values);
          return <Card className="polish-kpi-card" key={kpi.label}>
            <span className="polish-mono-label">{kpi.label}</span>
            {loading ? <span className="polish-kpi-skeleton" aria-label="Loading metric" /> : <strong>{errors.summary ? "—" : typeof kpi.value === "number" ? kpi.value.toLocaleString() : kpi.value}</strong>}
            <span className="polish-kpi-helper">{errors.summary ? "Analytics unavailable" : kpi.helper}</span>
            {kpi.metric !== "active" ? <div className="polish-sparkline" aria-hidden="true">{recentSeries.map((day, index) => <span className={index === recentSeries.length - 1 ? "is-latest" : ""} key={`${kpi.label}-${day.date}`} style={{ height: `${Math.max(8, Math.round((values[index]! / maximum) * 100))}%` }} />)}</div> : null}
          </Card>;
        })}
      </div>

      <Card className="polish-table-card dashboard-campaign-table">
        <div className="polish-card-heading">
          <div><h2>Campaigns</h2><p>Current sequences with delivery activity from the last 30 days.</p></div>
          <a className="ij-button ij-button--secondary" href="/app/sequences">View all</a>
        </div>
        {loading ? <p className="polish-empty-copy">Loading campaigns…</p> : errors.sequences ? <p className="polish-empty-copy" role="alert">{errors.sequences}</p> : sequences.length ? (
          <div className="polish-table" role="table" aria-label="Campaign performance">
            <div className="polish-table-row dashboard-campaign-row polish-table-head" role="row"><span>Campaign</span><span>Sent</span><span>Replies</span><span>Reply rate</span><span>Status</span></div>
            {sequences.slice(0, 6).map((sequence) => {
              const activity = sequenceActivity.get(sequence.id);
              const sent = activity?.sent ?? 0;
              const replied = activity?.replied ?? 0;
              const replyRate = sent ? Number(((replied / sent) * 100).toFixed(1)) : 0;
              const status = campaignDisplayStatus(sequence);
              return <a className="polish-table-row dashboard-campaign-row" href={`/app/sequences/${sequence.id}`} key={sequence.id} role="row">
                <span><strong>{sequence.name}</strong><small>{sequence.steps.length} steps</small></span>
                <span data-label="Sent">{sent.toLocaleString()}</span><span data-label="Replied">{replied.toLocaleString()}</span><span data-label="Reply rate">{sent ? `${replyRate}%` : "—"}</span>
                <span data-label="Status"><StatusBadge tone={campaignStatusTone(status)}>{campaignStatusLabel(status)}</StatusBadge></span>
              </a>;
            })}
          </div>
        ) : <EmptyState title="No campaigns yet" description="Create a campaign to begin tracking delivery and reply performance." action={<a className="ij-button ij-button--primary" href="/app/sequences/new">New campaign</a>} />}
      </Card>

      <div className="dashboard-lower-grid">
        <Card className="activity-card">
          <div className="polish-card-heading"><div><h2>Recent activity</h2><p>Latest events recorded in this workspace.</p></div></div>
          {loading ? <p className="polish-empty-copy">Loading activity…</p> : errors.notifications ? <p className="polish-empty-copy" role="alert">{errors.notifications}</p> : notifications.length ? <div className="activity-list ph-mask">{notifications.map((notification) => <div className={`activity-row${notification.readAt ? "" : " is-unread"}`} key={notification.id}>
            <span className={`activity-icon activity-icon--${notification.type}`} aria-hidden="true" />
            <span><strong>{notification.title}</strong><small>{notification.body}</small></span>
            <time dateTime={notification.createdAt}>{relativeTime(notification.createdAt)}</time>
          </div>)}</div> : <p className="polish-empty-copy branded-empty-copy">No activity has been recorded yet.</p>}
        </Card>

        <Card className="warmup-card">
          <div className="polish-card-heading"><div><h2>Mailbox warm-up</h2><p>Current ramp progress and daily usage.</p></div></div>
          {loading ? <p className="polish-empty-copy">Loading mailboxes…</p> : errors.inboxes ? <p className="polish-empty-copy" role="alert">{errors.inboxes}</p> : inboxes.length ? <div className="warmup-list ph-mask">{inboxes.map((inbox) => <div className="warmup-row" key={inbox.id}>
            <div><strong>{inbox.email ?? "Address pending — reconnect"}</strong><span>{inbox.sentToday} of {inbox.dailyLimit} sent today</span></div>
            <span className="polish-mono-value">{inbox.warmupPercent}%</span>
            <ProgressBar label={`${inbox.email ?? "Pending mailbox"} warm-up progress`} value={inbox.warmupPercent} />
          </div>)}</div> : <p className="polish-empty-copy branded-empty-copy">Connect a mailbox to begin warm-up.</p>}
        </Card>
      </div>
    </div>
  );
}
