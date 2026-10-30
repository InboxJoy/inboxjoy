import { createHash } from "node:crypto";
import { z } from "zod";

import { isBuiltInOrAliasVariable, sanitizeVariableValue, VARIABLE_NAME_PATTERN } from "../template-variables.js";

// The portable workspace file (docs/workspace-transfer.md). Pure code only:
// no database access, so the format, its limits and the import plan are unit
// tested without PostgreSQL.

export const WORKSPACE_TRANSFER_FORMAT = "inboxjoy-workspace";
export const WORKSPACE_TRANSFER_VERSION = 1;

export const WORKSPACE_TRANSFER_LIMITS = {
  // 100,000 leads with a few custom fields plus list memberships is about
  // 25-35 MB of JSON, so the body limit sits above that.
  maxBytes: 50 * 1024 * 1024,
  leads: 100_000,
  lists: 1_000,
  suppressions: 250_000,
  sequences: 500,
  stepsPerSequence: 50,
  campaignsPerSequence: 50,
  leadVariableRows: 500_000,
  team: 100,
  mailboxes: 500,
  customFieldsPerLead: 200,
} as const;

const CUSTOM_FIELD_KEY_MAX = 120;
const CUSTOM_FIELD_VALUE_MAX = 5_000;

export type WorkspaceTransferErrorCode = "not_workspace_export" | "unsupported_version" | "import_too_large" | "invalid_export";

export class WorkspaceTransferError extends Error {
  constructor(public readonly code: WorkspaceTransferErrorCode, message: string, public readonly details?: unknown) {
    super(message);
    this.name = "WorkspaceTransferError";
  }
}

// Same rule as the CSV importer, so every address already stored round-trips.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const email = z.string().trim().max(320).regex(EMAIL_PATTERN, "Enter a valid email address.");
const timestamp = z.string().max(40).refine((value) => !Number.isNaN(Date.parse(value)), "Use an ISO 8601 timestamp.");
const text = (max: number) => z.string().max(max).nullish();
const customFieldValue = z.union([z.string().max(CUSTOM_FIELD_VALUE_MAX), z.number(), z.boolean(), z.null()]);
const customFields = z.record(z.string().min(1).max(CUSTOM_FIELD_KEY_MAX), customFieldValue)
  .refine((value) => Object.keys(value).length <= WORKSPACE_TRANSFER_LIMITS.customFieldsPerLead, `A lead can carry at most ${WORKSPACE_TRANSFER_LIMITS.customFieldsPerLead} custom fields.`);

const workspaceSchema = z.object({
  name: z.string().trim().min(1).max(160),
  defaultTimezone: z.string().trim().min(1).max(80).nullish(),
  dailySendCap: z.number().int().min(1).max(100_000).nullish(),
  killSwitchEnabled: z.boolean().nullish(),
  openTrackingEnabled: z.boolean().nullish(),
  postalAddress: text(1000),
});

const leadSchema = z.object({
  email,
  firstName: text(120),
  lastName: text(120),
  company: text(180),
  title: text(180),
  website: text(4000),
  phone: text(80),
  location: text(180),
  linkedinUrl: text(4000),
  source: text(120),
  lawfulBasisNote: text(20_000),
  customFields: customFields.nullish(),
  status: z.string().trim().min(1).max(40).nullish(),
  repliedAt: timestamp.nullish(),
  bouncedAt: timestamp.nullish(),
  unsubscribedAt: timestamp.nullish(),
  createdAt: timestamp.nullish(),
});

const listSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: text(5000),
  leadEmails: z.array(email).max(WORKSPACE_TRANSFER_LIMITS.leads).default([]),
});

const suppressionSchema = z.object({
  email: email.nullish(),
  emailHash: z.string().regex(/^[0-9a-f]{64}$/, "Use a lowercase SHA-256 hex digest.").nullish(),
  reason: z.string().trim().min(1).max(80),
  source: z.string().trim().min(1).max(80),
  createdAt: timestamp.nullish(),
}).refine((value) => Boolean(value.email || value.emailHash), "A suppression needs an email or an emailHash.");

