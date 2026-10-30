"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button, campaignDisplayStatus, campaignStatusLabel, campaignStatusReasonText, campaignStatusTone, Card, EmptyState, labelStatus, PageHeader, StatusBadge, type CampaignStatusFields } from "@inboxjoy/ui";
import { apiErrorMessage, apiFetch } from "@/lib/api";
import { Toast } from "@/components/toast";
import { OpenTrackingOff, useOpenTrackingEnabled } from "@/components/open-tracking";
import { CampaignEditor, type EditorLifecycle } from "../campaign-editor";
import { DeliveryAdvisorCard } from "./delivery-advisor";
import { VariablesCard } from "./variables-card";
import { LeadVariablesDialog, type LeadVariablesView } from "../lead-variables-dialog";
import { missingVariablesFromError, type MissingVariablesSummary } from "../new/missing-variables";
import { MissingVariablesBlocker } from "../new/missing-variables-panel";
import { audienceNames, normalizeAudienceListIds, type AudienceList } from "../new/wizard-state";
import { campaignResumePath, canPauseCampaign, canResumeCampaign, withCampaignStatus, type CampaignTarget, newLeadsNotice, publishNotice, type QueuedEnrollmentOutcome } from "../campaign-data";

type CampaignTab = "overview" | "contacts" | "reports";
type Step = { id: string; delayDays: number; subject: string; body: string };
type Campaign = CampaignStatusFields & { id: string; campaignId?: string; sequenceStatus?: string; activeCount?: number; name: string; description?: string; steps: Step[]; enrolledCount?: number; newLeadsReady?: number };
type Metrics = { scheduled: number; sent: number; replied: number; opened: number; bounced: number; failed: number; unsubscribed: number; openRate?: number; replyRate?: number; unsubscribeRate?: number };
type AnalyticsVersion = { id: string; version: number; status: string; current: boolean; createdAt: string; updatedAt: string };
type Analytics = { currentVersion: number | null; selectedVersion: number | "all" | null; versions: AnalyticsVersion[]; totals: Metrics; enrollmentStatus: Record<string, number>; steps: Array<Metrics & { stepId: string; stepOrder: number; subject: string; version?: number }> };
type Enrollment = {
  id: string;
  contact: { id: string; email: string; firstName: string; lastName: string; company: string };
  status: string;
  nextStepOrder: number;
  lastEvent: { type: string; occurredAt: string } | null;
  createdAt: string;
};
type Pagination = { page: number; pageSize: number; total: number };

const PAGE_SIZE = 25;
const TABS: Array<{ id: CampaignTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "contacts", label: "Contacts" },
  { id: "reports", label: "Reports" },
];

function enrollmentTone(status: string): "neutral" | "good" | "warning" | "danger" | "info" {
  const normalized = status.toLowerCase();
  if (["bounced", "cancelled", "unsubscribed"].includes(normalized)) return "danger";
  if (["replied", "completed"].includes(normalized)) return "good";
  if (normalized === "paused") return "warning";
  if (normalized === "active") return "info";
  return "neutral";
}

function unsubscribeTone(rate: number): "neutral" | "warning" | "danger" {
  if (rate > 2) return "danger";
  if (rate >= 0.5) return "warning";
  return "neutral";
}

