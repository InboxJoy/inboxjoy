"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, PageHeader, StatCard, StatusBadge } from "@inboxjoy/ui";
import Link from "next/link";
import { apiErrorMessage, apiFetch } from "@/lib/api";
import { OPEN_TRACKING_SETTINGS_HREF, useOpenTrackingEnabled } from "@/components/open-tracking";

type Range = 7 | 30 | 90;
type DailyMetric = { date: string; sent: number; replied: number; opened: number; humanOpened: number; bounced: number };
type Summary = { sent?: number; replied?: number; opened?: number; humanOpened?: number; botOpened?: number; bounced?: number; softBounced?: number; unsubscribed?: number; failed?: number; replyRate?: number; openRate?: number; bounceRate?: number; unsubscribeRate?: number; bySequence?: Array<{ sequenceId: string; name: string; sent: number; replied: number; unsubscribed: number; unsubscribeRate: number }>; series?: DailyMetric[] };
const number = (value: unknown) => typeof value === "number" ? value : 0;

function unsubscribeTone(rate: number): "neutral" | "warning" | "danger" {
  if (rate > 2) return "danger";
  if (rate >= 0.5) return "warning";
  return "neutral";
}

function UnsubscribeRate({ rate }: { rate: number }) {
  return <span className="unsubscribe-rate"><StatusBadge tone={unsubscribeTone(rate)}>{rate.toFixed(1)}%</StatusBadge>{rate > 2 ? <small>High opt-out rate. Review targeting and copy before sending more.</small> : null}</span>;
}