const stepSchema = z.object({
  delayDays: z.number().int().min(0).max(3650),
  subject: z.string().max(5000),
  bodyText: z.string().max(200_000),
  bodyHtml: z.string().max(400_000).nullish(),
  // No `variables`: sequence_steps.variables is a legacy column nothing reads,
  // and free-form JSON there let a deeply nested file fail with a 500. Older
  // files that carry it still import; the field is ignored.
});

const campaignSchema = z.object({
  name: z.string().trim().min(1).max(180),
  status: z.string().trim().max(40).nullish(),
  listNames: z.array(z.string().trim().min(1).max(160)).max(WORKSPACE_TRANSFER_LIMITS.lists).default([]),
  senderEmail: email.nullish(),
});

const leadVariablesSchema = z.object({
  email,
  values: z.record(z.string().max(CUSTOM_FIELD_KEY_MAX), z.string().max(CUSTOM_FIELD_VALUE_MAX)),
});

const sequenceSchema = z.object({
  name: z.string().trim().min(1).max(180),
  description: text(5000),
  status: z.string().trim().max(40).nullish(),
  customVariablesEnforced: z.boolean().nullish(),
  steps: z.array(stepSchema).max(WORKSPACE_TRANSFER_LIMITS.stepsPerSequence).default([]),
  campaigns: z.array(campaignSchema).max(WORKSPACE_TRANSFER_LIMITS.campaignsPerSequence).default([]),
  leadVariables: z.array(leadVariablesSchema).max(WORKSPACE_TRANSFER_LIMITS.leadVariableRows).default([]),
});

const sendingWindowSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: z.string().max(16),
  endTime: z.string().max(16),
  timezone: z.string().max(80).nullish(),
  isActive: z.boolean().nullish(),
});

// Metadata only: no credential or provider connection ever moves.
const mailboxSchema = z.object({
  email: email.nullish(),
  provider: z.string().trim().max(40),
  displayName: text(160),
  timezone: z.string().max(80).nullish(),
  dailyLimit: z.number().int().min(0).max(100_000).nullish(),
  hourlyLimit: z.number().int().min(0).max(100_000).nullish(),
  sendingWindows: z.array(sendingWindowSchema).max(7).default([]),
});

const teamMemberSchema = z.object({
  email,
  role: z.enum(["owner", "admin", "member"]),
});

export const workspaceTransferFileSchema = z.object({
  format: z.literal(WORKSPACE_TRANSFER_FORMAT),
  version: z.literal(WORKSPACE_TRANSFER_VERSION),
  exportedAt: timestamp,
  source: z.object({ edition: z.string().max(40).nullish(), appVersion: z.string().max(80).nullish() }).default({}),
  workspace: workspaceSchema,
  leads: z.array(leadSchema).max(WORKSPACE_TRANSFER_LIMITS.leads).default([]),
  lists: z.array(listSchema).max(WORKSPACE_TRANSFER_LIMITS.lists).default([]),
  suppressions: z.array(suppressionSchema).max(WORKSPACE_TRANSFER_LIMITS.suppressions).default([]),
  sequences: z.array(sequenceSchema).max(WORKSPACE_TRANSFER_LIMITS.sequences).default([]),
  mailboxes: z.array(mailboxSchema).max(WORKSPACE_TRANSFER_LIMITS.mailboxes).default([]),
  team: z.array(teamMemberSchema).max(WORKSPACE_TRANSFER_LIMITS.team).default([]),
});

export type WorkspaceTransferFile = z.infer<typeof workspaceTransferFileSchema>;
export type WorkspaceTransferSequence = z.infer<typeof sequenceSchema>;
export type CustomFieldValue = z.infer<typeof customFieldValue>;

export function normalizeTransferEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function suppressionEmailHash(normalizedEmail: string): string {
  return createHash("sha256").update(normalizedEmail).digest("hex");
}

