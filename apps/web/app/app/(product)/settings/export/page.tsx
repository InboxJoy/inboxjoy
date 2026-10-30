"use client";

import { useEffect, useState, type ChangeEvent } from "react";
import { Button, Card, formatDateTime, labelStatus, StatusBadge } from "@inboxjoy/ui";
import { API_BASE_URL, ApiError, apiErrorMessage, apiFetch, workspaceRequestHeaders } from "@/lib/api";
import {
  downloadFilename,
  editionLabel,
  formatCount,
  inspectWorkspaceFile,
  invitationLink,
  notInvitedReason,
  providerLabel,
  summaryLine,
  tooLargeMessage,
  WORKSPACE_IMPORT_MAX_BYTES,
  type WorkspaceFileSummary,
  type WorkspaceImportResult,
} from "@/lib/workspace-transfer";
import type { WorkspaceResponse } from "../types";

type SelectedFile = { name: string; text: string; summary: WorkspaceFileSummary };

export default function ExportImportSettingsPage() {
  const [workspaceName, setWorkspaceName] = useState("");
  const [role, setRole] = useState<WorkspaceResponse["role"] | null>(null);
  const [busy, setBusy] = useState<"" | "export" | "read" | "import">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [fileError, setFileError] = useState("");
  const [selected, setSelected] = useState<SelectedFile | null>(null);
  const [result, setResult] = useState<WorkspaceImportResult | null>(null);

  useEffect(() => {
    void apiFetch<WorkspaceResponse>("/v1/workspace", {}, "Could not load workspace details.")
      .then((data) => { setWorkspaceName(data.workspace.name); setRole(data.role); })
      .catch((value) => setError(apiErrorMessage(value, "Could not load workspace details.")));
  }, []);

  const isOwner = role === "owner";

  async function downloadExport() {
    setBusy("export"); setError(""); setNotice("");
    try {
      const response = await fetch(`${API_BASE_URL}/v1/workspace/export`, { headers: workspaceRequestHeaders(), credentials: "include" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: unknown };
        throw new Error(typeof body.error === "string" ? body.error : "Could not export this workspace.");
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = downloadFilename(response.headers.get("content-disposition")); anchor.click();
      URL.revokeObjectURL(url);
      setNotice("Workspace export downloaded.");
    } catch (value) { setError(apiErrorMessage(value, "Could not export this workspace.")); } finally { setBusy(""); }
  }

  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setSelected(null); setFileError(""); setResult(null); setNotice(""); setError("");
    if (!file) return;
    // Size first: never read a file the server would refuse anyway.
    if (file.size > WORKSPACE_IMPORT_MAX_BYTES) { setFileError(tooLargeMessage()); return; }
    setBusy("read");
    try {
      const text = await file.text();
      const inspection = inspectWorkspaceFile(text, file.size);
      if (!inspection.ok) { setFileError(inspection.error); return; }
      setSelected({ name: file.name, text, summary: inspection.summary });
    } catch { setFileError("Could not read that file. Choose it again."); } finally { setBusy(""); }
  }

  async function runImport() {
    if (!selected) return;
    if (!window.confirm(`Import ${summaryLine(selected.summary)} into ${workspaceName || "this workspace"}? Campaigns arrive as drafts and nothing sends.`)) return;
    setBusy("import"); setError(""); setNotice("");
    try {
      const data = await apiFetch<WorkspaceImportResult>("/v1/workspace/import", { method: "POST", headers: { "content-type": "application/json" }, body: selected.text }, "Could not import this workspace file.");
      setResult(data);
      setSelected(null);
      setWorkspaceName(data.workspace.name);
      setNotice("Workspace imported. Nothing has been sent.");
    } catch (value) {
      setError(value instanceof ApiError && value.status === 413 ? tooLargeMessage() : apiErrorMessage(value, "Could not import this workspace file."));
    } finally { setBusy(""); }
  }

  const origin = typeof window === "undefined" ? "" : window.location.origin;

  return <div className="settings-section-stack">
    {error ? <Card className="page-message page-message--error"><p role="alert">{error}</p></Card> : null}
    {notice ? <Card className="page-message page-message--success"><p role="status">{notice}</p></Card> : null}

    <Card className="settings-card">
      <span className="polish-mono-label">Export</span>
      <div className="settings-card-heading"><div><h2>Download this workspace</h2><p>One JSON file you can import into a self-hosted install or into InboxJoy Cloud.</p></div></div>
      <dl className="settings-transfer-meta">
        <dt>Included</dt><dd>Workspace settings, leads and their fields, lists, suppressions, campaigns with their steps and lead variables, and teammates</dd>
        <dt>Not included</dt><dd>Mailbox connections and passwords, send history, replies, analytics, API keys and billing</dd>
      </dl>
      <div className="settings-actions"><Button disabled={!isOwner || busy !== ""} onClick={() => void downloadExport()}>{busy === "export" ? "Preparing export…" : "Download export"}</Button></div>
      {role && !isOwner ? <p className="settings-warning">Only the workspace owner can export or import this workspace.</p> : null}
    </Card>

    <Card className="settings-card">
      <span className="polish-mono-label">Import</span>
      <div className="settings-card-heading"><div><h2>Load a workspace file</h2><p>Brings an export into this workspace. It must have no leads, lists or campaigns yet. Nothing sends: campaigns arrive as drafts, and teammates get invitation links for you to share.</p></div></div>
      <div className="settings-form">
        <label><span>Workspace file (.json, up to 50 MB)</span><input type="file" accept=".json,application/json" disabled={!isOwner || busy !== ""} onChange={(event) => void chooseFile(event)} /></label>
      </div>
      {fileError ? <p className="settings-error" role="alert">{fileError}</p> : null}
      {selected ? <dl className="settings-transfer-meta" aria-label="Selected file">
        <dt>From</dt><dd><strong>{selected.summary.workspaceName}</strong>{editionLabel(selected.summary.edition) ? ` · ${editionLabel(selected.summary.edition)}` : ""}</dd>
        <dt>Exported</dt><dd>{formatDateTime(selected.summary.exportedAt)}</dd>
        <dt>Contents</dt><dd>{summaryLine(selected.summary)}</dd>
        {selected.summary.mailboxes ? <><dt>To reconnect</dt><dd>{formatCount(selected.summary.mailboxes, "mailbox", "mailboxes")} (connections never move)</dd></> : null}
      </dl> : null}
      <div className="settings-actions"><Button disabled={!isOwner || !selected || busy !== ""} onClick={() => void runImport()}>{busy === "import" ? "Importing…" : `Import into ${workspaceName || "this workspace"}`}</Button></div>
    </Card>

    {result ? <ImportResultCards result={result} origin={origin} /> : null}
  </div>;
}