function UnsubscribeRate({ rate }: { rate: number }) {
  return <span className="unsubscribe-rate"><StatusBadge tone={unsubscribeTone(rate)}>{rate.toFixed(1)}%</StatusBadge>{rate > 2 ? <small>High opt-out rate. Review targeting and copy before sending more.</small> : null}</span>;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function nextStepLabel(enrollment: Enrollment) {
  if (["bounced", "cancelled", "completed", "replied", "unsubscribed"].includes(enrollment.status.toLowerCase())) return "—";
  return `Email ${enrollment.nextStepOrder}`;
}

export function SequenceDetail({ campaignId }: { campaignId: string }) {
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [audienceName, setAudienceName] = useState("All ready leads");
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [activeTab, setActiveTab] = useState<CampaignTab>("overview");
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [contactsPagination, setContactsPagination] = useState<Pagination>({ page: 1, pageSize: PAGE_SIZE, total: 0 });
  const [contactsPage, setContactsPage] = useState(1);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [contactsError, setContactsError] = useState("");
  const [contactsRefresh, setContactsRefresh] = useState(0);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [missingBlocker, setMissingBlocker] = useState<MissingVariablesSummary | null>(null);
  const [variablesView, setVariablesView] = useState<LeadVariablesView | null>(null);
  const [variablesRefresh, setVariablesRefresh] = useState(0);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const openTrackingOff = useOpenTrackingEnabled() === false;
  const [editorVersion, setEditorVersion] = useState(0);
  const [analyticsVersion, setAnalyticsVersion] = useState("current");
  const analyticsRequestRef = useRef(0);
  const analyticsVersionRef = useRef(analyticsVersion);
  const contactsRequestRef = useRef(0);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const overviewPanelRef = useRef<HTMLElement | null>(null);
  const editorRef = useRef<EditorLifecycle | null>(null);

  const analyticsUrl = (id: string, version: string) => {
    const analyticsQuery = version === "current" ? "" : `?version=${encodeURIComponent(version)}`;
    return `/v1/sequences/${id}/analytics${analyticsQuery}`;
  };

  const isCurrentAnalyticsRequest = (requestId: number, version: string) => requestId === analyticsRequestRef.current && version === analyticsVersionRef.current;

  const selectAnalyticsVersion = (version: string) => {
    analyticsVersionRef.current = version;
    setAnalyticsVersion(version);
  };

  const load = async () => {
    const requestId = ++analyticsRequestRef.current;
    const requestedVersion = analyticsVersion;
    analyticsVersionRef.current = requestedVersion;
    setLoading(true); setError("");
    try {
      const [sequenceData, analyticsData, campaignData, listData] = await Promise.all([
        apiFetch<{ sequences: Campaign[] }>("/v1/sequences", {}, "Could not load campaigns."),
        apiFetch<Analytics>(analyticsUrl(campaignId, requestedVersion), {}, "Could not load campaign analytics."),
        apiFetch<{ campaigns: CampaignTarget[] }>("/v1/campaigns", {}, "Could not load campaign audience.").catch(() => ({ campaigns: [] as CampaignTarget[] })),
        apiFetch<{ lists?: AudienceList[]; contactLists?: AudienceList[] }>("/v1/lists", {}, "Could not load contact lists."),
      ]);
      if (!isCurrentAnalyticsRequest(requestId, requestedVersion)) return;
      const selected = sequenceData.sequences.find((item) => item.id === campaignId);
      if (!selected) throw new Error("Campaign not found.");
      const target = campaignData.campaigns.find((item) => item.sequenceId === campaignId);
      const details = target ? await apiFetch<{ campaign: CampaignTarget; newLeadsReady?: number }>(`/v1/campaigns/${target.id}`, {}, "Could not load campaign sending details.").catch(() => null) : null;
      if (!isCurrentAnalyticsRequest(requestId, requestedVersion)) return;
      const currentTarget = details ? { ...details.campaign, newLeadsReady: details.newLeadsReady ?? details.campaign.newLeadsReady } : target;
      const targetListIds = normalizeAudienceListIds(target?.listIds, target?.listId);
      setAudienceName(audienceNames(targetListIds, listData.lists ?? listData.contactLists ?? []));
      setCampaign(withCampaignStatus(selected, currentTarget)); setAnalytics(analyticsData);
    } catch (reason) { if (isCurrentAnalyticsRequest(requestId, requestedVersion)) setError(apiErrorMessage(reason, "Could not load campaign.")); } finally { if (isCurrentAnalyticsRequest(requestId, requestedVersion)) setLoading(false); }
  };

  useEffect(() => { void load(); }, [campaignId, analyticsVersion]);

  useEffect(() => {
    if (activeTab !== "contacts") return;
    const requestId = ++contactsRequestRef.current;
    setContactsLoading(true);
    setContactsError("");
    void apiFetch<{ enrollments: Enrollment[]; pagination: Pagination }>(`/v1/sequences/${campaignId}/enrollments?page=${contactsPage}&pageSize=${PAGE_SIZE}`, {}, "Could not load enrolled contacts.")
      .then((data) => {
        if (requestId !== contactsRequestRef.current) return;
        setEnrollments(data.enrollments);
        setContactsPagination(data.pagination);
      })
      .catch((reason) => {
        if (requestId === contactsRequestRef.current) setContactsError(apiErrorMessage(reason, "Could not load enrolled contacts."));
      })
      .finally(() => {
        if (requestId === contactsRequestRef.current) setContactsLoading(false);
      });
    return () => {
      if (requestId === contactsRequestRef.current) contactsRequestRef.current += 1;
    };
  }, [activeTab, campaignId, contactsPage, contactsRefresh]);

  const enrollmentRows = useMemo(() => Object.entries(analytics?.enrollmentStatus ?? {}).sort((left, right) => right[1] - left[1]), [analytics]);
  const totalContactPages = Math.max(1, Math.ceil(contactsPagination.total / contactsPagination.pageSize));

  const handleTabKey = (event: KeyboardEvent<HTMLButtonElement>, tab: CampaignTab) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = TABS.findIndex((item) => item.id === tab);
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : event.key === "ArrowRight" ? (currentIndex + 1) % TABS.length : (currentIndex - 1 + TABS.length) % TABS.length;
    const nextTab = TABS[nextIndex]!;
    setActiveTab(nextTab.id);
    tabRefs.current[nextIndex]?.focus();
  };

  const showEnrollPanel = () => {
    setActiveTab("overview");
    window.requestAnimationFrame(() => {
      const enrollPanel = overviewPanelRef.current?.querySelector<HTMLElement>(".two-column .campaign-detail-card:last-child");
      enrollPanel?.scrollIntoView({ behavior: "smooth", block: "center" });
      enrollPanel?.querySelector<HTMLElement>("select, input, button")?.focus({ preventScroll: true });
    });
  };

  async function lifecycle(action: "publish" | "pause" | "resume" | "duplicate" | "archive" | "launch", editor?: EditorLifecycle) {
    if (!campaign) return;
    setBusy(action); setError(""); setNotice(""); setMissingBlocker(null);
    try {
      // Every action below remounts the editor, so unsaved edits are saved first or the action stops.
      const savedFirst = Boolean(editor?.unsavedChanges);
      if (savedFirst && !(await editor!.saveChanges())) return;
      const savedPrefix = savedFirst ? "Changes saved. " : "";
      if (action === "launch") {
        if (!campaign.campaignId) throw new Error("Refresh the campaign to load its sending details.");
        const launched = await apiFetch<{ enrollment?: { enrolled?: number } }>(`/v1/campaigns/${campaign.campaignId}/launch`, { method: "POST" }, "Could not send to new leads.");
        await load();
        setContactsRefresh((current) => current + 1);
        setEditorVersion((current) => current + 1);
        setNotice(newLeadsNotice(launched.enrollment?.enrolled ?? 0));
        return;
      }
      if (action === "resume") {
        await apiFetch(campaignResumePath(campaign), { method: "POST" }, "Could not update campaign.");
        await load();
        setNotice(`${savedPrefix}Campaign resumed.`);
        setEditorVersion((current) => current + 1);
        return;
      }
      const data = await apiFetch<{ sequence: Campaign; queuedEnrollment?: QueuedEnrollmentOutcome }>(`/v1/sequences/${campaign.id}/${action}`, { method: "POST" }, "Could not update campaign.");
      if (action === "duplicate") {
        window.location.assign(`/app/sequences/${data.sequence.id}`);
        return;
      }
      await load();
      setNotice(savedPrefix + (action === "publish" ? publishNotice(data.queuedEnrollment) : `Campaign ${action}d.`));
      setEditorVersion((current) => current + 1);
    } catch (reason) {
      const missing = missingVariablesFromError(reason);
      if (missing) setMissingBlocker(missing);
      else setError(apiErrorMessage(reason, "Could not update campaign."));
    } finally { setBusy(""); }
  }

  async function handleCampaignSaved(savedCampaign: Campaign) {
    setCampaign((current) => ({ ...current, ...savedCampaign }));
    await load();
    setVariablesRefresh((current) => current + 1);
  }

  if (loading && !campaign) return <div className="page-stack dashboard-polish-page"><PageHeader eyebrow="Campaigns" title="Loading campaign" description="Retrieving campaign performance and enrollment details." /><Card className="campaign-loading"><p>Loading campaign…</p></Card></div>;
  if (!campaign) return <div className="page-stack dashboard-polish-page"><PageHeader eyebrow="Campaigns" title="Campaign unavailable" description="We could not retrieve this campaign." /><Card className="campaign-message campaign-message--error"><p role="alert">{error}</p><Button variant="ghost" onClick={() => void load()}>Try again</Button></Card></div>;

  const status = campaignDisplayStatus(campaign);
  const reasonText = campaignStatusReasonText(campaign.statusReason);
  const newLeadsReady = campaign.newLeadsReady ?? 0;
  const canSendToNewLeads = newLeadsReady > 0 && ["active", "paused", "completed", "published"].includes(campaign.status);

  return <div className="page-stack sequence-detail-page dashboard-polish-page">
    <PageHeader eyebrow="Campaign" title={campaign.name} description={campaign.description || `${campaign.steps.length} email steps`} />
    {error ? <Toast tone="error" message={error} onDismiss={() => setError("")} /> : null}
    {notice ? <Toast tone="success" message={notice} onDismiss={() => setNotice("")} /> : null}
    {missingBlocker ? <MissingVariablesBlocker summary={missingBlocker} onReview={() => setVariablesView({ filter: "missing" })} /> : null}

    <div aria-label="Campaign details" className="campaign-detail-tabs" role="tablist">
      {TABS.map((tab, index) => <button aria-controls={`campaign-${tab.id}-panel`} aria-selected={activeTab === tab.id} id={`campaign-${tab.id}-tab`} key={tab.id} ref={(element) => { tabRefs.current[index] = element; }} role="tab" tabIndex={activeTab === tab.id ? 0 : -1} type="button" onClick={() => setActiveTab(tab.id)} onKeyDown={(event) => handleTabKey(event, tab.id)}>{tab.label}</button>)}
    </div>

    <section aria-labelledby="campaign-overview-tab" className="campaign-detail-panel" hidden={activeTab !== "overview"} id="campaign-overview-panel" ref={overviewPanelRef} role="tabpanel">
      <div className="campaign-overview-summary">
        <Card className="campaign-summary-card"><span className="polish-mono-label">Status</span><span className="campaign-summary-status"><StatusBadge tone={campaignStatusTone(status)}>{campaignStatusLabel(status)}</StatusBadge></span><span className="polish-kpi-helper">{reasonText ?? "Current campaign state"}</span>{status === "finished" && campaign.completedAt ? <span className="polish-kpi-helper">Finished {formatDate(campaign.completedAt)}</span> : null}{canSendToNewLeads ? <div className="campaign-new-leads-notice"><span className="campaign-muted">{newLeadsReady} new {newLeadsReady === 1 ? "lead" : "leads"} ready</span><Button disabled={Boolean(busy)} onClick={() => void lifecycle("launch", editorRef.current ?? undefined)}>{busy === "launch" ? "Sending…" : status === "paused" ? "Resume and send to new leads" : "Send to new leads"}</Button></div> : null}</Card>
        <Card className="campaign-summary-card"><span className="polish-mono-label">Contacts</span><strong>{(campaign.enrolledCount ?? 0).toLocaleString()}</strong><span className="polish-kpi-helper">Total enrolled</span></Card>
        <Card className="campaign-summary-card"><span className="polish-mono-label">Emails</span><strong>{campaign.steps.length.toLocaleString()}</strong><span className="polish-kpi-helper">Steps in this campaign</span></Card>
        <Card className="campaign-summary-card campaign-summary-card--audience"><span className="polish-mono-label">Audience</span><strong>{audienceName}</strong><span className="polish-kpi-helper">Campaign target</span></Card>
      </div>

      <DeliveryAdvisorCard campaignId={campaign.campaignId} refreshToken={editorVersion} />
      <VariablesCard sequenceId={campaignId} refreshToken={editorVersion + variablesRefresh} onOpen={setVariablesView} />

      <section className="sequence-detail-editor campaign-editor-page" aria-label="Campaign editor and delivery tools">
        <CampaignEditor campaignId={campaignId} statusFields={campaign} key={editorVersion} onSaved={handleCampaignSaved} lifecycleActions={(editor) => { editorRef.current = editor; return <>
          {status === "draft" ? <Button disabled={Boolean(busy)} onClick={() => void lifecycle("publish", editor)}>{busy === "publish" ? "Publishing…" : editor.unsavedChanges ? "Save and publish" : "Publish"}</Button> : null}
          {canPauseCampaign(campaign) ? <Button variant="secondary" disabled={Boolean(busy)} onClick={() => void lifecycle("pause", editor)}>{busy === "pause" ? "Pausing…" : "Pause"}</Button> : null}
          {canResumeCampaign(campaign) ? <Button disabled={Boolean(busy)} onClick={() => void lifecycle("resume", editor)}>{busy === "resume" ? "Resuming…" : editor.unsavedChanges ? "Save and resume" : "Resume"}</Button> : null}
        </>; }} />
      </section>
    </section>

    {variablesView ? <LeadVariablesDialog sequenceId={campaignId} initialView={variablesView} onClose={() => setVariablesView(null)} onChanged={() => setVariablesRefresh((current) => current + 1)} /> : null}

    <section aria-labelledby="campaign-contacts-tab" className="campaign-detail-panel" hidden={activeTab !== "contacts"} id="campaign-contacts-panel" role="tabpanel">
      <Card className="campaign-contacts-card">
        <div className="polish-card-heading campaign-contacts-heading"><div><h2>Enrolled contacts</h2><p>{contactsPagination.total.toLocaleString()} contacts in this campaign.</p></div><Button onClick={showEnrollPanel}>Add contacts</Button></div>
        {contactsLoading ? <p className="campaign-contacts-state" role="status">Loading contacts…</p> : contactsError ? <div className="campaign-contacts-state"><p role="alert">{contactsError}</p><Button variant="ghost" onClick={() => setContactsRefresh((current) => current + 1)}>Try again</Button></div> : enrollments.length ? <>
          <div className="campaign-contacts-table" role="table" aria-label="Enrolled contacts">
            <div className="campaign-contact-row polish-table-head" role="row"><span>Contact</span><span>Company</span><span>Status</span><span>Next step</span><span>Last event</span><span>Enrolled date</span></div>
            {enrollments.map((enrollment) => {
              const contactName = [enrollment.contact.firstName, enrollment.contact.lastName].filter(Boolean).join(" ");
              return <div className="campaign-contact-row ph-mask" key={enrollment.id} role="row">
                <span className="campaign-contact-identity"><strong>{contactName || enrollment.contact.email}</strong><small>{enrollment.contact.email}</small></span>
                <span data-label="Company">{enrollment.contact.company || "—"}</span>
                <span data-label="Status"><StatusBadge tone={enrollmentTone(enrollment.status)}>{labelStatus(enrollment.status)}</StatusBadge></span>
                <span data-label="Next step">{nextStepLabel(enrollment)}</span>
                <span className="campaign-contact-event" data-label="Last event">{enrollment.lastEvent ? <><strong>{labelStatus(enrollment.lastEvent.type)}</strong><small><time dateTime={enrollment.lastEvent.occurredAt}>{formatDate(enrollment.lastEvent.occurredAt)}</time></small></> : "—"}</span>
                <span data-label="Enrolled"><time dateTime={enrollment.createdAt}>{formatDate(enrollment.createdAt)}</time></span>
              </div>;
            })}
          </div>
          <div className="campaign-contacts-pagination">
            <span>{contactsPagination.total.toLocaleString()} contacts · page {contactsPagination.page} of {totalContactPages}</span>
            <div><Button variant="ghost" disabled={contactsPagination.page <= 1} onClick={() => setContactsPage(contactsPagination.page - 1)}>Previous</Button><Button variant="ghost" disabled={contactsPagination.page >= totalContactPages} onClick={() => setContactsPage(contactsPagination.page + 1)}>Next</Button></div>
          </div>
        </> : <div className="campaign-contacts-empty"><EmptyState title="No enrolled contacts" description="Add contacts to start this campaign." action={<Button onClick={showEnrollPanel}>Add contacts</Button>} /></div>}
      </Card>
    </section>

    <section aria-labelledby="campaign-reports-tab" className="campaign-detail-panel" hidden={activeTab !== "reports"} id="campaign-reports-panel" role="tabpanel">
      <div className="campaign-report-summary">
        <Card className="campaign-summary-card"><span className="polish-mono-label">Contacts</span><strong>{(campaign.enrolledCount ?? 0).toLocaleString()}</strong><span className="polish-kpi-helper">Total enrolled</span></Card>
        <Card className="campaign-summary-card"><span className="polish-mono-label">Sent</span><strong>{(analytics?.totals.sent ?? 0).toLocaleString()}</strong><span className="polish-kpi-helper">Accepted messages</span></Card>
        <Card className="campaign-summary-card"><span className="polish-mono-label">Replied</span><strong>{(analytics?.totals.replied ?? 0).toLocaleString()}</strong><span className="polish-kpi-helper">{(analytics?.totals.replyRate ?? 0).toFixed(1)}% reply rate</span></Card>
        <Card className="campaign-summary-card"><span className="polish-mono-label">Unsubscribes</span><strong>{(analytics?.totals.unsubscribed ?? 0).toLocaleString()}</strong><UnsubscribeRate rate={analytics?.totals.unsubscribeRate ?? 0} /></Card>
      </div>
      <div className="sequence-detail-summary">
        <Card className="sequence-performance-card">
          <div className="polish-card-heading sequence-performance-heading"><div><h2>Step performance</h2><p>Delivery and response activity by email.</p></div><div className="sequence-version-tools"><StatusBadge tone={campaignStatusTone(status)}>{campaignStatusLabel(status)}</StatusBadge>{analytics?.versions.length ? <label className="sequence-version-select"><span>Version</span><select value={analyticsVersion} onChange={(event) => selectAnalyticsVersion(event.target.value)}><option value="current">Current{analytics.currentVersion ? ` · v${analytics.currentVersion}` : ""}</option>{analytics.versions.filter((version) => !version.current).map((version) => <option key={version.id} value={version.version}>History · v{version.version}</option>)}<option value="all">All versions</option></select></label> : null}</div></div>
          {loading ? <p className="polish-empty-copy" role="status">Loading selected analytics…</p> : analytics?.steps.length ? <div className="sequence-step-table" role="table" aria-label="Step analytics">
            <div className="sequence-step-row polish-table-head" role="row"><span>Step</span><span>Subject</span><span>Sent</span><span>Opened</span><span>Replied</span><span>Reply rate</span><span>Unsubscribes</span></div>
            {analytics.steps.map((step) => <div className="sequence-step-row" key={`${step.stepId}-${step.version ?? 0}`} role="row">
              <span className="sequence-step-number">{step.stepOrder}</span><span><strong>{step.subject || campaign.steps.find((campaignStep) => campaignStep.id === step.stepId)?.subject || `Email ${step.stepOrder}`}</strong>{typeof step.version === "number" ? <small>Version {step.version}</small> : null}</span><span data-label="Sent">{step.sent}</span><span data-label="Opened">{openTrackingOff ? <OpenTrackingOff /> : step.opened}</span><span data-label="Replied">{step.replied}</span><span data-label="Reply rate">{step.replyRate ?? (step.sent ? Number(((step.replied / step.sent) * 100).toFixed(1)) : 0)}%</span><span className="sequence-step-unsubscribes" data-label="Unsubscribes"><strong>{step.unsubscribed}</strong><UnsubscribeRate rate={step.unsubscribeRate ?? 0} /></span>
            </div>)}
          </div> : <p className="polish-empty-copy branded-empty-copy">No step activity has been recorded yet.</p>}
        </Card>

        <Card className="sequence-enrollment-card">
          <div className="polish-card-heading"><div><h2>Enrollment breakdown</h2><p>{campaign.enrolledCount ?? 0} total contacts enrolled.</p></div></div>
          {enrollmentRows.length ? <div className="enrollment-breakdown">{enrollmentRows.map(([enrollmentStatus, count]) => <div className="enrollment-breakdown-row" key={enrollmentStatus}><span>{labelStatus(enrollmentStatus)}</span><strong>{count}</strong><div className="enrollment-meter"><span style={{ width: `${Math.min(100, Math.round((count / Math.max(1, campaign.enrolledCount ?? 0)) * 100))}%` }} /></div></div>)}</div> : <EmptyState title="No enrollments yet" description="Publish the campaign and enroll contacts to see the lifecycle breakdown." />}
        </Card>
      </div>
    </section>
  </div>;
}