const SUPPRESSION_REASONS = ["unsubscribed", "bounced", "complained", "blocked", "customer", "manual"] as const;
type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

// Mirrors the normalize_suppression_reason() trigger (migration 0012) so the
// file and the database agree on the stored value.
export function normalizeSuppressionReason(reason: string): SuppressionReason {
  const lower = reason.trim().toLowerCase();
  if ((SUPPRESSION_REASONS as readonly string[]).includes(lower)) return lower as SuppressionReason;
  if (lower.includes("unsub")) return "unsubscribed";
  if (lower.includes("bounce")) return "bounced";
  if (lower.includes("complaint") || lower.includes("spam")) return "complained";
  if (lower.includes("block")) return "blocked";
  if (lower.includes("customer")) return "customer";
  return "manual";
}

// Lead custom fields are free-form jsonb. Only JSON primitives move; anything
// nested is kept as its JSON text so a file always passes its own validation.
export function normalizeCustomFields(value: unknown): Record<string, CustomFieldValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, CustomFieldValue> = {};
  for (const [rawKey, raw] of Object.entries(value as Record<string, unknown>)) {
    const key = rawKey.slice(0, CUSTOM_FIELD_KEY_MAX);
    if (!key || raw === undefined || Object.keys(result).length >= WORKSPACE_TRANSFER_LIMITS.customFieldsPerLead) continue;
    if (raw === null || typeof raw === "boolean") result[key] = raw;
    else if (typeof raw === "number") result[key] = Number.isFinite(raw) ? raw : null;
    else if (typeof raw === "string") result[key] = raw.slice(0, CUSTOM_FIELD_VALUE_MAX);
    else result[key] = (JSON.stringify(raw) ?? "").slice(0, CUSTOM_FIELD_VALUE_MAX);
  }
  return result;
}

// Imported campaigns never start sending: anything that was live arrives as a
// draft (no enrollments or senders move), and archived stays archived.
export function importedSequenceStatus(sourceStatus: string | null | undefined): "draft" | "archived" {
  return sourceStatus === "archived" ? "archived" : "draft";
}

// Enrollments do not move, so "enrolled" means nothing on the new install.
// Every other status (replied, bounced, unsubscribed, suppressed) is kept so
// those leads stay out of new campaigns.
export function importedLeadStatus(sourceStatus: string | null | undefined): string {
  const status = sourceStatus?.trim();
  if (!status || status === "enrolled") return "active";
  return status;
}

export function validTransferTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

// Checks the envelope before the full schema so the common mistakes (wrong
// file, newer version, too many leads) get a specific message.
export function parseWorkspaceTransferFile(input: unknown): WorkspaceTransferFile {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new WorkspaceTransferError("not_workspace_export", "This file is not an InboxJoy workspace export.");
  }
  const envelope = input as Record<string, unknown>;
  if (envelope.format !== WORKSPACE_TRANSFER_FORMAT) {
    throw new WorkspaceTransferError("not_workspace_export", "This file is not an InboxJoy workspace export.");
  }
  if (envelope.version !== WORKSPACE_TRANSFER_VERSION) {
    const newer = typeof envelope.version === "number" && envelope.version > WORKSPACE_TRANSFER_VERSION;
    throw new WorkspaceTransferError(
      "unsupported_version",
      newer
        ? `This export uses format version ${String(envelope.version)}, which is newer than this install supports. Update InboxJoy, then import again.`
        : `This export uses format version ${String(envelope.version)}, which this install cannot read.`,
      { version: envelope.version, supportedVersion: WORKSPACE_TRANSFER_VERSION },
    );
  }
  const counts: Array<[string, number, number]> = [
    ["leads", arrayLength(envelope.leads), WORKSPACE_TRANSFER_LIMITS.leads],
    ["lists", arrayLength(envelope.lists), WORKSPACE_TRANSFER_LIMITS.lists],
    ["suppressions", arrayLength(envelope.suppressions), WORKSPACE_TRANSFER_LIMITS.suppressions],
    ["campaigns", arrayLength(envelope.sequences), WORKSPACE_TRANSFER_LIMITS.sequences],
    ["teammates", arrayLength(envelope.team), WORKSPACE_TRANSFER_LIMITS.team],
    ["mailboxes", arrayLength(envelope.mailboxes), WORKSPACE_TRANSFER_LIMITS.mailboxes],
  ];
  const over = counts.find(([, count, limit]) => count > limit);
  if (over) {
    const [label, count, limit] = over;
    throw new WorkspaceTransferError("import_too_large", `This file has ${formatCount(count)} ${label}. One import can hold up to ${formatCount(limit)} ${label}.`, { field: label, count, limit });
  }
  const parsed = workspaceTransferFileSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 10).map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message }));
    const first = issues[0];
    throw new WorkspaceTransferError(
      "invalid_export",
      first ? `This export has a problem at ${first.path || "the top level"}: ${first.message}` : "This export could not be read.",
      { issues },
    );
  }
  return parsed.data;
}