export default function AnalyticsPage() {
  const [summary, setSummary] = useState<Summary>({});
  const [range, setRange] = useState<Range>(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const openTrackingOff = useOpenTrackingEnabled() === false;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    apiFetch<{ summary?: Summary } & Summary>(`/v1/analytics/summary?range=${range}`, {}, "Analytics are temporarily unavailable.")
      .then((data) => data.summary ?? data)
      .then((data) => { if (active) setSummary(data); })
      .catch((reason) => { if (active) setError(apiErrorMessage(reason, "Analytics are temporarily unavailable.")); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [range]);

  const rows = summary.bySequence ?? [];
  const series = summary.series ?? [];
  const maxReplies = useMemo(() => Math.max(1, ...series.map((day) => number(day.replied))), [series]);
  const maxOpens = useMemo(() => Math.max(1, ...series.map((day) => number(day.humanOpened))), [series]);
  const labelEvery = range === 7 ? 1 : range === 30 ? 5 : 15;

  return <div className="page-stack analytics-page">
    <PageHeader eyebrow="Performance" title="Analytics" description="Measure sent, opened, replied, bounced, unsubscribed, and failed outcomes from your live sending data." />
    {error ? <Card className="page-message page-message--error"><p role="alert">{error}</p></Card> : null}
    <div className="stat-grid analytics-stat-grid"><StatCard label="Reply rate" value={loading ? "—" : `${number(summary.replyRate).toFixed(1)}%`} helper={loading ? "Loading analytics…" : "Across the selected period"} tone="good" />{openTrackingOff ? <StatCard label="Open rate" value="Off" helper="Open tracking is off · Settings → Sending" /> : <StatCard label="Open rate" value={loading ? "—" : `${number(summary.openRate).toFixed(1)}%`} helper={loading ? "Loading analytics…" : number(summary.botOpened) > 0 ? `${number(summary.botOpened)} automated` : `${number(summary.humanOpened)} human opens`} tone="good" />}<StatCard label="Bounce rate" value={loading ? "—" : `${number(summary.bounceRate).toFixed(1)}%`} helper={loading ? "Loading analytics…" : `${number(summary.bounced)} bounced${number(summary.softBounced) > 0 ? ` · ${number(summary.softBounced)} soft/deferred` : ""}`} tone="info" /><StatCard label="Unsubscribe rate" value={loading ? "—" : `${number(summary.unsubscribeRate).toFixed(1)}%`} helper={loading ? "Loading analytics…" : number(summary.unsubscribeRate) > 2 ? `${number(summary.unsubscribed)} suppressed · high opt-out rate` : `${number(summary.unsubscribed)} suppressed`} /><StatCard label="Failed sends" value={loading ? "—" : String(number(summary.failed))} helper={loading ? "Loading analytics…" : `${number(summary.sent)} total sent`} tone="warning" /></div>
    <Card className="analytics-replies-card">
      <div className="card-header analytics-chart-header"><div><h2>Replies over time</h2><p>Daily replies across the selected reporting window.</p></div><div className="analytics-range-chips" aria-label="Analytics range">{([7, 30, 90] as const).map((value) => <button aria-pressed={range === value} key={value} onClick={() => setRange(value)} type="button">{value}d</button>)}</div></div>
      {loading && !series.length ? <div className="analytics-chart-empty">Loading reply activity…</div> : series.length ? <div className="analytics-bar-chart" role="img" aria-label={`Replies per day over the last ${range} days`}>{series.map((day, index) => { const height = day.replied ? Math.max(8, (day.replied / maxReplies) * 100) : 2; const showLabel = index % labelEvery === 0 || index === series.length - 1; return <div className="analytics-bar-column" key={day.date} title={`${day.date}: ${day.replied} replies`}><div className="analytics-bar-value">{day.replied || ""}</div><div className="analytics-bar-track"><span style={{ height: `${height}%` }} /></div><time dateTime={day.date}>{showLabel ? new Date(`${day.date}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }) : ""}</time></div>; })}</div> : <div className="analytics-chart-empty branded-empty-copy">No reply activity yet.</div>}
    </Card>
    <Card className="analytics-replies-card">
      <div className="card-header analytics-chart-header"><div><h2>Human opens over time</h2><p>Daily opens excluding detected automation.</p></div></div>
      {openTrackingOff ? <div className="analytics-chart-empty branded-empty-copy"><p>Open tracking is off, so new emails aren&apos;t counted.</p><Link href={OPEN_TRACKING_SETTINGS_HREF}>Turn it on in Settings</Link></div> : loading && !series.length ? <div className="analytics-chart-empty">Loading open activity…</div> : series.length ? <div className="analytics-bar-chart" role="img" aria-label={`Human opens per day over the last ${range} days`}>{series.map((day, index) => { const height = day.humanOpened ? Math.max(8, (day.humanOpened / maxOpens) * 100) : 2; const showLabel = index % labelEvery === 0 || index === series.length - 1; return <div className="analytics-bar-column" key={day.date} title={`${day.date}: ${day.humanOpened} human opens`}><div className="analytics-bar-value">{day.humanOpened || ""}</div><div className="analytics-bar-track"><span style={{ height: `${height}%` }} /></div><time dateTime={day.date}>{showLabel ? new Date(`${day.date}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }) : ""}</time></div>; })}</div> : <div className="analytics-chart-empty branded-empty-copy">No human open activity yet.</div>}
    </Card>
    <Card className="analytics-performance-card"><div className="card-header"><div><h2>Last {range} days</h2><p>Metrics update as delivery events are recorded.</p></div></div>{rows.length ? <div className="analytics-sequence-list">{rows.map((row) => <div className="analytics-sequence-row" key={row.sequenceId}><span><strong>{row.name}</strong><small>{row.sent} sent · {row.replied} replied · {row.unsubscribed} unsubscribed</small></span><span className="analytics-sequence-rates"><span>{number(row.sent) ? ((number(row.replied) / number(row.sent)) * 100).toFixed(1) : "0.0"}% reply rate</span><span className="analytics-sequence-unsubscribe"><small>Unsub rate</small><UnsubscribeRate rate={number(row.unsubscribeRate)} /></span></span></div>)}</div> : <p className="analytics-empty-copy branded-empty-copy">No delivery data yet. Publish a sequence and enroll a few leads to begin measuring results.</p>}</Card>
  </div>;
}
