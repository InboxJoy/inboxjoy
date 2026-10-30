"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { useSearchParams } from "next/navigation";
import { Button, Card, EmptyState, labelStatus, PageHeader, ProgressBar, StatusBadge } from "@inboxjoy/ui";
import { apiErrorMessage, apiFetch } from "@/lib/api";
import { AppDialog } from "@/components/app-dialog";
import { Toast } from "@/components/toast";
import { track } from "@/lib/analytics";
import { Mail, PlugZap } from "lucide-react";
import { mailboxProviderLabels, type MailboxProvider, type SmtpConnectionInfo } from "@/lib/smtp-mailbox-form";
import { AddSmtpMailboxModal } from "./add-smtp-mailbox-modal";

type Inbox = {
  id: string;
  provider: MailboxProvider;
  email: string | null;
  displayName?: string;
  smtp?: SmtpConnectionInfo;
  imap?: SmtpConnectionInfo;
  status: "connecting" | "active" | "expired" | "paused" | "error" | "disconnected";
  dailyLimit: number;
  hourlyLimit: number;
  sentToday: number;
  timezone: string;
  rampStartedOn: string | null;
  skipWarmup: boolean;
  warmupPercent: number;
  warmupCapToday?: number;
  warmupFullOn?: string | null;
  warmupPaused?: boolean;
  healthState?: string;
  bounceRate?: number;
  lastHealthCheckAt: string | null;
};

// Warm-up progress and mailbox health are two different things, and the badge has
// to say which one is holding a mailbox back. A ramp at 100% is finished -- it
// cannot be "paused" -- but the mailbox can still be blocked on health, so
// reporting "Full speed" there would be wrong too.
function warmupDetail(inbox: Inbox): string {
  const rate = inbox.bounceRate ?? 0;
  const bounceNote = rate > 0 ? ` — ${rate}% bounce rate` : "";

  if (inbox.healthState === "critical") return `Sending held — mailbox health critical${bounceNote}`;
  if (inbox.healthState === "auth_error" || inbox.healthState === "disconnected") return "Sending held — reconnect this mailbox";
  if (inbox.healthState === "throttled") return "Sending throttled — provider pushed back";

  if (inbox.warmupPercent >= 100) {
    return inbox.healthState === "degraded" ? `Half volume — mailbox health degraded${bounceNote}` : "Full speed";
  }

  if (inbox.warmupPaused) return `Ramp paused — today does not count${bounceNote}`;

  const full = inbox.warmupFullOn
    ? ` · full ${new Date(`${inbox.warmupFullOn}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
    : "";
  return `${inbox.warmupCapToday ?? "—"}/day today${full}`;
}

type SendingSchedule = {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  timezone: string;
  isActive: boolean;
};

type EditorKind = "safety" | "window";

type OpenEditor = {
  inboxId: string;
  kind: EditorKind;
};

const defaultActiveDays = [1, 2, 3, 4, 5];
const weekDays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function inboxTone(status: Inbox["status"]): "neutral" | "good" | "warning" | "danger" {
  if (status === "active") return "good";
  if (status === "expired") return "danger";
  if (status === "error") return "warning";
  return "neutral";
}

function inboxStatusLabel(status: Inbox["status"]) {
  return status === "expired" ? "Reconnect needed" : labelStatus(status);
}

function relativeTime(value: string | null) {
  if (!value) return "Health check pending";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "Health check pending";
  const minutes = Math.max(1, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 60) return `Checked ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Checked ${hours}h ago`;
  return `Checked ${Math.round(hours / 24)}d ago`;
}

function actionNotice(action: "reconnect" | "disconnect" | "pause" | "resume" | "verify") {
  if (action === "verify") return "Connection checked. Mailbox is connected.";
  if (action === "disconnect") return "Mailbox disconnected.";
  if (action === "pause") return "Mailbox paused.";
  if (action === "resume") return "Mailbox resumed.";
  return "Mailbox reconnected.";
}

