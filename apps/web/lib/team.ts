import { apiFetch } from "@/lib/api";
import type { WorkspaceMembership } from "@/lib/workspaces";

type WorkspaceRole = WorkspaceMembership["role"];
export type EditableTeamRole = Exclude<WorkspaceRole, "owner">;

export function canChangeTeamMemberRole(viewerRole: WorkspaceRole | undefined, viewerUserId: string | undefined, member: { userId: string; role: WorkspaceRole }): boolean {
  return viewerRole === "owner" && Boolean(viewerUserId) && member.role !== "owner" && member.userId !== viewerUserId;
}

export function changeTeamMemberRole(memberId: string, role: EditableTeamRole): Promise<{ id: string; role: EditableTeamRole }> {
  return apiFetch(`/v1/team/members/${encodeURIComponent(memberId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role }),
  }, "Try updating the role again.");
}
