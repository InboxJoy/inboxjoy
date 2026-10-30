"use client";

import { useEffect, useState } from "react";
import { Button, Card, EmptyState, StatusBadge } from "@inboxjoy/ui";
import { apiErrorMessage } from "@/lib/api";

type OAuthGrant = { id: string; clientId: string; clientName: string; workspaceId: string; scopes: string; createdAt: string; revokedAt: string | null };

export default function McpSettingsPage() {
  const [oauthGrants, setOauthGrants] = useState<OAuthGrant[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function loadOauthGrants() {
    const response = await fetch("/oauth/grants", { credentials: "include" });
    if (!response.ok) throw new Error("Could not load connected apps.");
    const data = await response.json() as { grants: OAuthGrant[] };
    setOauthGrants(data.grants);
  }

  useEffect(() => {
    void loadOauthGrants().catch((value) => setError(apiErrorMessage(value, "Could not load connected apps.")));
  }, []);

  async function revokeGrant(id: string) {
    if (!window.confirm("Disconnect this app? Its OAuth tokens will stop working immediately.")) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(`/oauth/grants/${id}/revoke`, { method: "POST", credentials: "include" });
      if (!response.ok) throw new Error("Could not disconnect the app.");
      setOauthGrants((current) => current.map((grant) => grant.id === id ? { ...grant, revokedAt: new Date().toISOString() } : grant));
      setNotice("Connected app revoked.");
    } catch (value) { setError(apiErrorMessage(value, "Could not disconnect the app.")); } finally { setBusy(false); }
  }

  return <div className="settings-section-stack">
    {error ? <Card className="page-message page-message--error"><p role="alert">{error}</p></Card> : null}
    {notice ? <Card className="page-message page-message--success"><p role="status">{notice}</p></Card> : null}
    <Card className="settings-card mcp-connect-card">
      <span className="polish-mono-label">AI agents</span>
      <div className="settings-card-heading"><div><h2>Connect an AI agent</h2><p>InboxJoy is a remote MCP server. Give this URL to Claude, ChatGPT, Cursor, or any MCP client — you approve access with your InboxJoy login, no keys involved.</p></div></div>
      <div className="mcp-url-row"><code>{typeof window !== "undefined" ? `${window.location.origin}/mcp` : "https://inboxjoy.online/mcp"}</code><Button variant="secondary" onClick={() => { void navigator.clipboard.writeText(`${window.location.origin}/mcp`); }}>Copy URL</Button></div>
      <ol className="mcp-connect-steps"><li>Add the URL as a connector or MCP server in your agent.</li><li>The agent redirects you here — log in and pick a workspace.</li><li>Approve once. Revoke anytime under Connected apps below.</li></ol>
    </Card>
    <Card className="settings-card settings-table-card">
      <div className="settings-card-heading"><div><span className="polish-mono-label">OAuth access</span><h2>Connected apps</h2><p>Apps authorized to access one of your InboxJoy workspaces.</p></div><StatusBadge tone="neutral">{oauthGrants.filter((grant) => !grant.revokedAt).length} active</StatusBadge></div>
      {oauthGrants.length ? <div className="settings-table">{oauthGrants.map((grant) => <div className="settings-table-row settings-table-row--oauth" key={grant.id}><span><strong>{grant.clientName}</strong><small>Connected {new Date(grant.createdAt).toLocaleDateString()}</small></span><span data-label="Scopes">{grant.scopes.split(" ").join(", ")}</span><span data-label="Status"><StatusBadge tone={grant.revokedAt ? "neutral" : "good"}>{grant.revokedAt ? "Revoked" : "Active"}</StatusBadge></span>{grant.revokedAt ? <span /> : <Button variant="ghost" disabled={busy} onClick={() => void revokeGrant(grant.id)}>Revoke</Button>}</div>)}</div> : <EmptyState title="No connected apps" description="Apps you approve through OAuth will appear here." />}
    </Card>
  </div>;
}
