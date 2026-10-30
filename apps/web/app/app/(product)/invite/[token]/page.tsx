"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { Button, Card, StatusBadge } from "@inboxjoy/ui";
import { apiErrorMessage, apiFetch } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { resendVerificationEmail } from "@/lib/email-verification";
import { clearWorkspaceId, setWorkspaceId } from "@/lib/workspaces";

type InvitePreview = {
  status: "pending" | "member" | "accepted" | "expired" | "wrong_email" | "account_unavailable" | "verify_email";
  workspaceId: string;
  workspaceName: string;
  inviterName: string | null;
  role: "owner" | "admin" | "member";
  invitedEmail: string | null;
  signedInEmail: string | null;
  expiresAt: string;
};

const roleLabel = { owner: "Owner", admin: "Admin", member: "Member" } as const;

function initials(name: string) {
  return name.replace(/'s workspace$/i, "").trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "W";
}

function openWorkspace(workspaceId: string) {
  setWorkspaceId(workspaceId);
  window.location.assign("/app");
}

export default function AcceptInvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [resent, setResent] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch<InvitePreview>(`/v1/team/invitations/preview?token=${encodeURIComponent(token)}`, undefined, "Could not load this invitation.")
      .then((result) => { if (!cancelled) setPreview(result); })
      .catch((value) => { if (!cancelled) setLoadError(apiErrorMessage(value, "Could not load this invitation.")); });
    return () => { cancelled = true; };
  }, [token]);

  async function accept() {
    setBusy(true); setError("");
    try {
      const result = await apiFetch<{ accepted: true; workspaceId: string }>("/v1/team/invitations/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) }, "Could not accept this invitation.");
      setWorkspaceId(result.workspaceId);
      window.location.assign("/app");
    } catch (value) { setError(apiErrorMessage(value, "Could not accept this invitation.")); setBusy(false); }
  }

  async function switchAccount() {
    setBusy(true); setError("");
    try {
      await authClient.signOut();
      clearWorkspaceId();
      window.location.assign(`/app/login?next=${encodeURIComponent(`/app/invite/${token}`)}`);
    } catch { setError("Could not sign out. Please try again."); setBusy(false); }
  }

  async function resendVerification() {
    if (!preview?.signedInEmail) return;
    setBusy(true); setError("");
    try {
      // The verification link lands on the login page; carry this invite along
      // so the user comes straight back here once their address is confirmed.
      await resendVerificationEmail(preview.signedInEmail, `?next=${encodeURIComponent(`/app/invite/${token}`)}`);
      setResent(true);
    } catch (value) { setError(value instanceof Error ? value.message : "We could not resend the verification email."); }
    finally { setBusy(false); }
  }

  if (!preview) {
    return <div className="invite-page">
      <Card className="invite-card">
        {loadError ? <>
          <p className="polish-mono-label">Workspace invitation</p>
          <h1 className="invite-title">This invite link isn’t working</h1>
          <p className="invite-copy">{loadError} Ask the person who invited you to send a fresh invite.</p>
          <div className="invite-actions"><Link className="ij-button ij-button--secondary" href="/app">Go to my dashboard</Link></div>
        </> : <p className="invite-copy" aria-live="polite">Loading invitation…</p>}
      </Card>
    </div>;
  }

  const inviter = preview.inviterName ?? "A teammate";
  const expires = new Date(preview.expiresAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  return <div className="invite-page">
    <Card className="invite-card">
      <div className="invite-avatar" aria-hidden="true">{initials(preview.workspaceName)}</div>
      <p className="polish-mono-label">Workspace invitation</p>
      <h1 className="invite-title">Join {preview.workspaceName}</h1>
      <p className="invite-copy"><strong>{inviter}</strong> invited you to collaborate on campaigns, leads and replies.</p>

      <dl className="invite-details">
        <div><dt>Role</dt><dd><StatusBadge tone="info">{roleLabel[preview.role]}</StatusBadge></dd></div>
        {preview.invitedEmail ? <div><dt>Invite sent to</dt><dd>{preview.invitedEmail}</dd></div> : null}
        {preview.status === "pending" ? <div><dt>Expires</dt><dd>{expires}</dd></div> : null}
      </dl>

      {preview.status === "wrong_email" ? <p className="invite-notice" role="status">You’re signed in as <strong>{preview.signedInEmail}</strong>. Sign in as {preview.invitedEmail} to accept.</p> : null}
      {preview.status === "verify_email" ? <p className="invite-notice" role="status">Verify your email first. We sent a link to <strong>{preview.signedInEmail}</strong>. Open it, then come back here to join.</p> : null}
      {preview.status === "account_unavailable" ? <p className="invite-notice" role="status">We couldn’t load your account details yet. Refresh this page in a moment to accept.</p> : null}
      {preview.status === "expired" ? <p className="invite-notice" role="status">This invitation expired on {expires}. Ask {inviter} to send a new one.</p> : null}
      {preview.status === "accepted" ? <p className="invite-notice" role="status">This invitation has already been used.</p> : null}
      {preview.status === "member" ? <p className="invite-notice invite-notice--good" role="status">You’re already a member of this workspace.</p> : null}
      {error ? <p className="settings-error" role="alert">{error}</p> : null}

      <div className="invite-actions">
        {preview.status === "pending" ? <>
          <Button disabled={busy} onClick={() => void accept()}>{busy ? "Joining…" : `Join ${preview.workspaceName}`}</Button>
          <Link className="ij-button ij-button--secondary" href="/app">Not now</Link>
        </> : null}
        {preview.status === "member" ? <Button onClick={() => openWorkspace(preview.workspaceId)}>Open workspace</Button> : null}
        {preview.status === "wrong_email" ? <>
          <Button disabled={busy} onClick={() => void switchAccount()}>{busy ? "Signing out…" : "Switch account"}</Button>
          <Link className="ij-button ij-button--secondary" href="/app">Go to my dashboard</Link>
        </> : null}
        {preview.status === "verify_email" ? <>
          <Button disabled={busy || resent} onClick={() => void resendVerification()}>{busy ? "Sending…" : resent ? "Verification email sent" : "Resend verification email"}</Button>
          <Button variant="secondary" onClick={() => window.location.reload()}>I’ve verified</Button>
        </> : null}
        {preview.status === "account_unavailable" ? <Button onClick={() => window.location.reload()}>Refresh</Button> : null}
        {preview.status === "expired" || preview.status === "accepted" ? <Link className="ij-button ij-button--secondary" href="/app">Go to my dashboard</Link> : null}
      </div>
    </Card>
  </div>;
}
