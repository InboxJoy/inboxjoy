"use client";

import { useEffect, useMemo, useState } from "react";
import { Archive, Copy, Pause, Play, Send, Trash2, UserPlus, type LucideIcon } from "lucide-react";
import { Button, campaignDisplayStatus, campaignStatusLabel, campaignStatusReasonText, campaignStatusTone, Card, EmptyState, PageHeader, StatusBadge, type CampaignStatusFields } from "@inboxjoy/ui";
import { apiErrorMessage, apiFetch } from "@/lib/api";
import { Toast } from "@/components/toast";
import { OpenTrackingOff, useOpenTrackingEnabled } from "@/components/open-tracking";
import { campaignResumePath, canPauseCampaign, canResumeCampaign, campaignTargetsBySequence, newLeadsNotice, publishNotice, withCampaignStatus, type CampaignTarget, type QueuedEnrollmentOutcome } from "./campaign-data";

type Step = { id: string; delayDays: number; subject: string; body: string };
type Campaign = CampaignStatusFields & { id: string; campaignId?: string; sequenceStatus?: string; name: string; description?: string; steps: Step[]; enrolledCount?: number; activeCount?: number; finishedCount?: number; inProgressCount?: number; openRate?: number; replyRate?: number; unsubscribed?: number; unsubscribeRate?: number };
type Filter = "All" | "Active" | "Needs attention" | "Paused" | "Finished" | "Draft";

function unsubscribeTone(rate: number): "neutral" | "warning" | "danger" {
  if (rate > 2) return "danger";
  if (rate >= 0.5) return "warning";
  return "neutral";
}

function UnsubscribeRate({ rate, hasLeads }: { rate: number; hasLeads: boolean }) {
  if (!hasLeads) return <span className="unsubscribe-rate campaign-cell-rate" data-label="Unsub rate"><span className="campaign-rate-empty">—</span></span>;
  return <span className="unsubscribe-rate campaign-cell-rate" data-label="Unsub rate"><StatusBadge tone={unsubscribeTone(rate)}>{rate.toFixed(1)}%</StatusBadge>{rate > 2 ? <small title="Review targeting and copy before sending more.">High opt-out rate</small> : null}</span>;
}

// Rates mean nothing before anyone is enrolled, so show a dash instead of a misleading 0%.
function Rate({ label, value, hasLeads, off = false }: { label: string; value?: number; hasLeads: boolean; off?: boolean }) {
  return <span className="campaign-cell-rate" data-label={label}>{off ? <OpenTrackingOff /> : hasLeads ? `${value ?? 0}%` : <span className="campaign-rate-empty">—</span>}</span>;
}

// One column for where the campaign stands: leads done out of enrolled, and how many still have emails to go.
// "Left" is the API's inProgressCount (scheduled, active or paused leads). "Done" is everyone else: every lead
// that left the sequence (finished, replied, bounced, unsubscribed, stopped). A finished campaign has none left.
function CampaignProgress({ enrolled, inProgress, isFinished }: { enrolled: number; inProgress: number; isFinished: boolean }) {
  if (!enrolled) return <span className="campaign-progress" data-label="Progress"><span className="campaign-rate-empty">No leads yet</span></span>;
  const remaining = isFinished ? 0 : Math.min(enrolled, Math.max(0, inProgress));
  const finished = enrolled - remaining;
  const percent = Math.min(100, Math.round((finished / enrolled) * 100));
  return <span className="campaign-progress" data-label="Progress">
    <span className="campaign-progress-line"><strong>{finished}</strong> of {enrolled} done</span>
    <span aria-label={`${finished} of ${enrolled} leads done`} aria-valuemax={enrolled} aria-valuemin={0} aria-valuenow={finished} className="enrollment-meter" role="progressbar"><span style={{ width: `${percent}%` }} /></span>
    <small>{remaining && !isFinished ? `${remaining} ${remaining === 1 ? "lead has" : "leads have"} emails left` : "All emails sent"}</small>
  </span>;
}

