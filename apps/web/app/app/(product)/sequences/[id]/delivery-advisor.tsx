"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button, Card, formatDateTime, labelStatus, StatusBadge } from "@inboxjoy/ui";
import { apiFetch } from "@/lib/api";
import {
  blockingFindings,
  findingTone,
  formatCapacity,
  formatLastChecked,
  mapDeliveryAdvisorResponse,
  navigationHref,
  recordedFindings,
  type DeliveryAdvisorContentState,
  type DeliveryAdvisorResponse,
} from "./delivery-advisor-state";

// Phase 1A delivery advisor card (docs/delivery-advisor-plan.md). Fetches
// independently of the campaign's own required load, renders nothing until
// availability is positively known, and never blocks or disables the
// existing launch/pause/resume/archive controls on this page.
export function DeliveryAdvisorCard({ campaignId, refreshToken = 0 }: { campaignId?: string; refreshToken?: number }) {
  const [content, setContent] = useState<DeliveryAdvisorContentState>({ kind: "hidden" });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const requestRef = useRef(0);
  const contentRef = useRef(content);
  contentRef.current = content;

  const load = async (isRefresh: boolean) => {
    if (!campaignId) {
      setContent({ kind: "hidden" });
      setLoading(false);
      return;
    }
    const requestId = ++requestRef.current;
    if (isRefresh) setRefreshing(true); else setLoading(true);
    try {
      const response = await apiFetch<DeliveryAdvisorResponse>(`/v1/campaigns/${campaignId}/delivery-advisor`, {}, "Could not load the delivery advisor.");
      if (requestId !== requestRef.current) return;
      setContent(mapDeliveryAdvisorResponse(response, contentRef.current));
    } catch {
      if (requestId !== requestRef.current) return;
      setContent(mapDeliveryAdvisorResponse({ transportError: true }, contentRef.current));
    } finally {
      if (requestId === requestRef.current) { setLoading(false); setRefreshing(false); }
    }
  };

  useEffect(() => {
    setContent({ kind: "hidden" });
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId]);

  useEffect(() => {
    if (refreshToken === 0) return;
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  if (content.kind === "hidden") {
    // Covers both "not enabled for this workspace" and "we don't yet know,
    // and a transport failure must not guess" — in neither case does a card
    // belong on the page.
    return null;
  }

  const snapshot = content.kind === "ready" ? content.snapshot : content.staleSnapshot;
  if (!snapshot) {
    // Confirmed enabled, but we have never successfully fetched a snapshot
    // (first load failed after enabling). Show a minimal retry affordance
    // rather than nothing, without implying any delivery state.
    return <Card className="advisor-card advisor-card--empty">
      <div className="advisor-card-heading">
        <h2>Delivery advisor</h2>
        <span className="advisor-last-checked">{formatLastChecked(null)}</span>
      </div>
      <p className="advisor-unavailable-text" role="alert">Could not load delivery details right now.</p>
      <Button variant="ghost" disabled={loading || refreshing} onClick={() => void load(true)}>{refreshing ? "Checking…" : "Retry"}</Button>
    </Card>;
  }

  const blockers = blockingFindings(snapshot.findings);
  const isStale = content.kind === "unavailable";
  const lastChecked = content.kind === "ready" ? snapshot.asOf : content.lastCheckedAt;

  return <Card className="advisor-card">
    <div className="advisor-card-heading">
      <div>
        <h2>Delivery advisor</h2>
        <p>{snapshot.campaign.name}</p>
      </div>
      <div className="advisor-card-actions">
        <span className="advisor-last-checked">{formatLastChecked(lastChecked)}{isStale ? " · showing the last known reading" : ""}</span>
        <Button variant="ghost" disabled={loading || refreshing} onClick={() => void load(true)}>{refreshing ? "Checking…" : "Refresh"}</Button>
      </div>
    </div>

    {isStale ? <p className="advisor-unavailable-text" role="alert">Could not refresh just now. Showing the last known reading.</p> : null}
    {content.kind === "ready" && content.partial ? <p className="advisor-partial-text">Some details could not be determined and are shown as unknown.</p> : null}

    {blockers.length ? <ul className="advisor-findings" aria-label="Attention items">
      {blockers.map((finding) => {
        const href = navigationHref(finding.navigationTarget);
        return <li className="advisor-finding" key={finding.code}>
          <StatusBadge tone={findingTone(finding.severity)}>{finding.severity === "danger" ? "Blocking" : "Attention"}</StatusBadge>
          <span>{finding.message}</span>
          {href ? <Link className="advisor-finding-link" href={href}>Review</Link> : null}
        </li>;
      })}
    </ul> : <p className="advisor-no-blockers">No known blockers.</p>}

    {snapshot.senders.length ? <div className="advisor-senders" role="table" aria-label="Senders">
      <div className="advisor-sender-row advisor-sender-row--head" role="row"><span>Sender</span><span>Status</span><span>Pending</span><span>Daily capacity</span></div>
      {snapshot.senders.map((sender) => <div className="advisor-sender-row" key={sender.emailAccountId} role="row">
        <span data-label="Sender">{sender.email ?? sender.emailAccountId}</span>
        <span data-label="Status"><StatusBadge tone={sender.status === "active" && (!sender.healthState || sender.healthState === "healthy") ? "good" : "warning"}>{labelStatus(sender.status === "active" ? (sender.healthState ?? "healthy") : sender.status)}</StatusBadge></span>
        <span data-label="Pending">{sender.pendingEnrollments.toLocaleString()}</span>
        <span data-label="Daily capacity">{sender.capacity ? formatCapacity(sender.capacity.remainingToday, sender.capacity.warmupDailyLimit ?? sender.capacity.dailyLimit) : "Unknown"}</span>
      </div>)}
    </div> : null}

    {recordedFindings(snapshot.findings).length ? <div className="advisor-history">
      <span className="polish-mono-label">Recent history</span>
      <ul className="advisor-history-list" aria-label="Recorded history">
        {recordedFindings(snapshot.findings).map((finding) => <li className="advisor-history-item" key={`${finding.code}-${finding.observedAt}`}>
          <span>{finding.message}</span>
          <time className="advisor-history-time" dateTime={finding.observedAt}>{new Date(finding.observedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</time>
        </li>)}
      </ul>
    </div> : null}

    <div className="advisor-footer">
      <span>{snapshot.nextScheduledAt
        ? <>Next scheduled message {formatDateTime(snapshot.nextScheduledAt)}{snapshot.nextScheduledNote === "campaign_paused" ? " (campaign paused)" : snapshot.nextScheduledNote === "sequence_paused" ? " (sequence paused)" : ""}</>
        : "No pending message is recorded."}</span>
      {snapshot.workspaceCapacity ? <span className="advisor-workspace-capacity">Workspace: {formatCapacity(snapshot.workspaceCapacity.remainingToday, snapshot.workspaceCapacity.dailySendCap)} today across all campaigns</span> : null}
    </div>
  </Card>;
}
