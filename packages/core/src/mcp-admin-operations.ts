import { isCloudEdition, type Edition } from "./edition.js";

export const MCP_ADMIN_OPERATIONS: ReadonlySet<string> = new Set([
  "apiKeys.create",
  "apiKeys.list",
  "apiKeys.revoke",
  "team.list",
  "team.invite",
  "team.inviteRevoke",
  "team.memberRemove",
  "team.memberRoleChange",
  "team.inviteAccept",
  "team.invitePreview",
  "workspaces.list",
  "workspaces.switch",
  "billing.checkoutStart",
  "billing.get",
  "billing.reconcile",
  "billing.portalLink",
  "billing.cancel",
  "suppressions.remove",
  "sequences.delete",
  "workspace.delete",
]);

// Operations that exist only on the managed service: self-host has no affiliate
// program. Self-host
// neither lists them as MCP tools nor runs them over REST. Billing stays out of
// this list: billing.get answers in self-host (tier "selfhost") and the billing
// writes refuse there with not_available.
const CLOUD_ONLY_OPERATION_PREFIXES: readonly string[] = ["affiliate."];

export function operationAvailableInEdition(operationName: string, edition: Edition): boolean {
  if (isCloudEdition(edition)) return true;
  return !CLOUD_ONLY_OPERATION_PREFIXES.some((prefix) => operationName.startsWith(prefix));
}

// Sending controls are a person's decision. Machine credentials (API keys and
// MCP tokens) may call these operations, but never with these fields: a leaked
// key or a prompt-injected agent must not be able to undo an owner's pause or
// raise the daily cap.
export const MACHINE_FORBIDDEN_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "workspace.update": ["killSwitchEnabled", "dailySendCap"],
};

export function machineForbiddenField(operationName: string, input: unknown): string | undefined {
  const fields = MACHINE_FORBIDDEN_FIELDS[operationName];
  if (!fields || !input || typeof input !== "object") return undefined;
  return fields.find((field) => (input as Record<string, unknown>)[field] !== undefined);
}
