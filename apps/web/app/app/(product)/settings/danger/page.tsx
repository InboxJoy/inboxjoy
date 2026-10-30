"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Button, Card, StatusBadge } from "@inboxjoy/ui";
import { API_BASE_URL, apiErrorMessage, apiFetch, workspaceRequestHeaders } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { clearWorkspaceId } from "@/lib/workspaces";
import type { Workspace, WorkspaceResponse } from "../types";

export default function DangerSettingsPage() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [role, setRole] = useState<WorkspaceResponse["role"]>("member");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => { void apiFetch<WorkspaceResponse>("/v1/workspace", {}, "Could not load workspace controls.").then((data) => { setWorkspace(data.workspace); setRole(data.role); }).catch((value) => setError(apiErrorMessage(value, "Could not load workspace controls."))); }, []);

  async function toggleSending() {
    if (!workspace) return;
    const next = !workspace.killSwitchEnabled;
    if (!window.confirm(next ? "Pause all sending immediately?" : "Resume sending for this workspace?")) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const data = await apiFetch<{ workspace: Workspace }>("/v1/workspace", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ killSwitchEnabled: next }) }, "Could not update the sending pause.");
      setWorkspace(data.workspace);
      setNotice(next ? "All sending is paused." : "Sending resumed.");
    } catch (value) { setError(apiErrorMessage(value, "Could not update the sending pause.")); } finally { setBusy(false); }
  }

  async function download(kind: "leads" | "suppressions") {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(`${API_BASE_URL}/v1/export.csv?kind=${kind}`, { headers: workspaceRequestHeaders(), credentials: "include" });
      if (!response.ok) throw new Error(`Could not export ${kind}.`);
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = `inboxjoy-${kind}.csv`; anchor.click();
      URL.revokeObjectURL(url);
      setNotice(`${kind === "leads" ? "Leads" : "Suppressions"} export downloaded.`);
    } catch (value) { setError(apiErrorMessage(value, `Could not export ${kind}.`)); } finally { setBusy(false); }
  }

  async function deleteWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspace || confirmation !== workspace.name || !window.confirm("This permanently deletes the workspace and all of its data. Continue?")) return;
    setBusy(true); setError("");
    try {
      await apiFetch<{ deleted: true }>("/v1/workspace", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmation }) }, "Could not delete the workspace.");
      await authClient.signOut();
      clearWorkspaceId();
      window.location.assign("/");
    } catch (value) { setError(apiErrorMessage(value, "Could not delete the workspace.")); setBusy(false); }
  }

  const canManage = role !== "member";
  const isOwner = role === "owner";

  return <div className="settings-section-stack">
    {error ? <Card className="page-message page-message--error"><p role="alert">{error}</p></Card> : null}
    {notice ? <Card className="page-message page-message--success"><p role="status">{notice}</p></Card> : null}
    <Card className="settings-card settings-danger-card">
      <span className="polish-mono-label">Emergency control</span>
      <div className="settings-card-heading"><div><h2>Pause all sending</h2><p>Campaigns freeze immediately while paused and resume when this switch is turned back off.</p></div>{workspace ? <StatusBadge tone={workspace.killSwitchEnabled ? "danger" : "good"}>{workspace.killSwitchEnabled ? "Paused" : "Sending"}</StatusBadge> : null}</div>
      <div className="settings-actions"><Button variant={workspace?.killSwitchEnabled ? "secondary" : "primary"} disabled={busy || !workspace || !canManage} onClick={() => void toggleSending()}>{workspace?.killSwitchEnabled ? "Resume all sending" : "Pause all sending"}</Button></div>
      {!canManage ? <p className="settings-warning">Only workspace owners and admins can change the sending state.</p> : null}
    </Card>
    <Card className="settings-card">
      <span className="polish-mono-label">Data portability</span>
      <div className="settings-card-heading"><div><h2>Export my data</h2><p>Download workspace leads and suppressions as CSV files.</p></div></div>
      <div className="settings-actions"><Button variant="secondary" disabled={busy} onClick={() => void download("leads")}>Export leads</Button><Button variant="secondary" disabled={busy} onClick={() => void download("suppressions")}>Export suppressions</Button></div>
    </Card>
    <Card className="settings-card settings-danger-card">
      <span className="polish-mono-label">Permanent action</span>
      <div className="settings-card-heading"><div><h2>Delete workspace</h2><p>Permanently removes this workspace and all campaigns, contacts, mailboxes, keys, and billing records.</p></div></div>
      <form className="settings-form" onSubmit={deleteWorkspace}><label><span>Type <strong>{workspace?.name ?? "the workspace name"}</strong> to confirm</span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={!isOwner} /></label><div className="settings-actions"><Button type="submit" disabled={busy || !isOwner || !workspace || confirmation !== workspace.name}>Delete workspace</Button></div></form>
      {!isOwner ? <p className="settings-warning">Only the workspace owner can delete this workspace.</p> : null}
    </Card>
  </div>;
}