export type PlannedLead = {
  email: string;
  normalizedEmail: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  title: string | null;
  website: string | null;
  phone: string | null;
  location: string | null;
  linkedinUrl: string | null;
  source: string | null;
  lawfulBasisNote: string | null;
  customFields: Record<string, CustomFieldValue>;
  status: string;
  repliedAt: Date | null;
  bouncedAt: Date | null;
  unsubscribedAt: Date | null;
  createdAt: Date | null;
};

export type PlannedSuppression = {
  email: string | null;
  normalizedEmail: string | null;
  emailHash: string;
  reason: SuppressionReason;
  source: string;
  createdAt: Date | null;
};

export type PlannedSequence = {
  name: string;
  description: string;
  sourceStatus: string | null;
  status: "draft" | "archived";
  customVariablesEnforced: boolean;
  steps: Array<{ stepOrder: number; delayDays: number; subject: string; bodyText: string; bodyHtml: string | null }>;
  leadVariables: Array<{ normalizedEmail: string; values: Record<string, string> }>;
  campaigns: Array<{ name: string; sourceStatus: string | null; listNames: string[]; senderEmail: string | null }>;
};

export type WorkspaceImportPlan = {
  exportedAt: string;
  source: { edition: string | null; appVersion: string | null };
  workspace: {
    name: string;
    defaultTimezone: string | null;
    dailySendCap: number | null;
    killSwitchEnabled: boolean;
    openTrackingEnabled: boolean | null;
    postalAddress: string | null;
  };
  leads: PlannedLead[];
  lists: Array<{ name: string; description: string | null; memberEmails: string[] }>;
  suppressions: PlannedSuppression[];
  sequences: PlannedSequence[];
  team: Array<{ email: string; normalizedEmail: string; role: "admin" | "member" }>;
  mailboxes: Array<{ email: string | null; provider: string; displayName: string | null; dailyLimit: number | null; sendingWindows: number }>;
  skipped: { listMemberships: number; leadVariables: number; suppressions: number; teamMembers: number };
  warnings: string[];
};

