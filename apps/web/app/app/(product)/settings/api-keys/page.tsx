"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Button, Card, EmptyState, formatDateTime, StatusBadge } from "@inboxjoy/ui";
import { apiErrorMessage, apiFetch } from "@/lib/api";
import type { WorkspaceRole, WorkspaceResponse } from "../types";

type ApiKey = { id: string; name: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null };

export default function ApiKeysSettingsPage() {
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [name, setName] = useState("");
  const [plaintextKey, setPlaintextKey] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    const data = await apiFetch<{ apiKeys: ApiKey[] }>("/v1/api-keys", {}, "Could not load API keys.");
    setApiKeys(data.apiKeys);
  }

  useEffect(() => {
    void apiFetch<WorkspaceResponse>("/v1/workspace", {}, "Could not load workspace access.").then(async (data) => {
      setRole(data.role);
      if (data.role === "owner") await load();
    }).catch((value) => setError(apiErrorMessage(value, "Could not load API keys.")));
  }, []);

  async function createKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setNotice(""); setPlaintextKey("");
    try {
      const data = await apiFetch<{ apiKey: ApiKey; key: string }>("/v1/api-keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }, "Could not create the API key.");
      setApiKeys((current) => [data.apiKey, ...current]);
      setPlaintextKey(data.key);
      setName("");
    } catch (value) { setError(apiErrorMessage(value, "Could not create the API key.")); } finally { setBusy(false); }
  }

  async function revokeApiKey(id: string) {
    if (!window.confirm("Revoke this API key? Clients using it will stop working immediately.")) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await apiFetch<void>(`/v1/api-keys/${id}`, { method: "DELETE" }, "Could not revoke the API key.");
      setApiKeys((current) => current.map((key) => key.id === id ? { ...key, revokedAt: new Date().toISOString() } : key));
      setNotice("API key revoked.");
    } catch (value) { setError(apiErrorMessage(value, "Could not revoke the API key.")); } finally { setBusy(false); }
  }

  return <div className="settings-section-stack">
    {error ? <Card className="page-message page-message--error"><p role="alert">{error}</p></Card> : null}
    {notice ? <Card className="page-message page-message--success"><p role="status">{notice}</p></Card> : null}
    <Card className="settings-card">
      <span className="polish-mono-label">API access</span>
      <div className="settings-card-heading"><div><h2>API keys</h2><p>For scripts and integrations calling the REST API. AI agents should connect via Settings → MCP instead — no key needed.</p></div></div>
      <form className="settings-inline-form" onSubmit={createKey}><label>Key name<input required maxLength={160} value={name} onChange={(event) => setName(event.target.value)} placeholder="Production MCP client" disabled={role !== "owner"} /></label><Button type="submit" disabled={busy || role !== "owner" || !name.trim()}>Create key</Button></form>
      {role !== "owner" ? <p className="settings-warning">Only the workspace owner can manage API keys.</p> : null}
      {plaintextKey ? <div className="settings-secret settings-secret--warning"><strong>Copy this key now. It will not be shown again.</strong><code>{plaintextKey}</code><div className="settings-actions"><Button variant="secondary" onClick={() => void navigator.clipboard.writeText(plaintextKey)}>Copy key</Button><Button variant="ghost" onClick={() => setPlaintextKey("")}>I saved it</Button></div></div> : null}
    </Card>
    <Card className="settings-card settings-table-card">
      <div className="settings-card-heading"><div><span className="polish-mono-label">Credentials</span><h2>Workspace keys</h2><p>Only metadata is stored here; plaintext keys cannot be recovered.</p></div><StatusBadge tone="neutral">{apiKeys.filter((key) => !key.revokedAt).length} active</StatusBadge></div>
      {apiKeys.length ? <div className="settings-table">{apiKeys.map((key) => <div className="settings-table-row settings-table-row--keys" key={key.id}><span><strong>{key.name}</strong><small>Created {new Date(key.createdAt).toLocaleDateString()}</small></span><span data-label="Last used">{key.lastUsedAt ? `Last used ${formatDateTime(key.lastUsedAt)}` : "Never used"}</span><span data-label="Status"><StatusBadge tone={key.revokedAt ? "neutral" : "good"}>{key.revokedAt ? "Revoked" : "Active"}</StatusBadge></span>{key.revokedAt ? <span /> : <Button variant="ghost" disabled={busy} onClick={() => void revokeApiKey(key.id)}>Revoke</Button>}</div>)}</div> : <EmptyState title="No API keys" description="Create a key for programmatic REST access to this workspace." />}
    </Card>
  </div>;
}
