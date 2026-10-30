export type WorkspaceRole = "owner" | "admin" | "member";

export type Workspace = {
  id: string;
  name: string;
  status: string;
  defaultTimezone: string;
  dailySendCap: number;
  killSwitchEnabled: boolean;
  postalAddress: string | null;
};

export type WorkspaceResponse = {
  workspace: Workspace;
  role: WorkspaceRole;
  user: { email: string };
};