function dateOrNull(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

function textOrNull(value: string | null | undefined): string | null {
  return value ?? null;
}

// Turns a validated file into rows ready to insert. Throws for problems that
// would otherwise fail halfway through the transaction (duplicate lead emails,
// duplicate list names); skips and counts dangling references instead.
export function prepareWorkspaceImport(file: WorkspaceTransferFile): WorkspaceImportPlan {
  const warnings: string[] = [];
  const skipped = { listMemberships: 0, leadVariables: 0, suppressions: 0, teamMembers: 0 };

  const leads: PlannedLead[] = [];
  const leadEmails = new Set<string>();
  for (const lead of file.leads) {
    const normalizedEmail = normalizeTransferEmail(lead.email);
    if (leadEmails.has(normalizedEmail)) {
      throw new WorkspaceTransferError("invalid_export", `The lead ${normalizedEmail} appears more than once. Remove the duplicate and import again.`, { email: normalizedEmail });
    }
    leadEmails.add(normalizedEmail);
    leads.push({
      email: lead.email.trim(),
      normalizedEmail,
      firstName: textOrNull(lead.firstName),
      lastName: textOrNull(lead.lastName),
      company: textOrNull(lead.company),
      title: textOrNull(lead.title),
      website: textOrNull(lead.website),
      phone: textOrNull(lead.phone),
      location: textOrNull(lead.location),
      linkedinUrl: textOrNull(lead.linkedinUrl),
      source: textOrNull(lead.source),
      lawfulBasisNote: textOrNull(lead.lawfulBasisNote),
      customFields: normalizeCustomFields(lead.customFields),
      status: importedLeadStatus(lead.status),
      repliedAt: dateOrNull(lead.repliedAt),
      bouncedAt: dateOrNull(lead.bouncedAt),
      unsubscribedAt: dateOrNull(lead.unsubscribedAt),
      createdAt: dateOrNull(lead.createdAt),
    });
  }

  const lists: WorkspaceImportPlan["lists"] = [];
  const listNames = new Set<string>();
  for (const list of file.lists) {
    if (listNames.has(list.name)) {
      throw new WorkspaceTransferError("invalid_export", `Two lists are named "${list.name}". Rename one and import again.`, { list: list.name });
    }
    listNames.add(list.name);
    const members = new Set<string>();
    for (const memberEmail of list.leadEmails) {
      const normalizedEmail = normalizeTransferEmail(memberEmail);
      if (!leadEmails.has(normalizedEmail)) { skipped.listMemberships++; continue; }
      members.add(normalizedEmail);
    }
    lists.push({ name: list.name, description: textOrNull(list.description), memberEmails: [...members] });
  }
  if (skipped.listMemberships) warnings.push(`${formatCount(skipped.listMemberships)} list entries named leads that are not in the file and were skipped.`);

  const suppressions: PlannedSuppression[] = [];
  const suppressionHashes = new Set<string>();
  for (const suppression of file.suppressions) {
    const normalizedEmail = suppression.email ? normalizeTransferEmail(suppression.email) : null;
    // The hash is recomputed from the address whenever there is one: a file
    // cannot pair an address with someone else's hash.
    const emailHash = normalizedEmail ? suppressionEmailHash(normalizedEmail) : suppression.emailHash!;
    if (suppressionHashes.has(emailHash)) { skipped.suppressions++; continue; }
    suppressionHashes.add(emailHash);
    suppressions.push({
      email: suppression.email?.trim() ?? null,
      normalizedEmail,
      emailHash,
      reason: normalizeSuppressionReason(suppression.reason),
      source: suppression.source,
      createdAt: dateOrNull(suppression.createdAt),
    });
  }

  let leadVariableRows = 0;
  let droppedVariableNames = 0;
  const sequences: PlannedSequence[] = file.sequences.map((sequence) => {
    const leadVariables: PlannedSequence["leadVariables"] = [];
    const seen = new Set<string>();
    for (const row of sequence.leadVariables) {
      const normalizedEmail = normalizeTransferEmail(row.email);
      if (!leadEmails.has(normalizedEmail) || seen.has(normalizedEmail)) { skipped.leadVariables++; continue; }
      const values: Record<string, string> = {};
      for (const [name, raw] of Object.entries(row.values)) {
        if (!VARIABLE_NAME_PATTERN.test(name) || isBuiltInOrAliasVariable(name)) { droppedVariableNames++; continue; }
        const value = sanitizeVariableValue(raw);
        if (value !== undefined) values[name] = value;
      }
      if (!Object.keys(values).length) continue;
      seen.add(normalizedEmail);
      leadVariables.push({ normalizedEmail, values });
    }
    leadVariableRows += leadVariables.length;
    return {
      name: sequence.name,
      description: sequence.description ?? "",
      sourceStatus: textOrNull(sequence.status),
      status: importedSequenceStatus(sequence.status),
      customVariablesEnforced: sequence.customVariablesEnforced ?? true,
      steps: sequence.steps.map((step, index) => ({
        stepOrder: index + 1,
        delayDays: step.delayDays,
        subject: step.subject,
        bodyText: step.bodyText,
        bodyHtml: textOrNull(step.bodyHtml),
      })),
      leadVariables,
      campaigns: sequence.campaigns.map((campaign) => ({
        name: campaign.name,
        sourceStatus: textOrNull(campaign.status),
        listNames: [...new Set(campaign.listNames)].filter((name) => listNames.has(name)),
        senderEmail: campaign.senderEmail ? normalizeTransferEmail(campaign.senderEmail) : null,
      })),
    };
  });
  if (leadVariableRows > WORKSPACE_TRANSFER_LIMITS.leadVariableRows) {
    throw new WorkspaceTransferError("import_too_large", `This file has ${formatCount(leadVariableRows)} campaign variable rows. One import can hold up to ${formatCount(WORKSPACE_TRANSFER_LIMITS.leadVariableRows)}.`, { field: "leadVariables", count: leadVariableRows, limit: WORKSPACE_TRANSFER_LIMITS.leadVariableRows });
  }
  if (skipped.leadVariables) warnings.push(`${formatCount(skipped.leadVariables)} campaign variable rows named leads that are not in the file and were skipped.`);
  if (droppedVariableNames) warnings.push(`${formatCount(droppedVariableNames)} campaign variable values had names this install does not accept and were skipped.`);

  const team: WorkspaceImportPlan["team"] = [];
  const teamEmails = new Set<string>();
  let ownersAsAdmins = 0;
  for (const member of file.team) {
    const normalizedEmail = normalizeTransferEmail(member.email);
    if (teamEmails.has(normalizedEmail)) { skipped.teamMembers++; continue; }
    teamEmails.add(normalizedEmail);
    if (member.role === "owner") ownersAsAdmins++;
    team.push({ email: member.email.trim(), normalizedEmail, role: member.role === "owner" ? "admin" : member.role });
  }
  if (ownersAsAdmins) warnings.push("A workspace has one owner, so a previous owner is invited as an admin.");

  let defaultTimezone = file.workspace.defaultTimezone ?? null;
  if (defaultTimezone && !validTransferTimezone(defaultTimezone)) {
    warnings.push(`The timezone ${defaultTimezone} is not recognized here, so the workspace keeps its current timezone.`);
    defaultTimezone = null;
  }

  return {
    exportedAt: file.exportedAt,
    source: { edition: file.source.edition ?? null, appVersion: file.source.appVersion ?? null },
    workspace: {
      name: file.workspace.name,
      defaultTimezone,
      dailySendCap: file.workspace.dailySendCap ?? null,
      killSwitchEnabled: file.workspace.killSwitchEnabled === true,
      openTrackingEnabled: file.workspace.openTrackingEnabled ?? null,
      postalAddress: file.workspace.postalAddress?.trim() || null,
    },
    leads,
    lists,
    suppressions,
    sequences,
    team,
    mailboxes: file.mailboxes.map((mailbox) => ({
      email: mailbox.email ? normalizeTransferEmail(mailbox.email) : null,
      provider: mailbox.provider,
      displayName: textOrNull(mailbox.displayName),
      dailyLimit: mailbox.dailyLimit ?? null,
      sendingWindows: mailbox.sendingWindows.length,
    })),
    skipped,
    warnings,
  };
}

// Database rows in, file out. Anything that points outside the rows given
// (another workspace's list, lead, sequence or mailbox) is dropped, never resolved.
export type WorkspaceExportSnapshot = {
  exportedAt: Date;
  source?: { edition?: string | null; appVersion?: string | null };
  workspace: {
    name: string;
    defaultTimezone: string;
    dailySendCap: number;
    killSwitchEnabled: boolean;
    openTrackingEnabled: boolean;
    postalAddress: string | null;
  };
  contacts: Array<{
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    company: string | null;
    title: string | null;
    website: string | null;
    phone: string | null;
    location: string | null;
    linkedinUrl: string | null;
    source: string | null;
    lawfulBasisNote: string | null;
    customFields: unknown;
    status: string;
    repliedAt: Date | null;
    bouncedAt: Date | null;
    unsubscribedAt: Date | null;
    createdAt: Date;
  }>;
  lists: Array<{ id: string; name: string; description: string | null }>;
  listMembers: Array<{ contactListId: string; contactId: string }>;
  suppressions: Array<{ email: string | null; emailHash: string; reason: string; source: string; createdAt: Date }>;
  sequences: Array<{
    id: string;
    name: string;
    status: string;
    description: string;
    customVariablesEnforced: boolean;
    steps: Array<{ stepOrder: number; delayDays: number; subject: string; bodyText: string; bodyHtml: string | null }>;
  }>;
  campaigns: Array<{ sequenceId: string; name: string; status: string; emailAccountId: string; listIds: string[] }>;
  leadVariables: Array<{ sequenceId: string; contactId: string; values: unknown }>;
  // A removed mailbox still names the sender of its old campaigns, but is not
  // listed as one to reconnect.
  mailboxes: Array<{
    id: string;
    email: string | null;
    provider: string;
    displayName: string | null;
    timezone: string;
    dailyLimit: number;
    hourlyLimit: number;
    removed?: boolean;
    sendingWindows: Array<{ dayOfWeek: number; startTime: string; endTime: string; timezone: string; isActive: boolean }>;
  }>;
  team: Array<{ email: string; role: "owner" | "admin" | "member" }>;
};

// Drops null, undefined and empty-object fields so 100,000 leads stay small.
function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined
    && !(typeof item === "object" && !Array.isArray(item) && Object.keys(item as object).length === 0))) as T;
}