function InboxesContent() {
  const searchParams = useSearchParams();
  const connectMenuRef = useRef<HTMLDivElement | null>(null);
  const trackedConnectionResult = useRef<string | null>(null);
  const [inboxes, setInboxes] = useState<Inbox[]>([]);
  const [showConnect, setShowConnect] = useState(false);
  const [smtpEnabled, setSmtpEnabled] = useState(false);
  const [smtpEditor, setSmtpEditor] = useState<{ mailbox?: Inbox } | null>(null);
  const [openEditor, setOpenEditor] = useState<OpenEditor | null>(null);
  const [busyId, setBusyId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [schedules, setSchedules] = useState<Record<string, SendingSchedule[]>>({});

  const connectionResult = searchParams.get("connect");
  const connectionBanner = connectionResult === "gmail" || connectionResult === "outlook"
    ? { tone: "success", title: `${connectionResult === "gmail" ? "Gmail" : "Outlook"} connected`, message: "Your mailbox is ready. You can now use it as a campaign sender." }
    : connectionResult === "needs-attention"
      ? { tone: "warning", title: "Mailbox connected — reply detection needs attention", message: "Sending is available, but inbound reply detection could not be set up. Reconnect the mailbox so replies can automatically stop follow-ups." }
      : connectionResult === "failed"
        ? { tone: "error", title: "Mailbox connection failed", message: "The connection was canceled or could not be completed. Try again and approve the requested mailbox access." }
        : null;

  useEffect(() => {
    if (!connectionResult || trackedConnectionResult.current === connectionResult) return;
    trackedConnectionResult.current = connectionResult;
    if (connectionResult === "gmail" || connectionResult === "outlook" || connectionResult === "needs-attention") {
      track("mailbox_connect_succeeded");
    } else if (connectionResult === "failed") {
      track("mailbox_connect_failed");
    }
    const url = new URL(window.location.href);
    url.searchParams.delete("connect");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [connectionResult]);

  const refreshInboxes = useCallback(async () => {
    const data = await apiFetch<{ inboxes: Inbox[]; features?: { smtp?: boolean } }>("/v1/inboxes", {}, "Could not load mailboxes.");
    setInboxes(data.inboxes);
    setSmtpEnabled(data.features?.smtp === true);
    const results = await Promise.all(data.inboxes.map(async (inbox) => {
      const scheduleData = await apiFetch<{ schedules: SendingSchedule[] }>(`/v1/inboxes/${inbox.id}/schedules`, {}, "Could not load this mailbox's sending window.").catch(() => ({ schedules: [] }));
      return [inbox.id, scheduleData.schedules] as const;
    }));
    setSchedules(Object.fromEntries(results));
  }, []);

  useEffect(() => {
    void refreshInboxes()
      .catch((reason) => setError(apiErrorMessage(reason, "Could not load mailboxes.")))
      .finally(() => setLoading(false));
  }, [refreshInboxes]);

  useEffect(() => {
    if (!showConnect) return undefined;

    function handlePointerDown(event: PointerEvent) {
      if (!(event.target instanceof Node)) return;
      if (connectMenuRef.current?.contains(event.target)) return;
      setShowConnect(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setShowConnect(false);
    }

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [showConnect]);

  const totals = useMemo(() => ({
    active: inboxes.filter((inbox) => inbox.status === "active").length,
    sentToday: inboxes.reduce((sum, inbox) => sum + inbox.sentToday, 0),
    dailyCapacity: inboxes.reduce((sum, inbox) => sum + inbox.dailyLimit, 0),
  }), [inboxes]);
  const editedInbox = openEditor ? inboxes.find((inbox) => inbox.id === openEditor.inboxId) ?? null : null;
  const editedInboxSchedules = editedInbox ? schedules[editedInbox.id] ?? [] : [];
  const editedSendingWindow = editedInboxSchedules[0] ?? { startTime: "09:00", endTime: "17:00", timezone: editedInbox?.timezone ?? "UTC" };
  const editedActiveDays = editedInboxSchedules.length ? new Set(editedInboxSchedules.map((item) => item.dayOfWeek)) : new Set(defaultActiveDays);

  async function connectInbox(provider: MailboxProvider) {
    setShowConnect(false);
    if (provider === "smtp") {
      if (smtpEnabled) {
        setError("");
        setNotice("");
        setOpenEditor(null);
        setSmtpEditor({});
      }
      return;
    }
    setBusyId(`connect-${provider}`);
    setError("");
    try {
      const data = await apiFetch<{ connectUrl: string }>("/v1/inboxes/connect-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider }) }, "Could not start the mailbox connection.");
      track("mailbox_connect_started");
      window.location.assign(data.connectUrl);
    } catch (reason) {
      track("mailbox_connect_failed");
      setError(apiErrorMessage(reason, "Could not start the mailbox connection."));
    } finally {
      setBusyId("");
    }
  }

  async function updateInbox(id: string, changes: { dailyLimit?: number; hourlyLimit?: number; timezone?: string; skipWarmup?: boolean }, options: { closeEditor?: boolean; notice?: string } = {}) {
    const { closeEditor = true, notice: successNotice = "Mailbox settings saved." } = options;
    setBusyId(`${id}-settings`);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch<{ inbox: Inbox }>(`/v1/inboxes/${id}/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(changes) }, "Could not update mailbox settings.");
      setInboxes((current) => current.map((item) => item.id === id ? data.inbox : item));
      if (closeEditor) setOpenEditor(null);
      setNotice(successNotice);
    } catch (reason) {
      setError(apiErrorMessage(reason, "Could not update mailbox settings."));
    } finally {
      setBusyId("");
    }
  }

  async function inboxAction(id: string, action: "reconnect" | "disconnect" | "pause" | "resume" | "verify") {
    setBusyId(`${id}-${action}`);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch<{ connectUrl?: string; inbox: Inbox }>(`/v1/inboxes/${id}/${action}`, { method: "POST" }, `Could not ${action} this mailbox.`);
      if (data.connectUrl) {
        if (action === "reconnect") track("mailbox_connect_started");
        window.location.assign(data.connectUrl);
      }
      else setInboxes((current) => current.map((item) => item.id === id ? data.inbox : item));
      setNotice(actionNotice(action));
    } catch (reason) {
      if (action === "reconnect") track("mailbox_connect_failed");
      setError(apiErrorMessage(reason, `Could not ${action} this mailbox.`));
      if (action === "verify") void refreshInboxes().catch(() => undefined);
    } finally {
      setBusyId("");
    }
  }

  async function deleteInbox(event: MouseEvent<HTMLButtonElement>, inbox: Inbox) {
    event.preventDefault();
    event.stopPropagation();
    const name = inbox.email ?? inbox.displayName;
    if (!window.confirm(`Delete ${name}? It stops sending right away and is removed from InboxJoy. Emails already sent and their replies are kept. Leads it already emailed get no more follow-ups; leads still waiting for their first email move to the campaign's other mailboxes.`)) return;
    setOpenEditor(null);
    setBusyId(`${inbox.id}-delete`);
    setError("");
    setNotice("");
    try {
      await apiFetch(`/v1/inboxes/${inbox.id}`, { method: "DELETE" }, "Could not delete this mailbox.");
      setInboxes((current) => current.filter((item) => item.id !== inbox.id));
      setNotice("Mailbox deleted.");
    } catch (reason) {
      setError(apiErrorMessage(reason, "Could not delete this mailbox."));
    } finally {
      setBusyId("");
    }
  }

  async function saveSchedule(id: string, form: HTMLFormElement, fallbackTimezone: string) {
    const data = new FormData(form);
    const timezone = String(data.get("scheduleTimezone") || fallbackTimezone);
    const startTime = String(data.get("scheduleStart") || "09:00");
    const endTime = String(data.get("scheduleEnd") || "17:00");
    const nextSchedules = Array.from({ length: 7 }, (_, dayOfWeek) => data.get(`scheduleDay-${dayOfWeek}`) ? { dayOfWeek, startTime, endTime, timezone, isActive: true } : null).filter((item): item is SendingSchedule => item !== null);
    setBusyId(`${id}-schedule`);
    setError("");
    setNotice("");
    try {
      const responseData = await apiFetch<{ schedules: SendingSchedule[] }>(`/v1/inboxes/${id}/schedules`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ schedules: nextSchedules }) }, "Could not update the sending window.");
      setSchedules((current) => ({ ...current, [id]: responseData.schedules }));
      setOpenEditor(null);
      setNotice("Sending window saved.");
    } catch (reason) {
      setError(apiErrorMessage(reason, "Could not update the sending window."));
    } finally {
      setBusyId("");
    }
  }

  function toggleEditor(event: MouseEvent<HTMLButtonElement>, inboxId: string, kind: EditorKind) {
    event.preventDefault();
    event.stopPropagation();

    setOpenEditor((current) => current?.inboxId === inboxId && current.kind === kind
      ? null
      : { inboxId, kind });
  }

  function runInboxAction(event: MouseEvent<HTMLButtonElement>, inbox: Inbox, action: "reconnect" | "disconnect" | "pause" | "resume" | "verify") {
    event.preventDefault();
    event.stopPropagation();

    if (action === "disconnect" && !window.confirm("Disconnect this mailbox? Active campaigns stop sending from it.")) return;
    setOpenEditor(null);
    if (action === "reconnect" && inbox.provider === "smtp") {
      if (smtpEnabled) {
        setError("");
        setNotice("");
        setSmtpEditor({ mailbox: inbox });
      }
      return;
    }
    void inboxAction(inbox.id, action);
  }

  return <div className="page-stack inboxes-page dashboard-polish-page">
    <PageHeader
      eyebrow="Deliverability"
      title="Mailboxes"
      description="Monitor sender capacity, warm-up progress, and connection health."
      action={<div className="inbox-connect-menu" ref={connectMenuRef}>
        <button
          aria-expanded={showConnect}
          aria-haspopup="menu"
          aria-label={showConnect ? "Close connect mailbox menu" : "Open connect mailbox menu"}
          className="ij-button ij-button--primary"
          onClick={(event) => {
            event.stopPropagation();
            setShowConnect((current) => !current);
          }}
          type="button"
        >
          Connect mailbox <span aria-hidden="true" className="inbox-connect-caret" title="Connect mailbox menu">▾</span>
        </button>
        {showConnect ? <div className="inbox-connect-dropdown" role="menu">
          <button
            aria-label="Connect Gmail mailbox"
            disabled={busyId.startsWith("connect-")}
            onClick={() => void connectInbox("gmail")}
            role="menuitem"
            type="button"
          >
            <img alt="" src="/brand/gmail.svg" width={18} height={14} />Gmail
          </button>
          <button
            aria-label="Connect Outlook mailbox"
            disabled={busyId.startsWith("connect-")}
            onClick={() => void connectInbox("outlook")}
            role="menuitem"
            type="button"
          >
            <img alt="" src="/brand/outlook.svg" width={17} height={17} />Outlook
          </button>
          {smtpEnabled ? <button
            aria-label="Connect SMTP/IMAP mailbox"
            disabled={busyId.startsWith("connect-")}
            onClick={() => void connectInbox("smtp")}
            role="menuitem"
            type="button"
          >
            <Mail aria-hidden="true" size={18} />SMTP/IMAP
          </button> : null}
        </div> : null}
      </div>}
    />
    {connectionBanner ? <Card className={`page-message page-message--${connectionBanner.tone} inbox-connect-result`}>
      <div>
        <strong>{connectionBanner.title}</strong>
        <p role={connectionBanner.tone === "error" ? "alert" : "status"}>{connectionBanner.message}</p>
      </div>
      {connectionBanner.tone !== "success" ? <Button variant="secondary" onClick={() => setShowConnect(true)}>Retry connection</Button> : null}
    </Card> : null}
    {error ? <Toast tone="error" message={error} onDismiss={() => setError("")} /> : null}
    {notice ? <Toast tone="success" message={notice} onDismiss={() => setNotice("")} /> : null}

    <div className="polish-kpi-grid polish-kpi-grid--three">
      <Card className="polish-kpi-card"><span className="polish-mono-label">Configured mailboxes</span><strong>{inboxes.length}</strong><span className="polish-kpi-helper">{totals.active} active</span></Card>
      <Card className="polish-kpi-card"><span className="polish-mono-label">Sent today</span><strong>{totals.sentToday.toLocaleString()}</strong><span className="polish-kpi-helper">Across all senders</span></Card>
      <Card className="polish-kpi-card"><span className="polish-mono-label">Daily capacity</span><strong>{totals.dailyCapacity.toLocaleString()}</strong><span className="polish-kpi-helper">Configured messages per day</span></Card>
    </div>

    {loading ? <Card className="campaign-loading"><p>Loading mailboxes…</p></Card> : inboxes.length ? <Card className="polish-table-card inbox-accounts-card">
      <div className="polish-card-heading"><div><h2>Sending accounts</h2><p>Warm-up and volume are calculated from each connected mailbox.</p></div></div>
      <div className="inbox-account-table" role="table" aria-label="Sending accounts">
        <div className="inbox-account-grid polish-table-head" role="row"><span>Account</span><span>Warm-up</span><span>Volume</span><span>Status</span><span>Actions</span></div>
        {inboxes.map((inbox) => {
          const inboxSchedules = schedules[inbox.id] ?? [];
          const sendingWindow = inboxSchedules[0] ?? { startTime: "09:00", endTime: "17:00", timezone: inbox.timezone };
          const isBusy = busyId.startsWith(`${inbox.id}-`);
          const isSafetyOpen = openEditor?.inboxId === inbox.id && openEditor.kind === "safety";
          const isWindowOpen = openEditor?.inboxId === inbox.id && openEditor.kind === "window";

          return <div className="inbox-account" key={inbox.id}>
            <div className="inbox-account-grid" role="row">
              <span className="ph-mask">
                <strong>{inbox.email ?? "Address pending — reconnect"}</strong>
                <small>{mailboxProviderLabels[inbox.provider]} · {inbox.timezone}</small>
              </span>
              <span className="inbox-warmup-cell" data-label="Warm-up">
                <span className="polish-mono-value">{inbox.warmupPercent}%{inbox.warmupPaused && inbox.warmupPercent < 100 ? <em className="inbox-warmup-paused">paused</em> : null}</span>
                <ProgressBar label="Mailbox warm-up progress" value={inbox.warmupPercent} />
                <small className="inbox-warmup-detail">{warmupDetail(inbox)}</small>
              </span>
              <span data-label="Volume">{inbox.sentToday}/{inbox.dailyLimit}<small>{inbox.hourlyLimit}/hour</small></span>
              <span className="inbox-status-cell" data-label="Status"><StatusBadge tone={inboxTone(inbox.status)}>{inboxStatusLabel(inbox.status)}</StatusBadge><small>{relativeTime(inbox.lastHealthCheckAt)}</small></span>
              <span className="inbox-actions">
                <span className="inbox-tool-buttons">
                  <button
                    aria-label="Safety settings"
                    aria-expanded={isSafetyOpen}
                    className="inbox-tool-btn"
                    data-tooltip={`Safety · ${inbox.dailyLimit}/day · ${inbox.hourlyLimit}/hr`}
                    type="button"
                    onClick={(event) => toggleEditor(event, inbox.id, "safety")}
                  >
                    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" viewBox="0 0 24 24"><path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3Z" /><path d="M9.5 12l1.8 1.8 3.4-3.6" /></svg>
                  </button>
                  <button
                    aria-label="Sending window"
                    aria-expanded={isWindowOpen}
                    className="inbox-tool-btn"
                    data-tooltip={`${sendingWindow.startTime}–${sendingWindow.endTime}`}
                    type="button"
                    onClick={(event) => toggleEditor(event, inbox.id, "window")}
                  >
                    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.2 2" /></svg>
                  </button>
                  <i className="inbox-tool-divider" />
                  <button
                    aria-label={inbox.status === "paused" ? "Resume sending" : "Pause sending"}
                    className="inbox-tool-btn"
                    data-tooltip={inbox.status === "paused" ? "Resume sending" : "Pause sending"}
                    disabled={isBusy || inbox.status === "disconnected"}
                    type="button"
                    onClick={(event) => runInboxAction(event, inbox, inbox.status === "paused" ? "resume" : "pause")}
                  >
                    {inbox.status === "paused" ? <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" viewBox="0 0 24 24"><path d="m8 5 11 7-11 7V5Z" /></svg> : <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" viewBox="0 0 24 24"><path d="M9 5v14M15 5v14" /></svg>}
                  </button>
                  <button
                    aria-label="Reconnect"
                    className="inbox-tool-btn"
                    data-tooltip={inbox.provider === "smtp" ? smtpEnabled ? "Reconnect" : "SMTP/IMAP connections are unavailable" : inbox.status === "active" && inbox.email ? "Already connected" : "Reconnect"}
                    disabled={isBusy || (inbox.provider === "smtp" ? !smtpEnabled : inbox.status === "active" && Boolean(inbox.email))}
                    type="button"
                    onClick={(event) => runInboxAction(event, inbox, "reconnect")}
                  >
                    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 6.3" /><path d="M20 5v6h-6" /></svg>
                  </button>
                  {inbox.provider === "smtp" && smtpEnabled ? <button
                    aria-label="Check connection"
                    className="inbox-tool-btn"
                    data-tooltip={inbox.status === "paused" || inbox.status === "disconnected" ? "Resume or reconnect before checking" : "Check connection"}
                    disabled={isBusy || inbox.status === "paused" || inbox.status === "disconnected"}
                    type="button"
                    onClick={(event) => runInboxAction(event, inbox, "verify")}
                  >
                    <PlugZap aria-hidden="true" size={18} />
                  </button> : null}
                  <button
                    aria-label="Delete mailbox"
                    className="inbox-tool-btn inbox-tool-btn--danger"
                    data-tooltip="Delete mailbox"
                    disabled={isBusy}
                    type="button"
                    onClick={(event) => void deleteInbox(event, inbox)}
                  >
                    <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6.5 7l.8 13h9.4l.8-13M10 11v5M14 11v5" /></svg>
                  </button>
                </span>
              </span>
            </div>
          </div>;
        })}
      </div>
    </Card> : <EmptyState title="No mailboxes connected" description={smtpEnabled ? "Connect Gmail, Outlook, or another email account to create your first sender." : "Connect Gmail or Outlook to create your first sender."} action={<Button onClick={() => setShowConnect(true)}>Connect your first mailbox</Button>} />}
    {smtpEditor ? <AddSmtpMailboxModal
      key={smtpEditor.mailbox?.id ?? "new-smtp"}
      mailbox={smtpEditor.mailbox}
      onClose={() => setSmtpEditor(null)}
      onConnected={() => {
        setSmtpEditor(null);
        setNotice("Mailbox connected");
        void refreshInboxes().catch((reason) => setError(apiErrorMessage(reason, "Mailbox connected, but the list could not refresh. Reload the page.")));
      }}
    /> : null}
    {editedInbox && openEditor?.kind === "safety" ? <form className="inbox-editor-form" onSubmit={(event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      void updateInbox(editedInbox.id, { dailyLimit: Number(form.get("dailyLimit")), hourlyLimit: Number(form.get("hourlyLimit")), timezone: String(form.get("timezone")) });
    }}>
      <AppDialog
        actions={<Button type="submit" disabled={busyId.startsWith(`${editedInbox.id}-`)}>Save settings</Button>}
        onClose={() => setOpenEditor(null)}
        title="Safety settings"
      >
        <div className="inbox-field-grid">
          <label>Daily limit<span className="inbox-field"><input name="dailyLimit" type="number" min="1" max="200" defaultValue={editedInbox.dailyLimit} /><i>emails/day</i></span></label>
          <label>Hourly limit<span className="inbox-field"><input name="hourlyLimit" type="number" min="1" max="50" defaultValue={editedInbox.hourlyLimit} /><i>emails/hr</i></span></label>
          <label className="inbox-field-wide">Timezone<span className="inbox-field"><input name="timezone" defaultValue={editedInbox.timezone} /></span></label>
        </div>
        <label className="inbox-warmup-toggle">
          <input
            checked={editedInbox.rampStartedOn === null}
            disabled={busyId.startsWith(`${editedInbox.id}-`)}
            onChange={(event) => void updateInbox(editedInbox.id, { skipWarmup: event.currentTarget.checked }, { closeEditor: false, notice: "Warm-up setting saved." })}
            type="checkbox"
          />
          <span><strong>This mailbox is already warmed up — send at full speed</strong><small>Use only for mailboxes with stable sending history. Turn it off to restart the ramp today.</small></span>
        </label>
      </AppDialog>
    </form> : null}
    {editedInbox && openEditor?.kind === "window" ? <form className="inbox-editor-form" onSubmit={(event) => {
      event.preventDefault();
      void saveSchedule(editedInbox.id, event.currentTarget, editedInbox.timezone);
    }}>
      <AppDialog
        actions={<Button type="submit" disabled={busyId.startsWith(`${editedInbox.id}-`)}>Save sending window</Button>}
        onClose={() => setOpenEditor(null)}
        title="Sending window"
      >
        <div className="inbox-days">{weekDays.map((name, dayOfWeek) => <label className="inbox-day-pill" key={name}><input name={`scheduleDay-${dayOfWeek}`} type="checkbox" defaultChecked={editedActiveDays.has(dayOfWeek)} /><span>{name}</span></label>)}</div>
        <div className="inbox-field-grid">
          <label>Start<span className="inbox-field"><input name="scheduleStart" type="time" defaultValue={editedSendingWindow.startTime} /></span></label>
          <label>End<span className="inbox-field"><input name="scheduleEnd" type="time" defaultValue={editedSendingWindow.endTime} /></span></label>
          <label className="inbox-field-wide">Timezone<span className="inbox-field"><input name="scheduleTimezone" defaultValue={editedSendingWindow.timezone} /></span></label>
        </div>
      </AppDialog>
    </form> : null}
  </div>;
}

export default function InboxesPage() {
  return <Suspense fallback={<div className="page-stack inboxes-page dashboard-polish-page"><Card className="campaign-loading"><p>Loading mailboxes…</p></Card></div>}><InboxesContent /></Suspense>;
}
