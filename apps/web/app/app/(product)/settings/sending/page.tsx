"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { Button, Card, EmptyState, formatDateTime, labelStatus, StatusBadge } from "@inboxjoy/ui";
import { apiErrorMessage, apiFetch } from "@/lib/api";
import { Toast } from "@/components/toast";
import type { WorkspaceRole } from "../types";

type SendingData = {
  workspace: { dailySendCap: number; killSwitchEnabled: boolean; openTrackingEnabled: boolean };
  role: WorkspaceRole;
  mailboxes: Array<{ id: string; email: string | null; displayName: string | null; provider: string; status: string; healthState: string; bounceRate: number; replyRate: number; lastSuccessfulSendAt: string | null; effectiveDailyLimit: number }>;
};
type Suppression = { id: string; email: string | null; reason: string; source: string; createdAt: string };

function percentage(value: number) {
  return `${value.toFixed(value % 1 === 0 ? 0 : 1)}%`;
}

export default function SendingSettingsPage() {
  const [sending, setSending] = useState<SendingData | null>(null);
  const [dailySendCap, setDailySendCap] = useState("200");
  const [suppressions, setSuppressions] = useState<Suppression[]>([]);
  const [newEmail, setNewEmail] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    void Promise.all([
      apiFetch<SendingData>("/v1/sending", {}, "Could not load sending settings."),
      apiFetch<{ suppressions: Suppression[] }>("/v1/suppressions", {}, "Could not load suppressions."),
    ]).then(([sendingData, suppressionData]) => {
      setSending(sendingData);
      setDailySendCap(String(sendingData.workspace.dailySendCap));
      setSuppressions(suppressionData.suppressions);
    }).catch((value) => setError(apiErrorMessage(value, "Could not load sending settings.")));
  }, []);

  async function saveCap(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      const data = await apiFetch<{ workspace: SendingData["workspace"] }>("/v1/workspace", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ dailySendCap: Number(dailySendCap) }) }, "Could not save the daily send cap.");
      setSending((current) => current ? { ...current, workspace: { ...current.workspace, ...data.workspace } } : current);
      setDailySendCap(String(data.workspace.dailySendCap));
      setNotice("Daily send cap saved.");
    } catch (value) { setError(apiErrorMessage(value, "Could not save the daily send cap.")); } finally { setBusy(false); }
  }

  async function saveOpenTracking(openTrackingEnabled: boolean) {
    setBusy(true); setError(""); setNotice("");
    try {
      const data = await apiFetch<{ workspace: SendingData["workspace"] }>("/v1/workspace", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ openTrackingEnabled }) }, "Could not save open tracking.");
      setSending((current) => current ? { ...current, workspace: { ...current.workspace, ...data.workspace } } : current);
      setNotice(data.workspace.openTrackingEnabled ? "Open tracking is on for new emails." : "Open tracking is off. New emails go out without the tracking image.");
    } catch (value) { setError(apiErrorMessage(value, "Could not save open tracking.")); } finally { setBusy(false); }
  }

  async function addSuppression(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      const data = await apiFetch<{ suppression: Suppression; alreadySuppressed: boolean }>("/v1/suppressions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: newEmail, reason }) }, "Could not add suppression.");
      if (!data.alreadySuppressed) setSuppressions((current) => [data.suppression, ...current]);
      setNewEmail(""); setReason("");
      setNotice(data.alreadySuppressed ? "That address is already suppressed." : "Suppression added.");
    } catch (value) { setError(apiErrorMessage(value, "Could not add suppression.")); } finally { setBusy(false); }
  }

  async function removeSuppression(id: string) {
    setBusy(true); setError(""); setNotice("");
    try {
      await apiFetch<void>(`/v1/suppressions/${id}`, { method: "DELETE" }, "Could not remove suppression.");
      setSuppressions((current) => current.filter((item) => item.id !== id));
      setNotice("Suppression removed.");
    } catch (value) { setError(apiErrorMessage(value, "Could not remove suppression.")); } finally { setBusy(false); }
  }

  const canEdit = sending?.role !== "member";

  return <div className="settings-section-stack">
    {error ? <Toast tone="error" message={error} onDismiss={() => setError("")} /> : null}
    {notice ? <Toast tone="success" message={notice} onDismiss={() => setNotice("")} /> : null}
    <Card className="settings-card">
      <span className="polish-mono-label">Sending limits</span>
      <div className="settings-card-heading"><div><h2>Workspace daily send cap</h2><p>A hard limit shared across every connected mailbox.</p></div>{sending?.workspace.killSwitchEnabled ? <StatusBadge tone="danger">Paused</StatusBadge> : null}</div>
      <form className="settings-inline-form" onSubmit={saveCap}><label>Messages per day<input type="number" min={1} max={100000} value={dailySendCap} onChange={(event) => setDailySendCap(event.target.value)} disabled={!canEdit} /></label><Button type="submit" disabled={busy || !sending || !canEdit || Number(dailySendCap) < 1}>Save cap</Button></form>
      {!canEdit ? <p className="settings-warning">Only workspace owners and admins can change sending limits.</p> : null}
    </Card>
    <Card className="settings-card">
      <span className="polish-mono-label" id="open-tracking">Tracking</span>
      <div className="settings-card-heading"><div><h2>Open tracking</h2><p>{sending?.workspace.openTrackingEnabled ? "New emails include a tracking image, so opens are counted." : "New emails go out without a tracking image. Opens are not counted."}</p></div>{sending ? <StatusBadge tone={sending.workspace.openTrackingEnabled ? "good" : "neutral"}>{sending.workspace.openTrackingEnabled ? "On" : "Off"}</StatusBadge> : null}</div>
      <label className="settings-toggle">
        <input checked={sending?.workspace.openTrackingEnabled ?? false} disabled={busy || !sending || !canEdit} onChange={(event) => void saveOpenTracking(event.currentTarget.checked)} type="checkbox" />
        <span><strong>Track opens on new emails</strong><small>Adds a hidden image to each campaign email. Spam filters treat it as a warning sign, and Apple Mail and security scanners open emails automatically, so counts run high. Replies are tracked either way.</small></span>
      </label>
      {!canEdit ? <p className="settings-warning">Only workspace owners and admins can change open tracking.</p> : null}
    </Card>
    <Card className="settings-card settings-table-card">
      <div className="settings-card-heading"><div><span className="polish-mono-label">Mailbox health</span><h2>Connected mailboxes</h2><p>Current deliverability signals and the effective limit enforced for each mailbox.</p></div><Link className="ij-button ij-button--secondary" href="/app/inboxes">Manage mailboxes</Link></div>
      {sending?.mailboxes.length ? <div className="settings-table"><div className="settings-table-row settings-table-row--health settings-table-head"><span>Mailbox</span><span>State</span><span>Bounce</span><span>Reply</span><span>Last success</span><span>Daily limit</span></div>{sending.mailboxes.map((mailbox) => <div className="settings-table-row settings-table-row--health" key={mailbox.id}><span><strong>{mailbox.displayName || mailbox.email || "Connected mailbox"}</strong><small>{mailbox.email || labelStatus(mailbox.provider)}</small></span><span data-label="State"><StatusBadge tone={mailbox.healthState === "healthy" ? "good" : mailbox.healthState === "unknown" ? "neutral" : "warning"}>{labelStatus(mailbox.healthState)}</StatusBadge></span><span data-label="Bounce">{percentage(mailbox.bounceRate)}</span><span data-label="Reply">{percentage(mailbox.replyRate)}</span><span data-label="Last success">{formatDateTime(mailbox.lastSuccessfulSendAt, "Never")}</span><strong data-label="Daily limit">{mailbox.effectiveDailyLimit}</strong></div>)}</div> : <EmptyState title="No connected mailboxes" description="Connect Gmail or Outlook to see mailbox health and effective limits here." action={<Link className="ij-button ij-button--primary" href="/app/inboxes">Connect a mailbox</Link>} />}
    </Card>
    <Card className="settings-card suppressions-card">
      <div className="settings-card-heading"><div><span className="polish-mono-label">Suppressions</span><h2>Do-not-contact list</h2><p>Suppressed recipients are excluded from future enrollment.</p></div><StatusBadge tone="neutral">{suppressions.length}</StatusBadge></div>
      <form className="suppression-form" onSubmit={addSuppression}><input aria-label="Email address" type="email" required value={newEmail} onChange={(event) => setNewEmail(event.target.value)} placeholder="person@example.com" /><input aria-label="Reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason" /><Button type="submit" disabled={busy}>Add suppression</Button></form>
      {suppressions.length ? <div className="suppression-list">{suppressions.map((suppression) => <div className="suppression-row" key={suppression.id}><span><strong>{suppression.email ?? "Hashed recipient"}</strong><small>{labelStatus(suppression.reason)} · {labelStatus(suppression.source)}</small></span><Button variant="ghost" disabled={busy} onClick={() => void removeSuppression(suppression.id)}>Remove</Button></div>)}</div> : <EmptyState title="No suppressed recipients" description="Add an address here to prevent future campaign enrollment." />}
    </Card>
  </div>;
}