function iso(value: Date | null | undefined): string | undefined {
  return value ? value.toISOString() : undefined;
}

function variableValues(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
    const sanitized = sanitizeVariableValue(item);
    if (sanitized !== undefined) result[name.slice(0, CUSTOM_FIELD_KEY_MAX)] = sanitized;
  }
  return result;
}

export function assembleWorkspaceExport(snapshot: WorkspaceExportSnapshot): WorkspaceTransferFile {
  const contactEmail = new Map(snapshot.contacts.map((contact) => [contact.id, contact.email]));
  const listName = new Map(snapshot.lists.map((list) => [list.id, list.name]));
  const mailboxEmail = new Map(snapshot.mailboxes.map((mailbox) => [mailbox.id, mailbox.email]));
  const sequenceIds = new Set(snapshot.sequences.map((sequence) => sequence.id));

  const membersByList = new Map<string, string[]>();
  for (const member of snapshot.listMembers) {
    const memberEmail = contactEmail.get(member.contactId);
    if (!memberEmail || !listName.has(member.contactListId)) continue;
    const members = membersByList.get(member.contactListId) ?? [];
    members.push(memberEmail);
    membersByList.set(member.contactListId, members);
  }

  const campaignsBySequence = new Map<string, WorkspaceTransferSequence["campaigns"]>();
  for (const campaign of snapshot.campaigns) {
    if (!sequenceIds.has(campaign.sequenceId)) continue;
    const campaigns = campaignsBySequence.get(campaign.sequenceId) ?? [];
    campaigns.push(compact({
      name: campaign.name,
      status: campaign.status,
      listNames: campaign.listIds.flatMap((id) => listName.get(id) ?? []),
      senderEmail: mailboxEmail.get(campaign.emailAccountId) ?? null,
    }));
    campaignsBySequence.set(campaign.sequenceId, campaigns);
  }

  const variablesBySequence = new Map<string, WorkspaceTransferSequence["leadVariables"]>();
  for (const row of snapshot.leadVariables) {
    const leadEmail = contactEmail.get(row.contactId);
    if (!leadEmail || !sequenceIds.has(row.sequenceId)) continue;
    const values = variableValues(row.values);
    if (!Object.keys(values).length) continue;
    const rows = variablesBySequence.get(row.sequenceId) ?? [];
    rows.push({ email: leadEmail, values });
    variablesBySequence.set(row.sequenceId, rows);
  }

  return {
    format: WORKSPACE_TRANSFER_FORMAT,
    version: WORKSPACE_TRANSFER_VERSION,
    exportedAt: snapshot.exportedAt.toISOString(),
    source: compact({ edition: snapshot.source?.edition ?? null, appVersion: snapshot.source?.appVersion ?? null }),
    workspace: {
      name: snapshot.workspace.name,
      defaultTimezone: snapshot.workspace.defaultTimezone,
      dailySendCap: snapshot.workspace.dailySendCap,
      killSwitchEnabled: snapshot.workspace.killSwitchEnabled,
      openTrackingEnabled: snapshot.workspace.openTrackingEnabled,
      postalAddress: snapshot.workspace.postalAddress,
    },
    leads: snapshot.contacts.map((contact) => compact({
      email: contact.email,
      firstName: contact.firstName || null,
      lastName: contact.lastName || null,
      company: contact.company || null,
      title: contact.title || null,
      website: contact.website || null,
      phone: contact.phone || null,
      location: contact.location || null,
      linkedinUrl: contact.linkedinUrl || null,
      source: contact.source || null,
      lawfulBasisNote: contact.lawfulBasisNote || null,
      customFields: normalizeCustomFields(contact.customFields),
      status: importedLeadStatus(contact.status) === "active" ? null : contact.status,
      repliedAt: iso(contact.repliedAt),
      bouncedAt: iso(contact.bouncedAt),
      unsubscribedAt: iso(contact.unsubscribedAt),
      createdAt: iso(contact.createdAt),
    })),
    lists: snapshot.lists.map((list) => compact({ name: list.name, description: list.description || null, leadEmails: membersByList.get(list.id) ?? [] })),
    suppressions: snapshot.suppressions.map((suppression) => compact({
      email: suppression.email,
      emailHash: suppression.email ? null : suppression.emailHash,
      reason: suppression.reason,
      source: suppression.source,
      createdAt: iso(suppression.createdAt),
    })),
    sequences: snapshot.sequences.map((sequence) => compact({
      name: sequence.name,
      description: sequence.description || null,
      status: sequence.status,
      customVariablesEnforced: sequence.customVariablesEnforced,
      steps: sequence.steps.slice().sort((left, right) => left.stepOrder - right.stepOrder).map((step) => compact({
        delayDays: step.delayDays,
        subject: step.subject,
        bodyText: step.bodyText,
        bodyHtml: step.bodyHtml,
      })),
      campaigns: campaignsBySequence.get(sequence.id) ?? [],
      leadVariables: variablesBySequence.get(sequence.id) ?? [],
    })),
    mailboxes: snapshot.mailboxes.filter((mailbox) => !mailbox.removed).map((mailbox) => compact({
      email: mailbox.email,
      provider: mailbox.provider,
      displayName: mailbox.displayName,
      timezone: mailbox.timezone,
      dailyLimit: mailbox.dailyLimit,
      hourlyLimit: mailbox.hourlyLimit,
      sendingWindows: mailbox.sendingWindows.map((window) => ({ ...window })),
    })),
    team: snapshot.team.map((member) => ({ email: member.email, role: member.role })),
  } as WorkspaceTransferFile;
}

export function workspaceExportFilename(workspaceName: string, exportedAt: Date): string {
  const slug = workspaceName.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  return `inboxjoy-${slug || "workspace"}-${exportedAt.toISOString().slice(0, 10)}.json`;
}
