// Client side of Settings > Export & import (docs/workspace-transfer.md).
// The API validates every file in full; these checks only catch the wrong
// file early and show what is about to be imported.

export const WORKSPACE_FILE_FORMAT = "inboxjoy-workspace";
export const WORKSPACE_FILE_VERSION = 1;
// Must match WORKSPACE_TRANSFER_LIMITS.maxBytes in @inboxjoy/core.
export const WORKSPACE_IMPORT_MAX_BYTES = 50 * 1024 * 1024;

export type WorkspaceFileSummary = {
  workspaceName: string;
  exportedAt: string | null;
  edition: string | null;
  leads: number;
  lists: number;
  suppressions: number;
  campaigns: number;
  teammates: number;
  mailboxes: number;
};

export type WorkspaceFileInspection =
  | { ok: true; summary: WorkspaceFileSummary }
  | { ok: false; error: string };

export type WorkspaceImportResult = {
  workspace: { name: string };
  imported: { leads: number; lists: number; listMemberships: number; suppressions: number; sequences: number; steps: number; leadVariables: number; invitations: number };
  invitations: Array<{ email: string; role: "admin" | "member"; token: string; expiresAt: string }>;
  notInvited: Array<{ email: string; reason: "already_member" | "already_invited" | "invitation_limit" }>;
  mailboxesToReconnect: Array<{ email: string | null; provider: string; displayName: string | null; dailyLimit: number | null; sendingWindows: number }>;
  campaignsToRebuild: Array<{ campaign: string; name: string; sourceStatus: string | null; listNames: string[]; senderEmail: string | null }>;
  kept: { killSwitchEnabled: boolean; sequencesArchived: number };
  warnings: string[];
};

const NOT_AN_EXPORT = "This file is not an InboxJoy workspace export. Choose the .json file you downloaded from Export & import.";

function count(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

export function formatCount(value: number, singular: string, plural = `${singular}s`): string {
  return `${value.toLocaleString("en-US")} ${value === 1 ? singular : plural}`;
}

export function tooLargeMessage(): string {
  return `This file is larger than ${WORKSPACE_IMPORT_MAX_BYTES / 1024 / 1024} MB. Remove some leads from it, or move leads separately with a CSV import.`;
}

export function inspectWorkspaceFile(text: string, sizeBytes: number): WorkspaceFileInspection {
  if (sizeBytes > WORKSPACE_IMPORT_MAX_BYTES) return { ok: false, error: tooLargeMessage() };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: NOT_AN_EXPORT };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, error: NOT_AN_EXPORT };
  const file = data as Record<string, unknown>;
  if (file.format !== WORKSPACE_FILE_FORMAT) return { ok: false, error: NOT_AN_EXPORT };
  if (file.version !== WORKSPACE_FILE_VERSION) {
    return {
      ok: false,
      error: typeof file.version === "number" && file.version > WORKSPACE_FILE_VERSION
        ? "This export comes from a newer InboxJoy. Update this install, then import again."
        : "This export uses a format this install cannot read.",
    };
  }
  const workspace = file.workspace && typeof file.workspace === "object" ? file.workspace as Record<string, unknown> : {};
  const source = file.source && typeof file.source === "object" ? file.source as Record<string, unknown> : {};
  return {
    ok: true,
    summary: {
      workspaceName: typeof workspace.name === "string" && workspace.name.trim() ? workspace.name.trim() : "Unnamed workspace",
      exportedAt: typeof file.exportedAt === "string" ? file.exportedAt : null,
      edition: typeof source.edition === "string" ? source.edition : null,
      leads: count(file.leads),
      lists: count(file.lists),
      suppressions: count(file.suppressions),
      campaigns: count(file.sequences),
      teammates: count(file.team),
      mailboxes: count(file.mailboxes),
    },
  };
}

export function summaryLine(summary: Pick<WorkspaceFileSummary, "leads" | "lists" | "suppressions" | "campaigns" | "teammates">): string {
  return [
    formatCount(summary.leads, "lead"),
    formatCount(summary.lists, "list"),
    formatCount(summary.suppressions, "suppression"),
    formatCount(summary.campaigns, "campaign"),
    formatCount(summary.teammates, "teammate"),
  ].join(" · ");
}

export function editionLabel(edition: string | null): string | null {
  if (edition === "cloud") return "InboxJoy Cloud";
  if (edition === "selfhost") return "Self-hosted InboxJoy";
  return null;
}

export function downloadFilename(contentDisposition: string | null): string {
  const match = contentDisposition?.match(/filename="([^"]+)"/);
  const name = match?.[1];
  return name && /^[\w.-]+\.json$/.test(name) ? name : "inboxjoy-workspace.json";
}

export function invitationLink(origin: string, token: string): string {
  return `${origin.replace(/\/$/, "")}/app/invite/${token}`;
}

export function notInvitedReason(reason: WorkspaceImportResult["notInvited"][number]["reason"]): string {
  if (reason === "already_member") return "Already a member";
  if (reason === "already_invited") return "Already invited";
  return "Over the 20 open invitation limit";
}

export function providerLabel(provider: string): string {
  if (provider === "gmail") return "Gmail";
  if (provider === "outlook") return "Outlook";
  if (provider === "smtp") return "SMTP";
  return provider;
}
