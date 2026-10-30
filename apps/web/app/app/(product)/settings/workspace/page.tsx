"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Button, Card } from "@inboxjoy/ui";
import { apiErrorMessage, apiFetch } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { clearWorkspaceId } from "@/lib/workspaces";
import type { Workspace, WorkspaceResponse } from "../types";

const commonTimezones = ["UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Phoenix", "America/Anchorage", "Pacific/Honolulu", "Europe/London", "Europe/Berlin", "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney"];

export default function WorkspaceSettingsPage() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [role, setRole] = useState<WorkspaceResponse["role"]>("member");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [defaultTimezone, setDefaultTimezone] = useState("UTC");
  const [postalAddress, setPostalAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    void apiFetch<WorkspaceResponse>("/v1/workspace", {}, "Could not load workspace settings.").then((data) => {
      setWorkspace(data.workspace);
      setRole(data.role);
      setEmail(data.user.email);
      setName(data.workspace.name);
      setDefaultTimezone(data.workspace.defaultTimezone);
      setPostalAddress(data.workspace.postalAddress ?? "");
    }).catch((value) => setError(apiErrorMessage(value, "Could not load workspace settings.")));
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      const data = await apiFetch<{ workspace: Workspace }>("/v1/workspace", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, defaultTimezone, postalAddress }) }, "Could not save workspace settings.");
      setWorkspace(data.workspace);
      setName(data.workspace.name);
      setDefaultTimezone(data.workspace.defaultTimezone);
      setPostalAddress(data.workspace.postalAddress ?? "");
      setNotice("Workspace settings saved.");
    } catch (value) { setError(apiErrorMessage(value, "Could not save workspace settings.")); } finally { setBusy(false); }
  }

  async function signOut() {
    await authClient.signOut();
    clearWorkspaceId();
    window.location.assign("/");
  }

  const canEdit = role !== "member";

  return <div className="settings-section-stack">
    {error ? <Card className="page-message page-message--error"><p role="alert">{error}</p></Card> : null}
    {notice ? <Card className="page-message page-message--success"><p role="status">{notice}</p></Card> : null}
    <Card className="settings-card settings-card--workspace">
      <span className="polish-mono-label">Workspace profile</span>
      <div className="settings-card-heading"><div><h2>Workspace details</h2><p>Name, legal footer address, and the timezone used for scheduling defaults.</p></div></div>
      <form className="settings-form" onSubmit={save}>
        <label>Workspace name<input value={name} onChange={(event) => setName(event.target.value)} required maxLength={160} disabled={!canEdit} /></label>
        <label>Default timezone<input list="workspace-timezones" value={defaultTimezone} onChange={(event) => setDefaultTimezone(event.target.value)} required maxLength={80} disabled={!canEdit} /><datalist id="workspace-timezones">{commonTimezones.map((timezone) => <option value={timezone} key={timezone} />)}</datalist></label>
        <label>Postal address <small>(optional)</small><textarea rows={4} value={postalAddress} onChange={(event) => setPostalAddress(event.target.value)} placeholder={"123 Main St\nCity, ST 12345"} disabled={!canEdit} /><small>When set, it appears in the footer of every email you send. US CAN-SPAM expects a postal address in commercial email.</small></label>
        <div className="settings-actions"><Button type="submit" disabled={busy || !workspace || !canEdit || !name.trim()}>{busy ? "Saving…" : "Save changes"}</Button></div>
      </form>
      {!canEdit ? <p className="settings-warning">Only workspace owners and admins can edit these fields.</p> : null}
    </Card>
    <Card className="settings-card settings-card--account">
      <span className="polish-mono-label">Account</span>
      <div className="settings-card-heading"><div><h2>Signed in</h2><p>{email || "Loading session…"}</p></div><Button variant="secondary" disabled={!email || busy} onClick={() => void signOut()}>Sign out</Button></div>
    </Card>
  </div>;
}