function ImportResultCards({ result, origin }: { result: WorkspaceImportResult; origin: string }) {
  const { imported } = result;
  return <>
    <Card className="settings-card">
      <span className="polish-mono-label">Import complete</span>
      <div className="settings-card-heading"><div><h2>What moved</h2><p>Campaigns are drafts with no sender and no audience yet. Connect mailboxes, then pick lists and senders before you launch.</p></div>{result.kept.killSwitchEnabled ? <StatusBadge tone="warning">Sending paused</StatusBadge> : null}</div>
      <dl className="settings-transfer-meta">
        <dt>Leads</dt><dd>{formatCount(imported.leads, "lead")} in {formatCount(imported.lists, "list")}</dd>
        <dt>Campaigns</dt><dd>{formatCount(imported.sequences, "campaign")} with {formatCount(imported.steps, "step")}{result.kept.sequencesArchived ? `, ${result.kept.sequencesArchived.toLocaleString("en-US")} archived` : ""}</dd>
        <dt>Suppressions</dt><dd>{formatCount(imported.suppressions, "new suppression")}</dd>
        <dt>Invitations</dt><dd>{formatCount(imported.invitations, "pending invitation")}, none emailed</dd>
      </dl>
      {result.warnings.map((warning) => <p className="settings-warning" key={warning}>{warning}</p>)}
    </Card>

    {result.invitations.length || result.notInvited.length ? <Card className="settings-card settings-table-card">
      <div className="settings-card-heading"><div><span className="polish-mono-label">Teammates</span><h2>Share invitation links</h2><p>No email was sent. Share each link (it works for 7 days), or invite again from Team to send an email.</p></div></div>
      <div className="settings-table ph-no-capture">{result.invitations.map((invitation) => {
        const link = invitationLink(origin, invitation.token);
        return <div className="settings-table-row settings-table-row--team" key={invitation.email}>
          <span><strong>{invitation.email}</strong><small>Expires {formatDateTime(invitation.expiresAt)}</small></span>
          <span data-label="Role"><StatusBadge tone="neutral">{labelStatus(invitation.role)}</StatusBadge></span>
          <span data-label="Status">Not emailed</span>
          <Button variant="secondary" onClick={() => void navigator.clipboard.writeText(link)}>Copy link</Button>
        </div>;
      })}{result.notInvited.map((row) => <div className="settings-table-row settings-table-row--team" key={row.email}>
        <span><strong>{row.email}</strong></span>
        <span data-label="Role">—</span>
        <span data-label="Status">{notInvitedReason(row.reason)}</span>
        <span />
      </div>)}</div>
    </Card> : null}

    {result.mailboxesToReconnect.length ? <Card className="settings-card settings-table-card">
      <div className="settings-card-heading"><div><span className="polish-mono-label">Mailboxes</span><h2>Reconnect your senders</h2><p>Mailbox connections and passwords never leave the old workspace. Connect these again from Mailboxes.</p></div></div>
      <div className="settings-table">{result.mailboxesToReconnect.map((mailbox, index) => <div className="settings-table-row settings-table-row--team" key={`${mailbox.email ?? "mailbox"}-${index}`}>
        <span><strong>{mailbox.email ?? "Unknown address"}</strong>{mailbox.displayName ? <small>{mailbox.displayName}</small> : null}</span>
        <span data-label="Provider">{providerLabel(mailbox.provider)}</span>
        <span data-label="Daily limit">{mailbox.dailyLimit === null ? "—" : `${mailbox.dailyLimit.toLocaleString("en-US")} a day`}</span>
        <span />
      </div>)}</div>
    </Card> : null}

    {result.campaignsToRebuild.length ? <Card className="settings-card settings-table-card">
      <div className="settings-card-heading"><div><span className="polish-mono-label">Audiences</span><h2>Lists and senders to pick again</h2><p>What each campaign used before the move. Choose them again in the campaign before launching.</p></div></div>
      <div className="settings-table">{result.campaignsToRebuild.map((campaign, index) => <div className="settings-table-row settings-table-row--team" key={`${campaign.campaign}-${campaign.name}-${index}`}>
        <span><strong>{campaign.campaign}</strong>{campaign.name !== campaign.campaign ? <small>{campaign.name}</small> : null}</span>
        <span data-label="Was">{campaign.sourceStatus ? labelStatus(campaign.sourceStatus === "completed" ? "finished" : campaign.sourceStatus) : "—"}</span>
        <span data-label="Lists">{campaign.listNames.length ? campaign.listNames.join(", ") : "All leads"}</span>
        <span data-label="Sender">{campaign.senderEmail ?? "—"}</span>
      </div>)}</div>
    </Card> : null}
  </>;
}
