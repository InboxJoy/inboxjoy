"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Button, Card, EmptyState, labelStatus, StatusBadge } from "@inboxjoy/ui";
import { ApiError, apiErrorMessage, apiFetch } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { canChangeTeamMemberRole, changeTeamMemberRole, type EditableTeamRole } from "@/lib/team";
import type { WorkspaceRole } from "../types";

type Member = { id: string; userId: string; email: string; displayName: string | null; role: WorkspaceRole; joinedAt: string | null };
type Invitation = { id: string; email: string; role: "admin" | "member"; expiresAt: string; createdAt: string };
type TeamData = { role: WorkspaceRole; members: Member[]; invitations: Invitation[] };

export default function TeamSettingsPage() {
  const { data: session } = authClient.useSession();
  const [team, setTeam] = useState<TeamData | null>(null);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [inviteLink, setInviteLink] = useState("");
  const [inviteEmailed, setInviteEmailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [roleStatus, setRoleStatus] = useState<{ memberId: string; saving: boolean; message: string; error: boolean } | null>(null);

  async function load() {
    const data = await apiFetch<TeamData>("/v1/team", {}, "Could not load the workspace team.");
    setTeam(data);
  }

  useEffect(() => { void load().catch((value) => setError(apiErrorMessage(value, "Could not load the workspace team."))); }, []);

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setNotice(""); setInviteLink(""); setInviteEmailed(false);
    try {
      const data = await apiFetch<{ invitation: Invitation; token: string; emailSent?: boolean }>("/v1/team/invitations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, role: inviteRole }) }, "Could not create the invitation.");
      setInviteLink(`${window.location.origin}/app/invite/${data.token}`);
      setInviteEmailed(data.emailSent === true);
      setEmail("");
      setNotice(data.emailSent === true ? `Invitation emailed to ${data.invitation.email}.` : "Invitation created. Share the link before leaving this page.");
      await load();
    } catch (value) { setError(value instanceof ApiError && value.status === 429 ? "Please wait a minute before sending another invitation." : apiErrorMessage(value, "Could not create the invitation.")); } finally { setBusy(false); }
  }

  async function revoke(id: string) {
    setBusy(true); setError(""); setNotice("");
    try { await apiFetch<void>(`/v1/team/invitations/${id}`, { method: "DELETE" }, "Could not revoke the invitation."); await load(); setNotice("Invitation revoked."); }
    catch (value) { setError(apiErrorMessage(value, "Could not revoke the invitation.")); } finally { setBusy(false); }
  }

  async function remove(id: string) {
    if (!window.confirm("Remove this teammate from the workspace?")) return;
    setBusy(true); setError(""); setNotice("");
    try { await apiFetch<void>(`/v1/team/members/${id}`, { method: "DELETE" }, "Could not remove the member."); await load(); setNotice("Member removed."); }
    catch (value) { setError(apiErrorMessage(value, "Could not remove the member.")); } finally { setBusy(false); }
  }

  const isOwner = team?.role === "owner";

  async function changeRole(member: Member, role: EditableTeamRole) {
    if (busy || role === member.role || !canChangeTeamMemberRole(team?.role, session?.user.id, member)) return;
    setBusy(true); setError(""); setNotice("");
    setRoleStatus({ memberId: member.id, saving: true, message: "Saving role…", error: false });
    try {
      const updated = await changeTeamMemberRole(member.id, role);
      setTeam((current) => current ? { ...current, members: current.members.map((entry) => entry.id === updated.id ? { ...entry, role: updated.role } : entry) } : current);
      try {
        await load();
        setRoleStatus({ memberId: member.id, saving: false, message: "Role updated.", error: false });
      } catch {
        setRoleStatus({ memberId: member.id, saving: false, message: "Role updated. Refresh to see the latest team.", error: false });
      }
    } catch (value) {
      setRoleStatus({ memberId: member.id, saving: false, message: apiErrorMessage(value, "Try updating the role again."), error: true });
    } finally { setBusy(false); }
  }

  return <div className="settings-section-stack">
    {error ? <Card className="page-message page-message--error"><p role="alert">{error}</p></Card> : null}
    {notice ? <Card className="page-message page-message--success"><p role="status">{notice}</p></Card> : null}
    <Card className="settings-card">
      <span className="polish-mono-label">Invite teammate</span>
      <div className="settings-card-heading"><div><h2>Grow your workspace</h2><p>Owners can invite teammates as admins or members. Invitees get an email with a join link that works for 7 days.</p></div></div>
      <form className="settings-inline-form settings-inline-form--invite" onSubmit={invite}><label>Email address<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} disabled={!isOwner} placeholder="teammate@example.com" /></label><label>Role<select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as "admin" | "member")} disabled={!isOwner}><option value="member">Member</option><option value="admin">Admin</option></select></label><Button type="submit" disabled={busy || !isOwner}>Create invite</Button></form>
      {!isOwner ? <p className="settings-warning">The workspace owner manages invitations, roles, and teammate access.</p> : null}
      {inviteLink ? <div className="settings-secret ph-no-capture"><strong>{inviteEmailed ? "Copy link as a backup" : "Share this invitation link"}</strong><code>{inviteLink}</code><Button variant="secondary" onClick={() => void navigator.clipboard.writeText(inviteLink)}>Copy link</Button></div> : null}
    </Card>
    <Card className="settings-card settings-table-card">
      <div className="settings-card-heading"><div><span className="polish-mono-label">Members</span><h2>Current team</h2><p>Active people with access to this workspace.</p></div><StatusBadge tone="neutral">{team?.members.length ?? 0}</StatusBadge></div>
      {team?.members.length ? <div className="settings-table">{team.members.map((member) => <div className="settings-table-row settings-table-row--team" key={member.id}>
        <span><strong>{member.displayName || member.email}</strong><small>{member.email}</small></span>
        <span data-label="Role">{canChangeTeamMemberRole(team.role, session?.user.id, member) ? <span className="settings-team-role-control">
          <select aria-label={`Role for ${member.displayName || member.email}`} aria-busy={roleStatus?.memberId === member.id && roleStatus.saving} className="settings-team-role-select" disabled={busy} onChange={(event) => void changeRole(member, event.target.value as EditableTeamRole)} value={member.role}>
            <option value="member">Member</option><option value="admin">Admin</option>
          </select>
          {roleStatus?.memberId === member.id ? <small className={roleStatus.error ? "settings-error" : undefined} role={roleStatus.error ? "alert" : "status"}>{roleStatus.message}</small> : null}
        </span> : <StatusBadge tone={member.role === "owner" ? "info" : "neutral"}>{labelStatus(member.role)}</StatusBadge>}</span>
        <span data-label="Joined">{member.joinedAt ? `Joined ${new Date(member.joinedAt).toLocaleDateString()}` : "Active"}</span>
        {isOwner && member.role !== "owner" ? <Button variant="ghost" disabled={busy} onClick={() => void remove(member.id)}>Remove</Button> : <span />}
      </div>)}</div> : <EmptyState title="No members found" description="Workspace members will appear here." />}
    </Card>
    <Card className="settings-card settings-table-card">
      <div className="settings-card-heading"><div><span className="polish-mono-label">Pending</span><h2>Invitations</h2><p>Unaccepted invitations that have not expired.</p></div><StatusBadge tone="neutral">{team?.invitations.length ?? 0}</StatusBadge></div>
      {team?.invitations.length ? <div className="settings-table">{team.invitations.map((invitation) => <div className="settings-table-row settings-table-row--team" key={invitation.id}><span><strong>{invitation.email}</strong><small>Expires {new Date(invitation.expiresAt).toLocaleDateString()}</small></span><span data-label="Role"><StatusBadge tone="neutral">{labelStatus(invitation.role)}</StatusBadge></span><span data-label="Status">Pending</span>{isOwner ? <Button variant="ghost" disabled={busy} onClick={() => void revoke(invitation.id)}>Revoke</Button> : <span />}</div>)}</div> : <EmptyState title="No pending invitations" description="New invitations will appear here until accepted or revoked." />}
    </Card>
  </div>;
}