function finishedOn(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : `Finished ${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

// Same icon-button row actions as the Mailboxes table: the label lives in the tooltip and aria-label.
function RowAction({ label, icon: Icon, danger = false, disabled, onClick }: { label: string; icon: LucideIcon; danger?: boolean; disabled: boolean; onClick: () => void }) {
  return <button aria-label={label} className={danger ? "inbox-tool-btn inbox-tool-btn--danger" : "inbox-tool-btn"} data-tooltip={label} disabled={disabled} type="button" onClick={onClick}><Icon aria-hidden="true" strokeWidth={1.7} /></button>;
}

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [filter, setFilter] = useState<Filter>("All");
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const openTrackingOff = useOpenTrackingEnabled() === false;

  // Row actions refresh in place; only the first load and a manual retry show the loading card.
  const load = async (showLoading = false) => {
    if (showLoading) setLoading(true);
    setError("");
    try {
      const [data, campaignData] = await Promise.all([
        apiFetch<{ sequences: Campaign[] }>("/v1/sequences", {}, "Could not load campaigns."),
        // Sequences already carry a status; campaign details only refine it, so the page still renders if this call fails.
        apiFetch<{ campaigns: CampaignTarget[] }>("/v1/campaigns", {}, "Could not load campaign statuses.").catch(() => ({ campaigns: [] as CampaignTarget[] })),
      ]);
      const campaignsBySequence = campaignTargetsBySequence(campaignData.campaigns);
      setCampaigns(data.sequences.map((sequence) => withCampaignStatus(sequence, campaignsBySequence.get(sequence.id))));
    } catch (reason) {
      setError(apiErrorMessage(reason, "Could not load campaigns."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const filterCounts = useMemo(() => campaigns.reduce((counts, campaign) => {
    const label = campaignStatusLabel(campaignDisplayStatus(campaign)) as Filter;
    counts.set(label, (counts.get(label) ?? 0) + 1);
    return counts;
  }, new Map<Filter, number>([["All", campaigns.length]])), [campaigns]);

  const filteredCampaigns = useMemo(() => campaigns.filter((campaign) => {
    if (filter === "All") return true;
    return campaignStatusLabel(campaignDisplayStatus(campaign)) === filter;
  }), [campaigns, filter]);

  const act = async (campaign: Campaign, action: "publish" | "pause" | "resume" | "duplicate" | "archive" | "launch") => {
    setBusyId(`${campaign.id}-${action}`);
    setError("");
    setNotice("");
    try {
      if (action === "launch") {
        if (!campaign.campaignId) throw new Error("Refresh campaigns to load the sending details.");
        const launched = await apiFetch<{ enrollment?: { enrolled?: number } }>(`/v1/campaigns/${campaign.campaignId}/launch`, { method: "POST" }, "Could not send to new leads.");
        await load();
        setNotice(newLeadsNotice(launched.enrollment?.enrolled ?? 0));
        return;
      }
      if (action === "resume") {
        await apiFetch(campaignResumePath(campaign), { method: "POST" }, "Could not update campaign.");
        await load();
        setNotice(`Campaign ${action === "resume" ? "resumed" : `${action}d`}.`);
        return;
      }
      const data = await apiFetch<{ sequence: Campaign; queuedEnrollment?: QueuedEnrollmentOutcome }>(`/v1/sequences/${campaign.id}/${action}`, { method: "POST" }, "Could not update campaign.");
      if (action === "duplicate") {
        setCampaigns((current) => [data.sequence, ...current]);
        setNotice("Draft copy created.");
      } else {
        await load();
        setNotice(action === "publish" ? publishNotice(data.queuedEnrollment) : `Campaign ${action}d.`);
      }
    } catch (reason) {
      setError(apiErrorMessage(reason, "Could not update campaign."));
    } finally {
      setBusyId("");
    }
  };

  const deleteCampaign = async (campaign: Campaign) => {
    if (!window.confirm("Delete this campaign? This permanently removes the sequence, its versions, enrollments, and send history. This cannot be undone.")) return;
    setBusyId(`${campaign.id}-delete`);
    setError("");
    setNotice("");
    try {
      await apiFetch(`/v1/sequences/${campaign.id}`, { method: "DELETE" }, "Could not delete campaign.");
      setCampaigns((current) => current.filter((item) => item.id !== campaign.id));
      setNotice("Campaign deleted.");
    } catch (reason) {
      setError(apiErrorMessage(reason, "Could not delete campaign."));
    } finally {
      setBusyId("");
    }
  };

  return <div className="page-stack campaign-page dashboard-polish-page">
    <PageHeader eyebrow="Outreach" title="Campaigns" description="Build multi-step outreach, monitor replies, and control delivery without leaving your workspace." action={<a className="ij-button ij-button--primary" href="/app/sequences/new">New campaign</a>} />
    {error ? <Toast tone="error" message={error} onDismiss={() => setError("")} action={<Button variant="ghost" onClick={() => void load(true)}>Try again</Button>} /> : null}
    {notice ? <Toast tone="success" message={notice} onDismiss={() => setNotice("")} /> : null}
    {loading ? <Card className="campaign-loading"><p>Loading campaigns…</p></Card> : campaigns.length === 0 ? <EmptyState title="Create your first campaign" description="Start with a personalized first email, then add follow-ups on your schedule." action={<a className="ij-button ij-button--primary" href="/app/sequences/new">New campaign</a>} /> : <Card className="polish-table-card campaign-list-card campaign-list-card--table">
      <div className="polish-table-toolbar">
        <div className="polish-filter-pills" aria-label="Filter campaigns">{(["All", "Active", "Needs attention", "Paused", "Finished", "Draft"] as Filter[]).filter((label) => label === "All" || label === filter || filterCounts.get(label)).map((label) => <button aria-pressed={filter === label} key={label} onClick={() => setFilter(label)} type="button">{label}<span className="polish-filter-count">{filterCounts.get(label) ?? 0}</span></button>)}</div>
        <span className="polish-mono-label">{filteredCampaigns.length} {filteredCampaigns.length === 1 ? "campaign" : "campaigns"}</span>
      </div>
      {filteredCampaigns.length ? <div className="campaign-table" role="table" aria-label="Campaigns">
        <div className="campaign-table-row campaign-table-head" role="row"><span>Campaign</span><span>Progress</span><span>Open rate</span><span>Reply rate</span><span>Unsub rate</span><span>Status</span><span className="campaign-actions-head">Actions</span></div>
        {filteredCampaigns.map((campaign) => {
          const status = campaignDisplayStatus(campaign);
          const reasonText = campaignStatusReasonText(campaign.statusReason);
          const isBusy = busyId.startsWith(`${campaign.id}-`);
          const enrolled = campaign.enrolledCount ?? 0;
          const statusHelper = reasonText ?? (status === "finished" ? finishedOn(campaign.completedAt) : null);
          const stepCount = `${campaign.steps.length} ${campaign.steps.length === 1 ? "step" : "steps"}`;
          return <div className="campaign-table-row" key={campaign.id} role="row">
            <div className="campaign-cell-name">
              <a className="campaign-name" href={`/app/sequences/${campaign.id}`}>{campaign.name}</a>
              <small className="campaign-meta" title={campaign.description || undefined}>{stepCount}{campaign.description ? <> · {campaign.description}</> : null}</small>
            </div>
            <CampaignProgress enrolled={enrolled} inProgress={campaign.inProgressCount ?? 0} isFinished={status === "finished"} />
            <Rate hasLeads={enrolled > 0} label="Open rate" off={openTrackingOff} value={campaign.openRate} />
            <Rate hasLeads={enrolled > 0} label="Reply rate" value={campaign.replyRate} />
            <UnsubscribeRate hasLeads={enrolled > 0} rate={campaign.unsubscribeRate ?? 0} />
            <span className="campaign-cell-status" data-label="Status"><StatusBadge tone={campaignStatusTone(status)}>{campaignStatusLabel(status)}</StatusBadge>{statusHelper ? <small>{statusHelper}</small> : null}</span>
            <div className="campaign-actions">
              <span className="inbox-tool-buttons">
                {status === "draft" ? <RowAction label="Publish" icon={Send} disabled={isBusy} onClick={() => void act(campaign, "publish")} /> : null}
                {canPauseCampaign(campaign) ? <RowAction label="Pause" icon={Pause} disabled={isBusy} onClick={() => void act(campaign, "pause")} /> : null}
                {canResumeCampaign(campaign) ? <RowAction label="Resume" icon={Play} disabled={isBusy} onClick={() => void act(campaign, "resume")} /> : null}
                {status === "finished" && campaign.campaignId ? <RowAction label="Send to new leads" icon={UserPlus} disabled={isBusy} onClick={() => void act(campaign, "launch")} /> : null}
                <RowAction label="Duplicate" icon={Copy} disabled={isBusy} onClick={() => void act(campaign, "duplicate")} />
                {(status === "draft" || status === "paused" || status === "finished") ? <RowAction label="Archive" icon={Archive} disabled={isBusy} onClick={() => void act(campaign, "archive")} /> : null}
                {status !== "finished" ? <RowAction danger label="Delete" icon={Trash2} disabled={isBusy} onClick={() => void deleteCampaign(campaign)} /> : null}
              </span>
            </div>
          </div>;
        })}
      </div> : <div className="polish-filter-empty"><p>{filter === "Needs attention" ? "Every campaign has a clear sending path." : `${filter} campaigns will appear here.`}</p><button type="button" onClick={() => setFilter("All")}>Show all campaigns</button></div>}
    </Card>}
  </div>;
}
