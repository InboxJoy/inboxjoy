import { migratePendingBillingStorage } from "./billing-storage";

export type WorkspaceMembership = {
  id: string;
  name: string;
  role: "owner" | "admin" | "member";
  isCurrent: boolean;
};

const WORKSPACE_ID_KEY = "inboxjoy.workspace-id";

export function getWorkspaceId(): string | null {
  try {
    return window.sessionStorage.getItem(WORKSPACE_ID_KEY);
  } catch {
    return null;
  }
}

export function setWorkspaceId(workspaceId: string): void {
  try {
    window.sessionStorage.setItem(WORKSPACE_ID_KEY, workspaceId);
    migratePendingBillingStorage(workspaceId);
  } catch {}
}

export function clearWorkspaceId(): void {
  try {
    window.sessionStorage.removeItem(WORKSPACE_ID_KEY);
  } catch {}
}

export function workspaceMemberships(response: unknown): WorkspaceMembership[] {
  if (!response || typeof response !== "object" || !("workspaces" in response) || !Array.isArray(response.workspaces)) return [];
  const workspaces: WorkspaceMembership[] = [];
  for (const workspace of response.workspaces) {
    if (!workspace || typeof workspace !== "object"
      || typeof workspace.id !== "string" || !workspace.id.trim()
      || typeof workspace.name !== "string" || !workspace.name.trim()
      || !["owner", "admin", "member"].includes(workspace.role)
      || typeof workspace.isCurrent !== "boolean") return [];
    workspaces.push(workspace);
  }
  if (new Set(workspaces.map((workspace) => workspace.id)).size !== workspaces.length
    || workspaces.filter((workspace) => workspace.isCurrent).length !== 1) return [];
  return workspaces;
}
