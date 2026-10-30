import cors, { type FastifyCorsOptions } from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { createComposioClient, type ComposioClient } from "@inboxjoy/composio";
import { buildSecretKeyMap, campaignDisplayStatuses, sendingPlan, createSequenceDraftClient, enrollNewListLeads, enrollWaitingLeads, isBuiltInOrAliasVariable, jsonbMergeSql, loadLeadVariables, machineForbiddenField, MCP_ADMIN_OPERATIONS, OpError, operationAvailableInEdition, operations, readDeliveryAdvisor, renderTemplateWithPlaceholders, requireVerifiedWorkspaceOwner, refreshLeadsAfterFieldChange, rerenderQueuedMessages, requireWorkspaceManager, runOperation, MAX_VARIABLE_VALUE_LENGTH, sanitizeVariableValue, upsertLeadVariables, VARIABLE_NAME_PATTERN, ZodError, type BillingClient, type CampaignDisplayStatus, type CampaignStatusReason, type CampaignUpdate, type SequenceDraftClient, applySuppression as applyCoreSuppression, type ApplySuppressionInput, type LeadVariableSource, type RenderOptions } from "@inboxjoy/core";
import { corsOrigins, isDeliveryAdvisorEnabled, loadAppEnv, resolveEdition, resolveSetupToken, resolveSignupMode, type AppEnv } from "@inboxjoy/config";
import { createDb, type InboxJoyDb, schema } from "@inboxjoy/db";
import { appendUnsubscribeFooter, createUnsubscribeToken, renderEmailHtml, unsubscribeTokenHash, verifyUnsubscribeToken, type TransactionalEmailService } from "@inboxjoy/email";
import { createMailClientResolver } from "@inboxjoy/smtp";
import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from "fastify";
import rawBody from "fastify-raw-body";
import { createHash, randomUUID } from "node:crypto";
import { fromNodeHeaders } from "better-auth/node";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createAuth, hasSignInAccount, provisionWorkspace, transactionalEmailFromEnv } from "./auth.js";
import { resolveOAuthToken } from "./mcp-oauth.js";
import { registerAffiliateRoutes } from "./modules/affiliate/index.js";
import { createDodoBillingClient, registerBillingRoutes } from "./modules/billing/index.js";
import { registerInboxRoutes, type InboxSmtpOptions } from "./modules/inboxes/index.js";
import { registerTrackingRoutes, trackingPathPattern } from "./modules/tracking/index.js";
import { registerWebhookRoutes } from "./modules/webhooks/index.js";
import { registerWorkspaceTransferRoutes } from "./modules/workspace-transfer/index.js";
import { createPostHogServer, type ApiPostHog } from "./posthog.js";

declare module "fastify" {
  interface FastifyRequest {
    workspaceId: string;
    workspaceRole: "owner" | "admin" | "member";
    userId: string;
    // How the request authenticated. API keys are workspace-scoped machine
    // credentials and never reach admin-only operations (MCP_ADMIN_OPERATIONS).
    authKind: "api_key" | "session";
  }
}

const API_KEY_FORBIDDEN_MESSAGE = "API keys cannot access this route. Use a browser session.";

export type BuildAppOptions = {
  env?: AppEnv;
  db?: InboxJoyDb;
  readyCheck?: () => Promise<{ ready: false; reason: string } | void>;
  startedAt?: Date;
  composio?: ComposioClient;
  smtp?: InboxSmtpOptions;
  dodo?: BillingClient;
  ai?: SequenceDraftClient;
  transactionalEmail?: TransactionalEmailService;
  posthog?: ApiPostHog;
};

type Provider = "gmail" | "outlook";
type MailboxStatus = "active" | "connecting" | "expired" | "paused" | "error";
type ImportMode = "add_only" | "update_only" | "add_and_update";
type ImportAction = "create" | "update" | "unchanged" | "duplicate" | "suppressed" | "rejected" | "not_found";
type ImportRowStatus = "ready" | "invalid" | "duplicate" | "suppressed" | "created" | "updated" | "unchanged" | "skipped";
type ImportProfileField = "firstName" | "lastName" | "company" | "title" | "source";
type ImportChangedFields = Partial<Record<ImportProfileField, { before: string; after: string }>>;

type TurnstileVerification = {
  success?: unknown;
  action?: unknown;
  hostname?: unknown;
  "error-codes"?: unknown;
};

type TurnstileVerificationFailure = {
  ok: false;
  errorCodes: string[];
};

async function verifyTurnstileToken(input: {
  secret: string;
  token: string;
  remoteIp: string;
  allowedHostnames: Set<string>;
}): Promise<{ ok: true } | TurnstileVerificationFailure> {
  const body = new URLSearchParams({
    secret: input.secret,
    response: input.token,
    remoteip: input.remoteIp,
  });

  let response: Response;
  try {
    response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, errorCodes: ["network-error"] };
  }

  let parsedResult: unknown;
  try {
    parsedResult = await response.json();
  } catch {
    return { ok: false, errorCodes: [response.ok ? "invalid-json" : `http-${response.status}`] };
  }
  if (typeof parsedResult !== "object" || parsedResult === null || Array.isArray(parsedResult)) {
    return { ok: false, errorCodes: ["invalid-json"] };
  }
  const result = parsedResult as TurnstileVerification;

  const siteverifyErrorCodes = Array.isArray(result["error-codes"])
    ? result["error-codes"].filter((code): code is string => typeof code === "string")
    : [];
  if (!response.ok) {
    return { ok: false, errorCodes: siteverifyErrorCodes.length > 0 ? siteverifyErrorCodes : [`http-${response.status}`] };
  }
  if (result.success !== true) {
    return { ok: false, errorCodes: siteverifyErrorCodes.length > 0 ? siteverifyErrorCodes : ["verification-failed"] };
  }
  if (result.action !== "signup") {
    return { ok: false, errorCodes: ["action-mismatch"] };
  }
  if (typeof result.hostname !== "string" || result.hostname.length === 0) {
    return { ok: false, errorCodes: ["hostname-missing"] };
  }
  if (input.allowedHostnames.size === 0) {
    return { ok: false, errorCodes: ["hostname-allowlist-empty"] };
  }
  if (!input.allowedHostnames.has(result.hostname)) {
    return { ok: false, errorCodes: ["hostname-not-allowed"] };
  }
  return { ok: true };
}

type Mailbox = {
  id: string;
  provider: Provider;
  email: string;
  displayName: string;
  alias: string;
  status: MailboxStatus;
  timezone: string;
  dailyLimit: number;
  hourlyLimit: number;
  sentToday: number;
  composioConnectedAccountId: string;
  connectMode: "demo";
  lastHealthCheckAt: string;
};

type Lead = {
  id: string;
  email: string;
  normalizedEmail: string;
  firstName: string;
  lastName: string;
  company: string;
  title: string;
  source: string;
  status: "Ready" | "Enrolled" | "Replied" | "Suppressed" | "Bounced" | "Unsubscribed";
  listName: string;
  importedAt: string;
};

type ImportPreviewRow = {
  rowNumber: number;
  email: string;
  status: ImportRowStatus;
  action: ImportAction;
  error: string | null;
  changedFields?: ImportChangedFields;
  previewSnapshot?: {
    contactId: string;
    updatedAt: string;
  };
  normalizedData: Omit<Lead, "id" | "normalizedEmail" | "status" | "importedAt">;
  // Cleaned values of the mapped custom:<name> columns (non-empty cells only). Stored with
  // the row for commit; never sent to the client.
  customValues?: Record<string, string>;
};

type ImportPreview = {
  id: string;
  fileName: string;
  listName: string;
  listId?: string;
  mode: ImportMode;
  status: "draft" | "validating" | "ready" | "committed" | "failed" | "cancelled";
  fieldMapping: Record<string, string>;
  customFields: string[];
  variablesSequenceId?: string;
  stats: {
    totalRows: number;
    readyRows: number;
    createRows: number;
    updateRows: number;
    unchangedRows: number;
    duplicateRows: number;
    suppressedRows: number;
    rejectedRows: number;
    skippedRows: number;
    createdRows: number;
    updatedRows: number;
  };
  rows: ImportPreviewRow[];
  createdAt: string;
};

type ExistingImportContact = {
  id: string;
  email: string;
  normalizedEmail: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  title: string | null;
  source: string | null;
  status: string;
  updatedAt: Date;
  customFields?: unknown;
};

const customFieldPrefix = "custom:";
const importModes = new Set<ImportMode>(["add_only", "update_only", "add_and_update"]);
const importProfileFields: ImportProfileField[] = ["firstName", "lastName", "company", "title", "source"];
const maximumCsvBytes = 5_000_000;
const maximumImportRows = 10_000;

type SequenceStep = {
  id: string;
  delayDays: number;
  subject: string;
  body: string;
};

type Sequence = {
  id: string;
  name: string;
  description: string;
  status: "draft" | "published" | "paused" | "archived";
  displayStatus?: CampaignDisplayStatus;
  statusReason?: CampaignStatusReason;
  completedAt?: string | null;
  steps: SequenceStep[];
  enrolledCount: number;
  createdAt: string;
  updatedAt: string;
};

const suppressedEmails = new Set(["theo@canopy.co", "unsubscribe@example.com"]);
const pendingConnects = new Map<string, { provider: Provider; expiresAt: Date }>();

const mailboxes: Mailbox[] = [
  {
    id: "10000000-0000-4000-8000-000000000001",
    provider: "gmail",
    email: "maya@acme.io",
    displayName: "Maya Chen",
    alias: "maya-gmail",
    status: "expired",
    timezone: "America/New_York",
    dailyLimit: 50,
    hourlyLimit: 8,
    sentToday: 44,
    composioConnectedAccountId: "demo_composio_gmail_maya",
    connectMode: "demo",
    lastHealthCheckAt: new Date(Date.now() - 1000 * 60 * 18).toISOString(),
  },
  {
    id: "10000000-0000-4000-8000-000000000002",
    provider: "outlook",
    email: "leo@acme.io",
    displayName: "Leo Rivera",
    alias: "leo-outlook",
    status: "active",
    timezone: "America/New_York",
    dailyLimit: 50,
    hourlyLimit: 8,
    sentToday: 26,
    composioConnectedAccountId: "demo_composio_outlook_leo",
    connectMode: "demo",
    lastHealthCheckAt: new Date(Date.now() - 1000 * 60 * 7).toISOString(),
  },
];

const leads: Lead[] = [
  {
    id: "20000000-0000-4000-8000-000000000001",
    email: "nora@brightpath.com",
    normalizedEmail: "nora@brightpath.com",
    firstName: "Nora",
    lastName: "Patel",
    company: "Brightpath",
    title: "VP Sales",
    source: "CSV import",
    status: "Replied",
    listName: "Founder intro",
    importedAt: new Date(Date.now() - 1000 * 60 * 60 * 26).toISOString(),
  },
  {
    id: "20000000-0000-4000-8000-000000000002",
    email: "evan@northstarlabs.com",
    normalizedEmail: "evan@northstarlabs.com",
    firstName: "Evan",
    lastName: "Kim",
    company: "Northstar Labs",
    title: "Founder",
    source: "Lead source",
    status: "Enrolled",
    listName: "Demo invite",
    importedAt: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
  },
];
const memoryLeadVersions = new Map(leads.map((lead) => [lead.id, lead.importedAt]));

const imports = new Map<string, ImportPreview>();
const sequences: Sequence[] = [
  {
    id: "30000000-0000-4000-8000-000000000001",
    name: "Founder intro",
    description: "A short, thoughtful introduction for new prospects.",
    status: "published",
    steps: [
      { id: randomUUID(), delayDays: 0, subject: "Quick introduction", body: "Hi {{firstName}},\n\nI wanted to reach out about {{company}}." },
      { id: randomUUID(), delayDays: 3, subject: "Following up", body: "Hi {{firstName}},\n\nJust following up on my note." },
    ],
    enrolledCount: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

function sequenceStep(input: unknown): SequenceStep | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  const subject = typeof value.subject === "string" ? value.subject.trim() : "";
  const body = typeof value.body === "string" ? value.body.trim() : "";
  const delayDays = typeof value.delayDays === "number" && Number.isInteger(value.delayDays) ? value.delayDays : 0;
  if (!subject || !body || delayDays < 0 || delayDays > 90) return null;
  return { id: typeof value.id === "string" ? value.id : randomUUID(), delayDays, subject, body };
}

function sequencePayload(body: unknown): { name: string; description: string; steps: SequenceStep[] } | null {
  if (!body || typeof body !== "object") return null;
  const value = body as Record<string, unknown>;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const description = typeof value.description === "string" ? value.description.trim() : "";
  const rawSteps = Array.isArray(value.steps) ? value.steps : [];
  const steps = rawSteps.map(sequenceStep);
  if (!name || name.length > 120 || steps.length === 0 || steps.length > 20 || steps.some((step) => !step)) return null;
  return { name, description, steps: steps as SequenceStep[] };
}

function isProvider(value: unknown): value is Provider {
  return value === "gmail" || value === "outlook";
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function titleCase(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    const next = csv[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(cell.trim());
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(cell.trim());
      if (row.some((value) => value.length > 0)) {
        rows.push(row);
      }
      row = [];
      cell = "";
      continue;
    }

    cell += char ?? "";
  }

  if (inQuotes) {
    throw new Error("CSV contains an unterminated quoted field.");
  }

  row.push(cell.trim());
  if (row.some((value) => value.length > 0)) {
    rows.push(row);
  }

  return rows;
}

function headerKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Returns the variable name for a "custom:<name>" import target, or null when the
// target is a built-in field. Throws for custom targets that cannot be stored as a variable.
function customTargetName(field: string): string | null {
  if (!field.startsWith(customFieldPrefix)) return null;
  const name = field.slice(customFieldPrefix.length);
  if (!VARIABLE_NAME_PATTERN.test(name)) throw new Error(`"${name}" is not a valid custom field name. Use letters, digits and underscores, starting with a letter (max 64 characters).`);
  if (isBuiltInOrAliasVariable(name)) throw new Error(`"${name}" is a built-in lead field. Map that column to the lead field instead of a custom field.`);
  return name;
}

function detectFieldMapping(headers: string[], provided?: Record<string, string>): Record<string, string> {
  const aliases: Record<string, string[]> = {
    email: ["email", "emailaddress", "workemail"],
    firstName: ["firstname", "first", "givenname"],
    lastName: ["lastname", "last", "surname", "familyname"],
    company: ["company", "account", "organization", "organisation"],
    title: ["title", "jobtitle", "role"],
    source: ["source", "leadsource"],
  };
  const normalizedHeaders = new Map(headers.map((header) => [headerKey(header), header]));
  const mapping: Record<string, string> = {};

  if (provided !== undefined) {
    const entries = Object.entries(provided);
    const looksLikeField = (field: string) => Object.hasOwn(aliases, field) || field.startsWith(customFieldPrefix);
    const headerToField = entries.every(([header, field]) => headers.includes(header) && looksLikeField(field));
    for (const [key, value] of entries) {
      const field = headerToField ? value : key;
      const header = headerToField ? key : value;
      if ((!Object.hasOwn(aliases, field) && !field.startsWith(customFieldPrefix)) || !headers.includes(header)) {
        throw new Error(`Invalid column mapping for "${key}".`);
      }
      customTargetName(field);
      if (mapping[field]) throw new Error(`Map only one column to ${field}.`);
      mapping[field] = header;
    }
    return mapping;
  }

  for (const [field, choices] of Object.entries(aliases)) {
    const match = choices.map((choice) => normalizedHeaders.get(choice)).find(Boolean);
    if (match) mapping[field] = match;
  }

  return mapping;
}

function cell(row: Record<string, string>, mapping: Record<string, string>, field: string): string {
  const header = mapping[field];
  return header ? row[header]?.trim() ?? "" : "";
}

export function buildImportPreview(input: {
  csv: string;
  fileName?: string;
  fieldMapping?: Record<string, string>;
  listName?: string;
  listId?: string;
  mode?: ImportMode;
  variablesSequenceId?: string;
  existingContacts?: Map<string, ExistingImportContact>;
  suppressed?: Set<string>;
}): ImportPreview {
  if (Buffer.byteLength(input.csv, "utf8") > maximumCsvBytes) throw new Error("CSV is too large (maximum 5 MB).");
  const parsed = parseCsv(input.csv);
  if (parsed.length > maximumImportRows + 1) throw new Error(`CSV has too many rows (maximum ${maximumImportRows.toLocaleString()} leads).`);
  const rawHeaders = parsed[0]?.map((header) => header.trim()) ?? [];
  const headers = rawHeaders.filter(Boolean);

  if (headers.length === 0) {
    throw new Error("CSV needs a header row.");
  }
  if (headers.length > 50) throw new Error("CSV has too many columns (maximum 50).");
  if (headers.length !== rawHeaders.length) throw new Error("CSV column names cannot be blank.");
  if (new Set(headers.map(headerKey)).size !== headers.length) throw new Error("CSV column names must be unique.");

  const mapping = detectFieldMapping(headers, input.fieldMapping);
  if (!mapping.email) {
    throw new Error("Map an email column before importing.");
  }

  const mode = input.mode ?? "add_only";
  const customFields = Object.keys(mapping).flatMap((field) => { const name = customTargetName(field); return name ? [name] : []; }).sort();
  const existingContacts = input.existingContacts ?? new Map<string, ExistingImportContact>(leads.map((lead) => [lead.normalizedEmail, {
    id: lead.id,
    email: lead.email,
    normalizedEmail: lead.normalizedEmail,
    firstName: lead.firstName,
    lastName: lead.lastName,
    company: lead.company,
    title: lead.title,
    source: lead.source,
    status: lead.status.toLowerCase(),
    updatedAt: new Date(memoryLeadVersions.get(lead.id) ?? lead.importedAt),
  }]));
  const suppressed = input.suppressed ?? suppressedEmails;
  const seen = new Set<string>();
  const rows: ImportPreviewRow[] = [];

  for (const [index, values] of parsed.slice(1).entries()) {
    if (values.length > headers.length) {
      rows.push({
        rowNumber: index + 2,
        email: "",
        status: "invalid",
        action: "rejected",
        error: "Row has more columns than the header",
        normalizedData: { email: "", firstName: "", lastName: "", company: "", title: "", source: "CSV import", listName: input.listName?.trim() || "Imported leads" },
      });
      continue;
    }
    const rawRow = Object.fromEntries(headers.map((header, headerIndex) => [header, values[headerIndex]?.trim() ?? ""]));
    const email = cell(rawRow, mapping, "email");
    const normalizedEmail = normalizeEmail(email);
    let status: ImportRowStatus = "ready";
    let action: ImportAction = "create";
    let error: string | null = null;
    let changedFields: ImportChangedFields | undefined;
    let previewSnapshot: ImportPreviewRow["previewSnapshot"];
    const existing = existingContacts.get(normalizedEmail);
    const rawCustom = Object.fromEntries(customFields.map((name) => [name, cell(rawRow, mapping, `${customFieldPrefix}${name}`)]));
    const customValues: Record<string, string> = {};
    for (const [name, raw] of Object.entries(rawCustom)) {
      const value = sanitizeVariableValue(raw);
      if (value !== undefined) customValues[name] = value;
    }
    const mappedData: Record<ImportProfileField, string> = {
      firstName: titleCase(cell(rawRow, mapping, "firstName")),
      lastName: titleCase(cell(rawRow, mapping, "lastName")),
      company: cell(rawRow, mapping, "company"),
      title: cell(rawRow, mapping, "title"),
      source: cell(rawRow, mapping, "source"),
    };

    if (!isValidEmail(normalizedEmail)) {
      status = "invalid";
      action = "rejected";
      error = "Invalid email";
    } else if (email.length > 320 || mappedData.firstName.length > 120 || mappedData.lastName.length > 120 || mappedData.company.length > 180 || mappedData.title.length > 180 || mappedData.source.length > 120 || Object.values(rawCustom).some((value) => value.length > MAX_VARIABLE_VALUE_LENGTH)) {
      status = "invalid";
      action = "rejected";
      error = "One or more fields exceed the allowed length";
    } else if (seen.has(normalizedEmail)) {
      status = "duplicate";
      action = "duplicate";
      error = "Duplicate email in file";
    } else if (suppressed.has(normalizedEmail) || existing?.status === "suppressed") {
      status = "suppressed";
      action = "suppressed";
      error = "Suppressed";
    } else if (existing) {
      previewSnapshot = { contactId: existing.id, updatedAt: existing.updatedAt.toISOString() };
      // Custom columns count as a change when a non-empty cell differs from what is stored
      // (campaign values are always rewritten; lead custom fields are compared).
      const customChanged = Object.entries(customValues).some(([name, value]) => input.variablesSequenceId || sanitizeVariableValue(objectValue(existing.customFields)[name]) !== value);
      if (mode === "add_only" && !customChanged) {
        status = "unchanged";
        action = "unchanged";
        error = "Lead already exists";
      } else if (mode === "add_only") {
        // Add-only never touches a lead's standard fields, but custom cells (e.g. a new
        // {{icebreaker}} line) are still written: the row is a custom-only update.
        action = "update";
      } else {
        const changes: ImportChangedFields = {};
        for (const field of importProfileFields) {
          const after = mappedData[field];
          if (!mapping[field] || !after) continue;
          const before = existing[field] ?? "";
          if (before !== after) changes[field] = { before, after };
        }
        if (Object.keys(changes).length > 0 || customChanged) {
          action = "update";
          if (Object.keys(changes).length > 0) changedFields = changes;
        } else {
          status = "unchanged";
          action = "unchanged";
        }
      }
    } else if (mode === "update_only") {
      status = "skipped";
      action = "not_found";
      error = "Lead not found";
    }

    if (isValidEmail(normalizedEmail)) seen.add(normalizedEmail);

    const normalizedData = {
      email: existing?.email ?? email,
      firstName: existing?.firstName ?? "",
      lastName: existing?.lastName ?? "",
      company: existing?.company ?? "",
      title: existing?.title ?? "",
      source: existing?.source ?? (mappedData.source || "CSV import"),
      listName: input.listName?.trim() || "Imported leads",
    };
    if (!existing) {
      normalizedData.firstName = mappedData.firstName;
      normalizedData.lastName = mappedData.lastName;
      normalizedData.company = mappedData.company;
      normalizedData.title = mappedData.title;
    } else if (changedFields) {
      for (const [field, change] of Object.entries(changedFields) as [ImportProfileField, { before: string; after: string }][]) normalizedData[field] = change.after;
    }

    rows.push({
      rowNumber: index + 2,
      email,
      status,
      action,
      error,
      ...(changedFields ? { changedFields } : {}),
      ...(previewSnapshot ? { previewSnapshot } : {}),
      normalizedData,
      ...(Object.keys(customValues).length && (action === "create" || action === "update") ? { customValues } : {}),
    });
  }

  const stats = {
    totalRows: rows.length,
    readyRows: rows.filter((row) => row.status === "ready").length,
    createRows: rows.filter((row) => row.action === "create").length,
    updateRows: rows.filter((row) => row.action === "update").length,
    unchangedRows: rows.filter((row) => row.action === "unchanged").length,
    duplicateRows: rows.filter((row) => row.action === "duplicate").length,
    suppressedRows: rows.filter((row) => row.action === "suppressed").length,
    rejectedRows: rows.filter((row) => row.action === "rejected").length,
    skippedRows: rows.filter((row) => row.status !== "ready").length,
    createdRows: 0,
    updatedRows: 0,
  };

  return {
    id: randomUUID(),
    fileName: input.fileName?.trim() || "leads.csv",
    listName: input.listName?.trim() || "Imported leads",
    ...(input.listId ? { listId: input.listId } : {}),
    mode,
    status: "ready",
    fieldMapping: mapping,
    customFields,
    ...(input.variablesSequenceId ? { variablesSequenceId: input.variablesSequenceId } : {}),
    stats,
    rows,
    createdAt: new Date().toISOString(),
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function importMode(value: unknown): ImportMode | null {
  if (value === undefined) return "add_only";
  return typeof value === "string" && importModes.has(value as ImportMode) ? value as ImportMode : null;
}

function importFieldMapping(value: unknown): Record<string, string> | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const object = objectValue(value);
  if (Object.keys(object).some((key) => typeof object[key] !== "string")) return null;
  return Object.fromEntries(Object.entries(object).map(([key, mappedHeader]) => [key, String(mappedHeader)]));
}

function publicImportRow(row: ImportPreviewRow): ImportPreviewRow {
  const { previewSnapshot: _previewSnapshot, customValues: _customValues, ...publicRow } = row;
  return publicRow;
}

function publicImportPreview(preview: ImportPreview): ImportPreview {
  return { ...preview, rows: preview.rows.map(publicImportRow) };
}

function importAction(value: string): ImportAction {
  return (["create", "update", "unchanged", "duplicate", "suppressed", "rejected", "not_found"] as const).includes(value as ImportAction)
    ? value as ImportAction
    : "rejected";
}

function importRowStatus(value: string): ImportRowStatus {
  return (["ready", "invalid", "duplicate", "suppressed", "created", "updated", "unchanged", "skipped"] as const).includes(value as ImportRowStatus)
    ? value as ImportRowStatus
    : "skipped";
}

function storedImportResponse(
  storedImport: typeof schema.imports.$inferSelect,
  storedRows: Array<typeof schema.importRows.$inferSelect> = [],
): ImportPreview {
  const rows = storedRows.map((row) => {
    const data = objectValue(row.normalizedData);
    const changedFields = objectValue(row.changedFields) as ImportChangedFields;
    return {
      rowNumber: row.rowNumber,
      email: typeof data.email === "string" ? data.email : row.normalizedEmail ?? "",
      status: importRowStatus(row.status),
      action: importAction(row.action),
      error: row.errorCode ?? null,
      ...(Object.keys(changedFields).length ? { changedFields } : {}),
      normalizedData: {
        email: typeof data.email === "string" ? data.email : row.normalizedEmail ?? "",
        firstName: typeof data.firstName === "string" ? data.firstName : "",
        lastName: typeof data.lastName === "string" ? data.lastName : "",
        company: typeof data.company === "string" ? data.company : "",
        title: typeof data.title === "string" ? data.title : "",
        source: typeof data.source === "string" ? data.source : "",
        listName: typeof data.listName === "string" ? data.listName : storedImport.listName ?? "Imported leads",
      },
    } satisfies ImportPreviewRow;
  });
  return {
    id: storedImport.id,
    fileName: storedImport.fileName ?? "leads.csv",
    listName: storedImport.listName ?? "Imported leads",
    ...(storedImport.contactListId ? { listId: storedImport.contactListId } : {}),
    mode: importMode(storedImport.mode) ?? "add_only",
    status: storedImport.status,
    fieldMapping: objectValue(storedImport.fieldMapping) as Record<string, string>,
    customFields: Object.keys(objectValue(storedImport.fieldMapping)).filter((field) => field.startsWith(customFieldPrefix)).map((field) => field.slice(customFieldPrefix.length)).sort(),
    ...(typeof objectValue(storedImport.options).variablesSequenceId === "string" ? { variablesSequenceId: objectValue(storedImport.options).variablesSequenceId as string } : {}),
    stats: {
      totalRows: storedImport.totalRows,
      readyRows: storedImport.readyRows,
      createRows: storedImport.createRows,
      updateRows: storedImport.updateRows,
      unchangedRows: storedImport.unchangedRows,
      duplicateRows: storedImport.duplicateRows,
      suppressedRows: storedImport.suppressedRows,
      rejectedRows: storedImport.rejectedRows,
      skippedRows: storedImport.skippedRows,
      createdRows: storedImport.createdRows,
      updatedRows: storedImport.updatedRows,
    },
    rows,
    createdAt: storedImport.createdAt.toISOString(),
  };
}

// Test sends show [name] for custom variables the chosen lead has no value for.
function renderPersonalized(value: string, lead: LeadVariableSource, options: RenderOptions = {}): string {
  return renderTemplateWithPlaceholders(value, lead, options).text;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = options.env ?? loadAppEnv();
  // Every OperationContext carries the edition: billing, the send gate and the
  // campaign status read it.
  const edition = resolveEdition(env);
  const startedAt = options.startedAt ?? new Date();
  const allowedOrigins = corsOrigins(env);
  const billingConfigured = Boolean(
    env.DODO_PAYMENTS_API_KEY
      && env.DODO_PRODUCT_LIFETIME
      && env.DODO_PAYMENTS_WEBHOOK_KEY
      && env.DODO_PAYMENTS_ENVIRONMENT === "live_mode",
  );
  const db = options.db;
  const composio = options.composio ?? createComposioClient(env.COMPOSIO_API_KEY, undefined, env.COMPOSIO_TOOLKIT_VERSION);
  const keys = buildSecretKeyMap({ current: env.MAILBOX_CREDENTIALS_KEY, previous: env.MAILBOX_CREDENTIALS_KEY_PREVIOUS });
  const mailClientResolver = db ? createMailClientResolver({ db, keys, composio, allowPrivateHosts: env.SMTP_ALLOW_PRIVATE_HOSTS }) : undefined;
  const dodo = options.dodo ?? createDodoBillingClient(env);
  // AI drafting is on when AI_API_KEY + AI_MODEL (any OpenAI-compatible API) or
  // Azure OpenAI with managed identity (our cloud) is configured; the key wins.
  const aiSettings = {
    azureOpenAIEndpoint: env.AZURE_OPENAI_ENDPOINT,
    azureOpenAIDeployment: env.AZURE_OPENAI_DEPLOYMENT,
    aiApiKey: env.AI_API_KEY,
    aiModel: env.AI_MODEL,
    aiBaseUrl: env.AI_BASE_URL,
  };
  const ai = options.ai ?? createSequenceDraftClient(aiSettings);
  const transactionalEmail = options.transactionalEmail ?? transactionalEmailFromEnv(env);
  const posthog = options.posthog ?? createPostHogServer(env);
  const turnstileHostnames = new Set(env.TURNSTILE_HOSTNAMES);
  const signupHits = new Map<string, number[]>();
  const signupAllowed = (ip: string): boolean => {
    const now = Date.now();
    if (signupHits.size > 5_000) {
      for (const [key, timestamps] of signupHits) {
        if (!timestamps.some((timestamp) => now - timestamp < 3_600_000)) signupHits.delete(key);
      }
    }
    const hits = (signupHits.get(ip) ?? []).filter((timestamp) => now - timestamp < 3_600_000);
    if (hits.length >= 5) { signupHits.set(ip, hits); return false; }
    hits.push(now);
    signupHits.set(ip, hits);
    return true;
  };

  const app = Fastify({
    bodyLimit: 6_000_000,
    logger: {
      level: env.LOG_LEVEL,
      serializers: {
        req(request) {
          return {
            method: request.method,
            url: request.url?.split("?", 1)[0],
            hostname: request.hostname,
            remoteAddress: request.ip,
          };
        },
      },
    },
    // Trust exactly one hop (Caddy). `true` trusts the whole X-Forwarded-For chain,
    // which lets a client choose its own request.ip and dodge every per-IP limit.
    // Fastify's types omit the numeric hop form, so this is the function form of 1.
    trustProxy: (_address: string, hop: number) => hop === 0,
    genReqId: (request) => {
      const incoming = request.headers["x-correlation-id"];
      return typeof incoming === "string" && incoming.length > 0 ? incoming : randomUUID();
    },
  });
  const authBackgroundTasks = new Set<Promise<unknown>>();
  const runInBackground = (task: Promise<unknown>) => {
    authBackgroundTasks.add(task);
    void task.then(
      () => authBackgroundTasks.delete(task),
      () => authBackgroundTasks.delete(task),
    );
  };
  const auth = db ? createAuth(env, db, {
    transactionalEmail,
    onEmailFailure: (failure) => {
      app.log.error(failure, "transactional email delivery failed");
    },
    onAffiliateAttributionFailure: (failure) => {
      app.log.error(failure, "affiliate attribution failed");
    },
    runInBackground,
  }) : undefined;

  app.addHook("onClose", async () => {
    await Promise.allSettled(authBackgroundTasks);
  });

  app.addHook("onClose", async () => {
    await posthog.shutdown();
  });

  app.addHook("onClose", async () => {
    mailClientResolver?.close();
  });

  app.addHook("onSend", async (_request, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: "Route not found.", correlationId: request.id });
  });

  app.decorateRequest("workspaceId", "");
  app.decorateRequest("workspaceRole", "member");
  app.decorateRequest("userId", "");

  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    errorResponseBuilder: (request, context) => ({ statusCode: 429, error: `Rate limit exceeded. Retry in ${context.after}.`, correlationId: request.id }),
  });

  await app.register(cors, () => (request: FastifyRequest, callback: (error: Error | null, options?: FastifyCorsOptions) => void) => {
    const pathname = request.url?.split("?", 1)[0] ?? "";
    if (pathname === "/mcp") {
      callback(null, {
        origin: true, // reflect the request Origin; /mcp is bearer-token authenticated, not cookie-based
        credentials: false,
        methods: ["GET", "POST", "DELETE", "OPTIONS"],
      });
      return;
    }
    callback(null, {
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["content-type", "authorization", "x-workspace-id"],
      origin: (origin, originCallback) => {
        if (!origin || allowedOrigins.includes(origin)) {
          originCallback(null, true);
          return;
        }
        const originError = Object.assign(new Error("Origin is not allowed"), { statusCode: 403 });
        originCallback(originError, false);
      },
    });
  });

  await app.register(rawBody, { global: false, encoding: "utf8" });

  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
    const params = new URLSearchParams(typeof body === "string" ? body : body.toString("utf8"));
    const parsed: Record<string, string | string[]> = {};
    for (const [key, value] of params) {
      const existing = parsed[key];
      parsed[key] = existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [existing, value];
    }
    done(null, parsed);
  });

  if (auth) {
    app.all("/v1/auth/*", async (request, reply) => {
      const pathname = request.url?.split("?", 1)[0] ?? "";
      if (pathname.includes("/sign-up")) {
        if (!signupAllowed(request.ip)) {
          return reply.header("retry-after", "3600").code(429).send({ error: "Too many signup attempts from this address. Try again later.", correlationId: request.id });
        }
        if (env.TURNSTILE_SECRET) {
          const body = request.body;
          const token = typeof body === "object" && body !== null && !Array.isArray(body)
            ? (body as Record<string, unknown>).turnstileToken
            : undefined;
          if (typeof token !== "string" || token.trim().length === 0 || token.length > 2_048) {
            return reply.code(400).send({ error: "Complete the human verification challenge and try again.", correlationId: request.id });
          }

          const verification = await verifyTurnstileToken({
            secret: env.TURNSTILE_SECRET,
            token: token.trim(),
            remoteIp: request.ip,
            allowedHostnames: turnstileHostnames,
          });
          if (!verification.ok) {
            request.log.warn({ turnstileErrorCodes: verification.errorCodes }, "Turnstile signup verification failed");
            return reply.code(403).send({ error: "We could not verify that you are human. Refresh and try again.", correlationId: request.id });
          }
        }
      }
      const headers = fromNodeHeaders(request.headers);
      headers.delete("content-length");

      const requestUrl = new URL(request.url, `${request.protocol}://${request.host}`);
      const response = await auth.handler(new Request(requestUrl, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" || request.body === undefined
          ? undefined
          : JSON.stringify(request.body),
      }));

      const cookies = response.headers.getSetCookie();
      for (const [name, value] of response.headers) {
        if (name !== "set-cookie") {
          reply.header(name, value);
        }
      }
      if (cookies.length > 0) {
        reply.header("set-cookie", cookies);
      }

      return reply.code(response.status).send(Buffer.from(await response.arrayBuffer()));
    });
  } else {
    app.all("/v1/auth/*", async (_request, reply) => reply.code(503).send({ error: "Authentication is unavailable." }));
  }

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-correlation-id", request.id);
  });

  const sessionMembership = (userId: string, workspaceId?: string) => db!.select({
    workspaceId: schema.memberships.workspaceId,
    role: schema.memberships.role,
  }).from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.status, "active"),
      workspaceId === undefined ? undefined : eq(schema.memberships.workspaceId, workspaceId)))
    .orderBy(sql`case when ${schema.memberships.workspaceId} = ${schema.users.activeWorkspaceId} then 0 else 1 end`, desc(schema.memberships.joinedAt))
    .limit(1);

  app.addHook("preHandler", async (request, reply) => {
    // request.url is the raw, still percent-encoded path, but the router decodes
    // before it matches: "/v1/%74eam/..." reaches the "/v1/team/..." handler and
    // "/v%31/..." reaches a "/v1/..." one. Every check below therefore also reads
    // the matched route pattern (undefined only when nothing matched and the
    // not-found handler runs). A request is guarded or key-forbidden if EITHER
    // spelling says so, and public only when BOTH agree, so no encoding of a path
    // can make it less protected than its plain form.
    const pathname = request.url?.split("?", 1)[0] ?? "";
    const routePath = request.routeOptions?.url;
    const either = (matches: (path: string) => boolean) => matches(pathname) || (routePath !== undefined && matches(routePath));
    const both = (matches: (path: string) => boolean, routeMatches = matches) => matches(pathname) && (routePath === undefined || routeMatches(routePath));
    const isPublicRoute = both((path) => path === "/health")
      || both((path) => path === "/ready")
      || both((path) => path === "/live")
      || both((path) => path === "/mcp")
      || both((path) => path === "/v1/guide-signup")
      || both((path) => path === "/v1/unsubscribe")
      || both((path) => path === "/v1/public/affiliate/click")
      || both((path) => path === "/v1/public/status")
      || both((path) => trackingPathPattern.test(path), (route) => route === "/t/:token.gif")
      || both((path) => path.startsWith("/v1/auth/"))
      || both((path) => path.startsWith("/v1/webhooks/"));

    if (!either((path) => path.startsWith("/v1/")) || isPublicRoute) {
      return;
    }

    const bearer = request.headers.authorization;
    if (bearer?.startsWith("Bearer ij_")) {
      const keyForbidden = either((path) => path.startsWith("/v1/api-keys")
        || path.startsWith("/v1/team")
        || path.startsWith("/v1/workspaces")
        || path.startsWith("/v1/billing")
        || (path === "/v1/workspace" && request.method === "DELETE"));
      if (keyForbidden) {
        return reply.code(403).send({ error: API_KEY_FORBIDDEN_MESSAGE, correlationId: request.id });
      }
      if (!db) return reply.code(401).send({ error: "Authentication required." });
      const keyHash = createHash("sha256").update(bearer.slice("Bearer ".length)).digest("hex");
      const [apiKeyRow] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.keyHash, keyHash)).limit(1);
      if (!apiKeyRow || apiKeyRow.revokedAt) {
        return reply.code(401).send({ error: "The API key is invalid or revoked.", correlationId: request.id });
      }
      void db.update(schema.apiKeys).set({ lastUsedAt: new Date() }).where(eq(schema.apiKeys.id, apiKeyRow.id)).catch(() => undefined);
      request.workspaceId = apiKeyRow.workspaceId;
      request.userId = apiKeyRow.createdByUserId ?? "api-key";
      request.workspaceRole = "owner";
      request.authKind = "api_key";
      return;
    }

    if (!auth) {
      return reply.code(401).send({ error: "Authentication required." });
    }

    try {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
      if (!session) {
        return reply.code(401).send({ error: "Authentication required." });
      }
      // Invitation preview/accept only need a signed-in user: the token names the
      // workspace. Requiring an existing active membership here locked out exactly
      // the people being invited (no workspace yet, or a stale tab pin).
      if (both((path) => path === "/v1/team/invitations/accept" || path === "/v1/team/invitations/preview")) {
        let [membership] = await sessionMembership(session.user.id);
        if (!membership) {
          // Same self-heal as below, so an account whose profile never got
          // provisioned still resolves its email for the invitation check.
          await provisionWorkspace(db!, session.user, undefined, {
            onEmailReleased: (placeholderUserIds) => request.log.warn({ userId: session.user.id, placeholderUserIds }, "released email held by placeholder profile"),
          }).catch((error: unknown) => {
            request.log.error({ err: error, userId: session.user.id }, "workspace self-heal provisioning failed");
          });
          [membership] = await sessionMembership(session.user.id);
        }
        request.userId = session.user.id;
        request.workspaceId = membership?.workspaceId ?? "";
        request.workspaceRole = membership?.role ?? "member";
        request.authKind = "session";
        return;
      }
      const workspaceHeader = request.headers["x-workspace-id"];
      const workspaceChanged = () => reply.code(409).send({
        error: "Your workspace changed. Reload to continue.",
        code: "workspace_changed",
        correlationId: request.id,
      });
      if (workspaceHeader !== undefined && (typeof workspaceHeader !== "string"
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspaceHeader))) {
        return workspaceChanged();
      }
      const [membership] = await sessionMembership(session.user.id, workspaceHeader);
      if (!membership) {
        if (workspaceHeader !== undefined) return workspaceChanged();
        // Self-heal: an auth user without a membership (signup provisioning failed
        // mid-way) gets their workspace created on first authenticated request.
        await provisionWorkspace(db!, session.user, undefined, {
            onEmailReleased: (placeholderUserIds) => request.log.warn({ userId: session.user.id, placeholderUserIds }, "released email held by placeholder profile"),
          }).catch((error: unknown) => {
          request.log.error({ err: error, userId: session.user.id }, "workspace self-heal provisioning failed");
        });
        const [recoveredMembership] = await sessionMembership(session.user.id);
        if (!recoveredMembership) return reply.code(403).send({ error: "No active workspace membership found." });
        request.workspaceId = recoveredMembership.workspaceId;
        request.workspaceRole = recoveredMembership.role;
        request.userId = session.user.id;
        request.authKind = "session";
        return;
      }
      request.workspaceId = membership.workspaceId;
      request.workspaceRole = membership.role;
      request.userId = session.user.id;
      request.authKind = "session";
    } catch {
      return reply.code(401).send({ error: "Authentication required." });
    }
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ errorClass: error.name, err: error }, "request failed");
    // Only genuine server-side failures (5xx) go to PostHog — routine 4xx
    // validation/auth/quota errors are expected control flow, not incidents,
    // and would drown out the real signal.
    const captureServerError = (statusCode: number) => {
      if (statusCode < 500) return;
      posthog.captureException(error, {
        route: request.routeOptions?.url ?? request.url,
        method: request.method,
        statusCode,
        reqId: request.id,
      });
    };
    if (request.url?.startsWith("/mcp") && error.code === "FST_ERR_CTP_INVALID_JSON" || error.code === "FST_ERR_CTP_INVALID_JSON_BODY") {
      return reply.status(400).send({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
    }
    if (error instanceof OpError) {
      // not_available: the operation does not exist in this edition, so it reads
      // as a missing route, not as a temporary outage.
      const statusCode = error.code === "BAD_INPUT" ? 400 : error.code === "NOT_FOUND" || error.code === "not_available" ? 404 : error.code === "CONFLICT" ? 409 : error.code === "draft_quota_exceeded" || error.code === "test_send_quota_exceeded" ? 429 : error.code === "FORBIDDEN" || error.code === "plan_limit" ? 403 : 503;
      captureServerError(statusCode);
      const detailCode = error.details && typeof error.details === "object" && "code" in error.details && typeof error.details.code === "string"
        ? error.details.code
        : undefined;
      return reply.status(statusCode).send({ error: error.message, code: detailCode ?? error.code, details: error.details, correlationId: request.id });
    }
    const statusCode = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    captureServerError(statusCode);

    reply.status(statusCode).send({
      error: statusCode >= 500 ? "Internal Server Error" : error.message,
      correlationId: request.id,
    });
  });

  const runWorkspaceOperation = async (name: string, request: FastifyRequest, input: unknown) => {
    if (!db) throw new OpError("UNAVAILABLE", "Operation storage is unavailable.");
    // REST mirrors MCP: the admin-only operations hidden from MCP tokens are
    // closed to API keys too, whatever route reached them. The route-level
    // keyForbidden list in the auth hook covers whole prefixes; this covers the
    // individual operations (suppressions.remove, sequences.delete, ...) that
    // live under otherwise key-accessible prefixes.
    if (request.authKind === "api_key" && MCP_ADMIN_OPERATIONS.has(name)) {
      throw new OpError("FORBIDDEN", API_KEY_FORBIDDEN_MESSAGE);
    }
    // Same edition filter as the MCP tool list (affiliate.* is cloud-only).
    if (!operationAvailableInEdition(name, edition)) {
      throw new OpError("not_available", "This feature is not part of the self-hosted edition.");
    }
    try {
      return await runOperation(operations.find((operation) => operation.name === name)!, {
        db,
        workspaceId: request.workspaceId,
        userId: request.userId,
        env: {
          edition,
          authSecret: env.AUTH_SECRET ?? "",
          apiBaseUrl: env.API_BASE_URL,
          webBaseUrl: env.WEB_BASE_URL,
          dodoPaymentsApiKey: env.DODO_PAYMENTS_API_KEY,
          dodoProductLifetime: env.DODO_PRODUCT_LIFETIME,
          ...aiSettings,
        },
        billing: dodo,
        ai,
        transactionalEmail,
        logger: request.log,
        composio,
        mailClientFor: mailClientResolver?.getMailClientFor,
      }, input);
    } catch (error) {
      if (error instanceof ZodError) throw new OpError("BAD_INPUT", "Invalid operation input.", error.issues);
      throw error;
    }
  };

  app.get("/live", async () => ({
    status: "ok",
    service: "inboxjoy-api",
  }));

  app.get("/health", async () => ({
    status: "ok",
    service: "inboxjoy-api",
    billingConfigured,
  }));

  app.get("/ready", async (_request, reply) => {
    try {
      const result = await options.readyCheck?.();
      if (result?.ready === false) {
        return reply.status(503).send(result);
      }
      return {
        ready: true,
        status: "ready",
        service: "inboxjoy-api",
      };
    } catch {
      reply.status(503);
      return {
        ready: false,
        status: "not_ready",
        service: "inboxjoy-api",
      };
    }
  });

  app.post<{ Body: unknown }>("/v1/guide-signup", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    const body = objectValue(request.body);
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const normalizedEmail = normalizeEmail(email);
    if (!isValidEmail(normalizedEmail)) {
      reply.status(400);
      return { error: "Enter a valid email address." };
    }
    if (!db) {
      reply.status(503);
      return { error: "Guide signup storage is unavailable." };
    }

    const source = typeof body.source === "string" && body.source.trim()
      ? body.source.trim().slice(0, 40)
      : undefined;
    const [created] = await db.insert(schema.guideSignups).values({
      id: randomUUID(),
      email,
      normalizedEmail,
      source,
    }).onConflictDoNothing({ target: schema.guideSignups.normalizedEmail }).returning({ id: schema.guideSignups.id });
    const emailDomain = normalizedEmail.slice(normalizedEmail.lastIndexOf("@") + 1);
    request.log.info({ emailDomain, created: Boolean(created) }, "guide signup received");

    // Founder alerts belong to the managed service; a self-hosted server never
    // emails us about its users.
    if (created && resolveEdition(env) === "cloud" && env.FOUNDER_ALERT_EMAIL && transactionalEmail.enabled) {
      runInBackground(transactionalEmail.sendSequenceTest({
        recipient: { email: env.FOUNDER_ALERT_EMAIL, name: "InboxJoy" },
        subject: `New guide signup: ${email}`,
        plainText: `New guide signup: ${email}`,
      }).catch((error: unknown) => {
        app.log.error({ errorClass: error instanceof Error ? error.name : "UnknownError" }, "guide signup notification failed");
      }));
    }

    return { ok: true };
  });

  app.get("/v1/system/status", async () => ({
    status: "ok",
    service: "inboxjoy-api",
    version: "v1",
    environment: env.NODE_ENV,
    billingConfigured,
    startedAt: startedAt.toISOString(),
    uptimeSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
  }));

  // Public: the sign-up, login and first-run setup screens read this before
  // anyone is signed in. needsSetup is true until the first sign-in account
  // exists; signupOpen says whether anyone (not only invitees) can sign up now;
  // setupTokenRequired says setup needs the installer's link (never the token).
  app.get("/v1/public/status", async (_request, reply) => {
    const signupMode = resolveSignupMode(env);
    const needsSetup = db ? !(await hasSignInAccount(db)) : false;
    reply.header("cache-control", "no-store");
    return {
      edition: resolveEdition(env),
      signupMode,
      signupOpen: signupMode === "open" || needsSetup,
      needsSetup,
      setupTokenRequired: needsSetup && Boolean(resolveSetupToken(env)),
    };
  });

  app.get<{ Querystring: { range?: string } }>("/v1/analytics/summary", async (request) => runWorkspaceOperation("analytics.summary", request, { range: request.query.range ? Number(request.query.range) : undefined }));
  app.get<{ Querystring: { from?: string; to?: string } }>("/v1/analytics/overview", async (request) => runWorkspaceOperation("analytics.overview", request, { from: request.query.from, to: request.query.to }));

  const markInboxExpired = registerInboxRoutes(app, env, db, composio, options.smtp);
  registerTrackingRoutes(app, db);
  // applySuppression is declared below this call, so it is referenced through a
  // thunk rather than passed directly -- the webhook only invokes it at request
  // time, long after the binding is initialised.
  registerWebhookRoutes(app, env, { db, onAccountExpired: markInboxExpired, applySuppression: (input) => applySuppression(input) });
  registerBillingRoutes(app, env, { db, client: dodo, runOperation: runWorkspaceOperation });
  // Self-host has no affiliate program: its routes, including the public click
  // endpoint, are not registered and answer 404.
  if (resolveEdition(env) === "cloud") registerAffiliateRoutes(app, { db, runOperation: runWorkspaceOperation });
  // The transfer routes check the session and owner before reading an upload,
  // with the same session and membership lookups as the auth hook above.
  registerWorkspaceTransferRoutes(app, {
    db,
    env,
    sessionUser: auth ? async (request) => (await auth.api.getSession({ headers: fromNodeHeaders(request.headers) }))?.user ?? null : undefined,
    sessionMembership: db ? sessionMembership : undefined,
  });

  // The suppression itself (row, contact, enrollment and message cascade) lives in
  // @inboxjoy/core so the worker's IMAP poller runs the identical path. Only the
  // "API booted without a database" guard stays here.
  const applySuppression = async (input: ApplySuppressionInput) => {
    if (!db) return null;
    return applyCoreSuppression(db, input);
  };

  const verifyUnsubscribeRequest = (token: unknown) => {
    if (!env.AUTH_SECRET || typeof token !== "string") return null;
    const claims = verifyUnsubscribeToken(token, env.AUTH_SECRET);
    if (!claims) return null;
    const normalizedEmail = normalizeEmail(claims.normalizedEmail);
    if (!isValidEmail(normalizedEmail)) return null;
    return { token, claims, normalizedEmail };
  };

  const processUnsubscribe = async (token: unknown, userAgent: string | undefined, ip: string) => {
    const verified = verifyUnsubscribeRequest(token);
    if (!verified) return null;
    const ipHash = createHash("sha256").update(`${env.AUTH_SECRET}:${ip}`).digest("hex");
    return applySuppression({
      workspaceId: verified.claims.workspaceId,
      contactId: verified.claims.contactId,
      email: verified.normalizedEmail,
      normalizedEmail: verified.normalizedEmail,
      reason: "unsubscribed",
      source: "one_click_unsubscribe",
      signedTokenHash: unsubscribeTokenHash(verified.token),
      userAgent,
      ipHash,
    });
  };

  app.get<{ Querystring: { token?: unknown } }>("/v1/unsubscribe", async (request, reply) => {
    const verified = verifyUnsubscribeRequest(request.query.token);
    reply.header("cache-control", "no-store").type("text/html; charset=utf-8");
    if (!verified) return reply.status(400).send("<!doctype html><title>Invalid unsubscribe link</title><main><h1>This unsubscribe link is invalid or expired.</h1></main>");
    return reply.send(`<!doctype html><title>Confirm unsubscribe</title><main><h1>Confirm unsubscribe</h1><p>Submit this request to stop sequence emails from this workspace.</p><form method="post" action="?token=${encodeURIComponent(verified.token)}"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button type="submit">Unsubscribe</button></form></main>`);
  });

  app.post<{ Querystring: { token?: unknown }; Body: Record<string, unknown> | undefined }>("/v1/unsubscribe", async (request, reply) => {
    const body = objectValue(request.body);
    const suppression = await processUnsubscribe(request.query.token ?? body.token, request.headers["user-agent"], request.ip);
    if (!suppression) { reply.status(400); return { error: "This unsubscribe link is invalid or expired." }; }
    return { unsubscribed: true };
  });

  app.get("/v1/suppressions", async (request, reply) => {
    if (!db) { reply.status(503); return { error: "Suppression storage is unavailable." }; }
    return runWorkspaceOperation("suppressions.list", request, {});
  });

  app.post<{ Body: { email?: unknown; reason?: unknown } }>("/v1/suppressions", async (request, reply) => {
    if (!db) { reply.status(503); return { error: "Suppression storage is unavailable." }; }
    const email = typeof request.body?.email === "string" ? request.body.email.trim() : "";
    const normalizedEmail = normalizeEmail(email);
    if (!isValidEmail(normalizedEmail)) { reply.status(400); return { error: "Enter a valid email address." }; }
    const reason = typeof request.body?.reason === "string" && request.body.reason.trim() ? request.body.reason.trim().slice(0, 80) : "manual_suppression";
    reply.status(201);
    return runWorkspaceOperation("suppressions.add", request, { email, reason });
  });

  app.delete<{ Params: { id: string } }>("/v1/suppressions/:id", async (request, reply) => {
    if (!db) { reply.status(503); return { error: "Suppression storage is unavailable." }; }
    await runWorkspaceOperation("suppressions.remove", request, { id: request.params.id });
    return reply.code(204).send();
  });

  app.get("/v1/workspaces", async (request) => runWorkspaceOperation("workspaces.list", request, {}));

  app.post<{ Body: { workspaceId?: unknown } }>("/v1/workspaces/switch", async (request) =>
    runWorkspaceOperation("workspaces.switch", request, request.body ?? {}));

  app.get("/v1/workspace", async (request, reply) => {
    if (!db || !auth) { reply.status(503); return { error: "Workspace settings are unavailable." }; }
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!session) { reply.status(404); return { error: "Workspace not found." }; }
    const result = await runWorkspaceOperation("workspace.get", request, {});
    return { ...result, user: { email: session.user.email } };
  });

  app.patch<{ Body: Record<string, unknown> }>("/v1/workspace", async (request, reply) => {
    if (!db) { reply.status(503); return { error: "Workspace settings are unavailable." }; }
    const body = request.body ?? {};
    // Sending controls are a person's decision: an API key may rename the
    // workspace or fix its timezone/postal address, but it cannot pause or
    // resume sending or raise the daily cap. MCP tokens get the same rule.
    if (request.authKind === "api_key" && machineForbiddenField("workspace.update", body)) {
      return reply.code(403).send({ error: API_KEY_FORBIDDEN_MESSAGE, correlationId: request.id });
    }
    return runWorkspaceOperation("workspace.update", request, body);
  });

  app.delete<{ Body: { confirmation?: unknown } }>("/v1/workspace", async (request, reply) => {
    if (!db) { reply.status(503); return { error: "Workspace settings are unavailable." }; }
    return runWorkspaceOperation("workspace.delete", request, { confirmation: request.body?.confirmation });
  });

  app.get("/v1/sending", async (request, reply) => {
    if (!db) { reply.status(503); return { error: "Sending settings are unavailable." }; }
    return runWorkspaceOperation("sending.get", request, {});
  });

  app.get("/v1/team", async (request, reply) => {
    if (!db) { reply.status(503); return { error: "Team settings are unavailable." }; }
    return runWorkspaceOperation("team.list", request, {});
  });

  app.post<{ Body: { email?: unknown; role?: unknown } }>("/v1/team/invitations", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (!db) { reply.status(503); return { error: "Team settings are unavailable." }; }
    const result = await runWorkspaceOperation("team.invite", request, request.body ?? {});
    return reply.code(201).send(result);
  });

  app.delete<{ Params: { id: string } }>("/v1/team/invitations/:id", async (request, reply) => {
    if (!db) { reply.status(503); return { error: "Team settings are unavailable." }; }
    await runWorkspaceOperation("team.inviteRevoke", request, { id: request.params.id });
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string } }>("/v1/team/members/:id", async (request, reply) => {
    if (!db) { reply.status(503); return { error: "Team settings are unavailable." }; }
    await runWorkspaceOperation("team.memberRemove", request, { id: request.params.id });
    return reply.code(204).send();
  });

  app.patch<{ Params: { id: string }; Body: { role?: unknown } }>("/v1/team/members/:id", async (request, reply) => {
    if (!db) { reply.status(503); return { error: "Team settings are unavailable." }; }
    return runWorkspaceOperation("team.memberRoleChange", request, { id: request.params.id, role: request.body?.role });
  });

  app.get<{ Querystring: { token?: unknown } }>("/v1/team/invitations/preview", async (request, reply) => {
    if (!db) { reply.status(503); return { error: "Team settings are unavailable." }; }
    return runWorkspaceOperation("team.invitePreview", request, { token: request.query?.token });
  });

  app.post<{ Body: { token?: unknown } }>("/v1/team/invitations/accept", async (request, reply) => {
    if (!db) { reply.status(503); return { error: "Team settings are unavailable." }; }
    return runWorkspaceOperation("team.inviteAccept", request, { token: request.body?.token });
  });

  const apiKeyError = (reply: import("fastify").FastifyReply, message: string) => reply.code(401).send({ error: message });
  const mcpAuthError = (reply: import("fastify").FastifyReply, message: string) => {
    reply.header("WWW-Authenticate", `Bearer error="invalid_token", resource_metadata="${env.WEB_BASE_URL}/.well-known/oauth-protected-resource"`);
    return apiKeyError(reply, message);
  };
  const resolveApiKey = async (authorization: string | undefined) => {
    if (!db || !authorization?.startsWith("Bearer ij_")) return null;
    const keyHash = createHash("sha256").update(authorization.slice("Bearer ".length)).digest("hex");
    const [apiKey] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.keyHash, keyHash)).limit(1);
    if (!apiKey || apiKey.revokedAt) return null;
    await db.update(schema.apiKeys).set({ lastUsedAt: new Date() }).where(eq(schema.apiKeys.id, apiKey.id));
    return apiKey;
  };

  app.post<{ Body: { name?: unknown } }>("/v1/api-keys", async (request, reply) => {
    if (!db) return reply.code(503).send({ error: "API key storage is unavailable." });
    const result = await runWorkspaceOperation("apiKeys.create", request, { name: request.body?.name });
    return reply.code(201).send(result);
  });

  app.get("/v1/api-keys", async (request, reply) => {
    if (!db) return reply.code(503).send({ error: "API key storage is unavailable." });
    return runWorkspaceOperation("apiKeys.list", request, {});
  });

  app.delete<{ Params: { id: string } }>("/v1/api-keys/:id", async (request, reply) => {
    if (!db) return reply.code(503).send({ error: "API key storage is unavailable." });
    await runWorkspaceOperation("apiKeys.revoke", request, { id: request.params.id });
    return reply.code(204).send();
  });

  const createMcpServer = (workspaceId: string, userId: string, scopes: string[] | null) => {
    const server = new McpServer({ name: "inboxjoy", version: "v1" });
    const registerTool = server.registerTool.bind(server) as (name: string, config: unknown, handler: (input: unknown) => Promise<unknown>) => void;
    const visibleOperations = operations
      .filter((operation) => !MCP_ADMIN_OPERATIONS.has(operation.name))
      .filter((operation) => operationAvailableInEdition(operation.name, edition))
      .filter((operation) => scopes === null || scopes.includes(`inboxjoy:${(operation as any).access ?? "write"}`));
    for (const operation of visibleOperations) {
      registerTool(`inboxjoy_${operation.name.replaceAll(".", "_")}`, { description: operation.description, inputSchema: operation.inputSchema }, async (input) => {
        const access = (operation as any).access ?? "write";
        if (scopes !== null && !scopes.includes(`inboxjoy:${access}`)) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ code: "insufficient_scope", message: `This token is missing the inboxjoy:${access} scope required for this tool.` }) }], isError: true };
        }
        const forbiddenField = machineForbiddenField(operation.name, input);
        if (forbiddenField) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ code: "FORBIDDEN", message: `${forbiddenField} can only be changed by a person signed in to InboxJoy, not through MCP.` }) }], isError: true };
        }
        try {
          const result = await runOperation(operation, {
            db: db!,
            workspaceId,
            userId,
            env: {
              edition,
              authSecret: env.AUTH_SECRET ?? "",
              apiBaseUrl: env.API_BASE_URL,
              webBaseUrl: env.WEB_BASE_URL,
              dodoPaymentsApiKey: env.DODO_PAYMENTS_API_KEY,
              dodoProductLifetime: env.DODO_PRODUCT_LIFETIME,
              ...aiSettings,
            },
            billing: dodo,
            ai,
            transactionalEmail,
            logger: app.log,
            composio,
            mailClientFor: mailClientResolver?.getMailClientFor,
          }, input);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> };
        } catch (error) {
          const opError = error instanceof OpError ? error : new OpError("BAD_INPUT", error instanceof Error ? error.message : "Operation failed.");
          return { content: [{ type: "text" as const, text: JSON.stringify({ code: opError.code, message: opError.message, details: opError.details }) }], isError: true };
        }
      });
    }
    return server;
  };

  app.get("/.well-known/oauth-protected-resource", async (_request, reply) => {
    return reply.send({
      resource: `${env.WEB_BASE_URL}/mcp`,
      authorization_servers: [env.WEB_BASE_URL],
      scopes_supported: ["inboxjoy:read", "inboxjoy:write"],
      bearer_methods_supported: ["header"],
    });
  });

  app.all("/mcp", async (request, reply) => {
    if (request.method === "GET") {
      reply.header("Allow", "POST, DELETE");
      return reply.code(405).send({ jsonrpc: "2.0", error: { code: -32000, message: "This server does not offer a standalone SSE stream; use POST." }, id: null });
    }
    const authorization = request.headers.authorization;
    const bearerToken = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
    let identity: { workspaceId: string; userId: string; scopes: string[] | null } | null = null;
    if (bearerToken.startsWith("ij_")) {
      const apiKey = await resolveApiKey(authorization);
      if (apiKey) identity = { workspaceId: apiKey.workspaceId, userId: apiKey.createdByUserId ?? "api-key", scopes: null };
    } else if (db) {
      const oauthIdentity = await resolveOAuthToken(db, bearerToken, `${env.WEB_BASE_URL}/mcp`);
      if (oauthIdentity) identity = { workspaceId: oauthIdentity.workspaceId, userId: oauthIdentity.userId, scopes: oauthIdentity.scopes };
    }
    if (!identity) {
      return mcpAuthError(reply, "A valid, non-revoked bearer token is required.");
    }
    const server = createMcpServer(identity.workspaceId, identity.userId, identity.scopes);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: [new URL(env.WEB_BASE_URL).host, new URL(env.API_BASE_URL).host, "localhost", "localhost:80", "localhost:3001", "127.0.0.1:3001"],
      // allowedOrigins intentionally omitted: bearer auth protects /mcp; browser
      // MCP clients (claude.ai, chatgpt.com) run on origins we don't control.
      // allowedHosts + enableDnsRebindingProtection still block DNS-rebinding.
    });
    try {
      await server.connect(transport);
      reply.hijack();
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      request.log.error({ err: error }, "MCP request failed");
      if (!reply.raw.headersSent) reply.raw.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
    } finally {
      await transport.close();
      await server.close();
    }
    return reply;
  });

  const readLeads = async (workspaceId: string): Promise<Lead[]> => {
    if (!db) return leads;
    const rows = await db.select().from(schema.contacts).where(eq(schema.contacts.workspaceId, workspaceId)).orderBy(desc(schema.contacts.createdAt));
    const lists = await db.select().from(schema.contactLists).where(eq(schema.contactLists.workspaceId, workspaceId));
    const members = lists.length ? await db.select().from(schema.contactListMembers).where(inArray(schema.contactListMembers.contactListId, lists.map((l) => l.id))) : [];
    const names = new Map(members.map((m) => [m.contactId, lists.find((l) => l.id === m.contactListId)?.name ?? "Imported leads"]));
    return rows.map((row) => ({ id: row.id, email: row.email, normalizedEmail: row.normalizedEmail, firstName: row.firstName ?? "", lastName: row.lastName ?? "", company: row.company ?? "", title: row.title ?? "", source: row.source ?? "", status: row.status === "replied" ? "Replied" : row.status === "suppressed" ? "Suppressed" : row.status === "enrolled" ? "Enrolled" : row.status === "bounced" ? "Bounced" : row.status === "unsubscribed" ? "Unsubscribed" : "Ready", listName: names.get(row.id) ?? "Imported leads", importedAt: row.createdAt.toISOString() }));
  };
  const readSequences = async (workspaceId: string): Promise<Sequence[]> => {
    if (!db) return sequences.map((sequence) => ({ ...sequence, mailboxIds: [], displayStatus: sequence.status === "published" ? "active" : sequence.status, statusReason: null, completedAt: null }));
    const rows = await db.select().from(schema.sequences).where(eq(schema.sequences.workspaceId, workspaceId)).orderBy(desc(schema.sequences.createdAt));
    const campaigns = await db.select().from(schema.campaigns).where(eq(schema.campaigns.workspaceId, workspaceId)).orderBy(desc(schema.campaigns.createdAt));
    const campaignBySequence = new Map<string, typeof schema.campaigns.$inferSelect>();
    for (const campaign of campaigns) {
      if (!campaignBySequence.has(campaign.sequenceId)) campaignBySequence.set(campaign.sequenceId, campaign);
    }
    const displayStatuses = await campaignDisplayStatuses(db, workspaceId, [...rows.map((sequence) => ({ id: sequence.id, sequenceId: sequence.id, status: sequence.status })), ...campaigns], edition);
    const enrollmentRows = await db.select({ sequenceId: schema.enrollments.sequenceId }).from(schema.enrollments).where(eq(schema.enrollments.workspaceId, workspaceId));
    const enrollmentCounts = enrollmentRows.reduce((counts, enrollment) => counts.set(enrollment.sequenceId, (counts.get(enrollment.sequenceId) ?? 0) + 1), new Map<string, number>());
    const result: Sequence[] = [];
    for (const row of rows) {
      const version = row.currentVersionId ? (await db.select().from(schema.sequenceVersions).where(and(eq(schema.sequenceVersions.id, row.currentVersionId), eq(schema.sequenceVersions.workspaceId, workspaceId))))[0] : undefined;
      const steps = version ? await db.select().from(schema.sequenceSteps).where(and(eq(schema.sequenceSteps.sequenceVersionId, version.id), eq(schema.sequenceSteps.workspaceId, workspaceId))).orderBy(schema.sequenceSteps.stepOrder) : [];
      const snapshot = (version?.snapshot ?? {}) as Record<string, unknown>;
      result.push({ id: row.id, name: row.name, description: typeof snapshot.description === "string" ? snapshot.description : "", status: row.status === "active" ? "published" : row.status === "paused" ? "paused" : row.status === "archived" ? "archived" : "draft", ...displayStatuses.get(campaignBySequence.get(row.id)?.id ?? row.id), completedAt: campaignBySequence.get(row.id)?.completedAt?.toISOString() ?? null, steps: steps.map((s) => ({ id: s.id, delayDays: s.delayDays, subject: s.subject, body: s.bodyText })), enrolledCount: enrollmentCounts.get(row.id) ?? 0, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });
    }
    return result;
  };

  /* Legacy demo inbox routes are intentionally replaced by the Composio-backed module above. */
  /*
  app.post<{ Body: { provider?: unknown } }>("/v1/inboxes/connect-link", async (request, reply) => {
    const provider = request.body?.provider;
    if (!isProvider(provider)) {
      reply.status(400);
      return { error: "Choose Gmail or Outlook." };
    }

    const state = randomUUID();
    const expiresAt = new Date(Date.now() + 1000 * 60 * 15);
    pendingConnects.set(state, { provider, expiresAt });
    const search = new URLSearchParams({ provider, state });

    return {
      provider,
      mode: "demo",
      connectUrl: `${env.API_BASE_URL}/v1/inboxes/connect/callback?${search.toString()}`,
      expiresAt: expiresAt.toISOString(),
      message: "Local demo connect link created. No Gmail or Outlook credentials are requested or stored.",
    };
  });

  app.get<{ Querystring: { provider?: unknown; state?: unknown } }>("/v1/inboxes/connect/callback", async (request, reply) => {
    const { provider, state } = request.query;
    const pending = typeof state === "string" ? pendingConnects.get(state) : undefined;

    if (!isProvider(provider) || !pending || pending.provider !== provider || pending.expiresAt.getTime() < Date.now()) {
      return reply.redirect(`${env.WEB_BASE_URL}/app/inboxes?connect=failed`);
    }

    pendingConnects.delete(state);
    const providerLabel = provider === "gmail" ? "Gmail" : "Outlook";
    const index = mailboxes.filter((mailbox) => mailbox.provider === provider).length + 1;
    const email = `connected-${provider}-${index}@demo.inboxjoy.local`;

    mailboxes.unshift({
      id: randomUUID(),
      provider,
      email,
      displayName: `${providerLabel} Demo Sender`,
      alias: `${provider}-${index}`,
      status: "active",
      timezone: "America/New_York",
      dailyLimit: 20,
      hourlyLimit: 5,
      sentToday: 0,
      composioConnectedAccountId: `demo_composio_${provider}_${randomUUID()}`,
      connectMode: "demo",
      lastHealthCheckAt: new Date().toISOString(),
    });

    return reply.redirect(`${env.WEB_BASE_URL}/app/inboxes?connect=${provider}`);
  });

  app.post<{ Params: { id: string } }>("/v1/inboxes/:id/reconnect", async (request, reply) => {
    const mailbox = mailboxes.find((item) => item.id === request.params.id);
    if (!mailbox) {
      reply.status(404);
      return { error: "Inbox not found." };
    }

    mailbox.status = "active";
    mailbox.lastHealthCheckAt = new Date().toISOString();
    return { inbox: mailbox };
  });

  app.patch<{ Params: { id: string }; Body: { dailyLimit?: unknown; hourlyLimit?: unknown; timezone?: unknown } }>(
    "/v1/inboxes/:id/settings",
    async (request, reply) => {
      const mailbox = mailboxes.find((item) => item.id === request.params.id);
      if (!mailbox) {
        reply.status(404);
        return { error: "Inbox not found." };
      }

      const { dailyLimit, hourlyLimit, timezone } = request.body ?? {};
      if (typeof dailyLimit === "number" && Number.isInteger(dailyLimit) && dailyLimit > 0 && dailyLimit <= 200) {
        mailbox.dailyLimit = dailyLimit;
      }
      if (typeof hourlyLimit === "number" && Number.isInteger(hourlyLimit) && hourlyLimit > 0 && hourlyLimit <= 50) {
        mailbox.hourlyLimit = hourlyLimit;
      }
      if (typeof timezone === "string" && timezone.trim().length > 0) {
        mailbox.timezone = timezone.trim();
      }

      return { inbox: mailbox };
    },
  );
  */

  app.get("/v1/leads", async (request, reply) => {
    if (!db) { reply.status(503); return { error: "Lead storage is unavailable." }; }
    const { q, status, listId, page, pageSize } = (request.query ?? {}) as Record<string, string | undefined>;
    return runWorkspaceOperation("leads.list", request, {
      q: q || undefined,
      status: status || undefined,
      listId: listId || undefined,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  });
  app.post<{ Body: unknown }>("/v1/leads", async (request, reply) => {
    const body = objectValue(request.body);
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const normalizedEmail = normalizeEmail(email);
    const profileLimits = { firstName: 120, lastName: 120, company: 180, title: 180 } as const;
    const profile: { firstName: string; lastName: string; company: string; title: string } = { firstName: "", lastName: "", company: "", title: "" };
    if (!email || email.length > 320 || !isValidEmail(normalizedEmail)) {
      return reply.status(400).send({ error: "Enter a valid email address." });
    }
    for (const [field, maxLength] of Object.entries(profileLimits) as [keyof typeof profileLimits, number][]) {
      const value = body[field];
      if (value !== undefined && typeof value !== "string") return reply.status(400).send({ error: `${field} must be a string.` });
      const trimmed = typeof value === "string" ? value.trim() : "";
      if (trimmed.length > maxLength) return reply.status(400).send({ error: `${field} is too long.` });
      profile[field] = trimmed;
    }
    const listId = body.listId;
    if (listId !== undefined && (typeof listId !== "string" || !isUuid(listId))) {
      return reply.status(400).send({ error: "listId must be a valid UUID." });
    }

    if (!db) {
      if (listId) return reply.status(404).send({ error: "List not found." });
      if (leads.some((lead) => lead.normalizedEmail === normalizedEmail)) return reply.status(409).send({ error: "A lead with this email already exists." });
      const lead: Lead = { id: randomUUID(), email, normalizedEmail, ...profile, source: "Manual", status: "Ready", listName: "Imported leads", importedAt: new Date().toISOString() };
      leads.unshift(lead);
      memoryLeadVersions.set(lead.id, lead.importedAt);
      return reply.status(201).send({ lead, campaignUpdates: [] });
    }

    const leadId = randomUUID();
    const addedLeadIds = await db.transaction(async (tx) => {
      if (typeof listId === "string") {
        const [list] = await tx.select({ id: schema.contactLists.id }).from(schema.contactLists).where(and(eq(schema.contactLists.id, listId), eq(schema.contactLists.workspaceId, request.workspaceId))).for("update").limit(1);
        if (!list) throw new OpError("NOT_FOUND", "List not found.");
      }
      const [created] = await tx.insert(schema.contacts).values({ id: leadId, workspaceId: request.workspaceId, email, normalizedEmail, ...profile, source: "Manual", status: "active", createdByUserId: request.userId }).onConflictDoNothing().returning({ id: schema.contacts.id });
      if (!created) throw new OpError("CONFLICT", "A lead with this email already exists.");
      if (typeof listId !== "string") return [];
      const added = await tx.insert(schema.contactListMembers).values({ workspaceId: request.workspaceId, contactListId: listId, contactId: leadId, addedByUserId: request.userId }).onConflictDoNothing().returning({ contactId: schema.contactListMembers.contactId });
      return added.map((row) => row.contactId);
    });
    const campaignUpdates = typeof listId === "string" ? (await enrollNewListLeads({ db, workspaceId: request.workspaceId, userId: request.userId, env: { edition, authSecret: env.AUTH_SECRET ?? "", apiBaseUrl: env.API_BASE_URL }, logger: request.log }, { listId, leadIds: addedLeadIds })).campaignUpdates : [];
    const lead = (await readLeads(request.workspaceId)).find((item) => item.id === leadId);
    return reply.status(201).send({ lead, campaignUpdates });
  });
  app.post<{ Body: unknown }>("/v1/leads/import", async (request) => runWorkspaceOperation("leads.import", request, request.body ?? {}));
  app.get<{ Params: { id: string } }>("/v1/leads/:id", async (request) => runWorkspaceOperation("leads.get", request, { id: request.params.id }));
  app.patch<{ Params: { id: string }; Body: unknown }>("/v1/leads/:id", async (request, reply) => {
    const body = objectValue(request.body);
    if (Object.prototype.hasOwnProperty.call(body, "email")) return reply.status(400).send({ error: "Lead email cannot be changed." });
    const profileLimits = { firstName: 120, lastName: 120, company: 180, title: 180 } as const;
    const updates: { firstName?: string; lastName?: string; company?: string; title?: string; updatedAt?: Date } = {};
    for (const [field, maxLength] of Object.entries(profileLimits) as [keyof typeof profileLimits, number][]) {
      if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
      const value = body[field];
      if (typeof value !== "string") return reply.status(400).send({ error: `${field} must be a string.` });
      const trimmed = value.trim();
      if (trimmed.length > maxLength) return reply.status(400).send({ error: `${field} is too long.` });
      updates[field] = trimmed;
    }
    if (Object.keys(updates).length === 0) return reply.status(400).send({ error: "Provide at least one profile field to update." });

    if (!db) {
      const lead = leads.find((item) => item.id === request.params.id);
      if (!lead) return reply.status(404).send({ error: "Lead not found." });
      Object.assign(lead, updates);
      memoryLeadVersions.set(lead.id, new Date().toISOString());
      return { lead };
    }
    updates.updatedAt = new Date();
    const [updated] = await db.update(schema.contacts).set(updates).where(and(eq(schema.contacts.id, request.params.id), eq(schema.contacts.workspaceId, request.workspaceId))).returning({ id: schema.contacts.id });
    if (!updated) return reply.status(404).send({ error: "Lead not found." });
    const lead = (await readLeads(request.workspaceId)).find((item) => item.id === updated.id);
    return { lead };
  });
  app.post<{ Body: { ids?: unknown } }>("/v1/leads/delete", async (request) => runWorkspaceOperation("leads.delete", request, { ids: (request.body as { ids?: unknown } | undefined)?.ids }));
  app.get("/v1/lists", async (request) => runWorkspaceOperation("lists.list", request, {}));
  app.post<{ Body: unknown }>("/v1/lists", async (request, reply) => { reply.status(201); return runWorkspaceOperation("lists.create", request, request.body ?? {}); });
  app.patch<{ Params: { id: string }; Body: unknown }>("/v1/lists/:id", async (request) => runWorkspaceOperation("lists.rename", request, { ...((request.body ?? {}) as Record<string, unknown>), id: request.params.id }));
  app.delete<{ Params: { id: string } }>("/v1/lists/:id", async (request, reply) => { await runWorkspaceOperation("lists.delete", request, { id: request.params.id }); return reply.code(204).send(); });
  app.post<{ Params: { id: string }; Body: { leadIds?: unknown } }>("/v1/lists/:id/leads", async (request) => runWorkspaceOperation("lists.addLeads", request, { id: request.params.id, leadIds: request.body?.leadIds }));

  app.get("/v1/templates", async (request) => runWorkspaceOperation("templates.list", request, {}));
  app.post<{ Body: unknown }>("/v1/sequences/draft", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request) => runWorkspaceOperation("sequences.draft", request, request.body ?? {}));
  app.post<{ Body: unknown }>("/v1/sequences/refine-step", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request) => runWorkspaceOperation("sequences.refineStep", request, request.body ?? {}));
  app.post<{ Params: { templateKey: string } }>("/v1/sequences/from-template/:templateKey", async (request, reply) => { reply.status(201); return runWorkspaceOperation("sequences.fromTemplate", request, { templateKey: request.params.templateKey }); });
  app.get<{ Querystring: { q?: string } }>("/v1/search", async (request) => runWorkspaceOperation("search.global", request, { q: request.query.q ?? "" }));
  app.get<{ Querystring: { unreadOnly?: string; limit?: string } }>("/v1/notifications", async (request) => runWorkspaceOperation("notifications.list", request, { unreadOnly: request.query.unreadOnly === "true", limit: request.query.limit ? Number(request.query.limit) : undefined }));
  app.post<{ Params: { id: string } }>("/v1/notifications/:id/read", async (request) => runWorkspaceOperation("notifications.markRead", request, { id: request.params.id }));
  app.post("/v1/notifications/read-all", async (request) => runWorkspaceOperation("notifications.markRead", request, { all: true }));
  app.get<{ Querystring: { kind?: string; campaignId?: string } }>("/v1/export.csv", async (request, reply) => { const result = await runWorkspaceOperation("export.csv", request, { kind: request.query.kind, campaignId: request.query.campaignId }) as { csv: string }; return reply.header("content-type", "text/csv; charset=utf-8").send(result.csv); });

  app.get("/v1/campaigns", async (request) => runWorkspaceOperation("campaigns.list", request, {}));
  app.post<{ Body: { campaignId?: unknown; sequenceId?: unknown; listIds?: unknown; listId?: unknown } }>("/v1/campaigns/audience-preview", async (request) => runWorkspaceOperation("campaigns.audiencePreview", request, request.body ?? {}));
  app.post<{ Body: { name?: unknown; sequenceId?: unknown; listIds?: unknown; listId?: unknown; inboxId?: unknown } }>("/v1/campaigns", async (request, reply) => { reply.status(201); return runWorkspaceOperation("campaigns.create", request, request.body ?? {}); });
  app.get<{ Params: { id: string } }>("/v1/campaigns/:id", async (request) => runWorkspaceOperation("campaigns.get", request, { id: request.params.id }));
  app.patch<{ Params: { id: string }; Body: { name?: unknown; sequenceId?: unknown; listIds?: unknown; listId?: unknown; inboxId?: unknown } }>("/v1/campaigns/:id", async (request) => runWorkspaceOperation("campaigns.update", request, { id: request.params.id, ...(request.body ?? {}) }));
  app.get<{ Params: { id: string } }>("/v1/reports/campaign/:id", async (request) => runWorkspaceOperation("reports.campaign", request, { id: request.params.id }));
  for (const action of ["launch", "pause", "resume", "archive"] as const) app.post<{ Params: { id: string } }>(`/v1/campaigns/:id/${action}`, async (request) => runWorkspaceOperation(`campaigns.${action}`, request, { id: request.params.id }));

  // Delivery advisor (docs/delivery-advisor-plan.md, Phase 1A): a read-only
  // campaign projection, deliberately NOT a shared operation (no MCP
  // discovery) so the only entry point is this workspace-scoped REST route,
  // at the same authenticated read permission level as campaigns.get above.
  // Availability is enforced here, not only hidden in the UI.
  app.get<{ Params: { id: string } }>("/v1/campaigns/:id/delivery-advisor", async (request) => {
    if (!isDeliveryAdvisorEnabled(env, request.workspaceId)) return { enabled: false as const };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.params.id)) {
      throw new OpError("BAD_INPUT", "Invalid campaign id.");
    }
    if (!db) throw new OpError("UNAVAILABLE", "Operation storage is unavailable.");
    try {
      const result = await readDeliveryAdvisor(db, { workspaceId: request.workspaceId, campaignId: request.params.id, edition });
      if (!result.found) throw new OpError("NOT_FOUND", "Campaign not found.");
      return { enabled: true as const, status: result.status, asOf: result.snapshot.asOf, snapshot: result.snapshot };
    } catch (error) {
      if (error instanceof OpError) throw error;
      // A read failure (timeout, transient DB error) is safe-unavailable, not
      // a 500: existing campaign controls must stay usable either way.
      request.log.error({ err: error, campaignId: request.params.id }, "delivery advisor read failed");
      return { enabled: true as const, status: "unavailable" as const, asOf: new Date().toISOString(), snapshot: null };
    }
  });

  app.get("/v1/imports", async (request) => {
    if (!db) return { imports: Array.from(imports.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicImportPreview) };
    const rows = await db.select().from(schema.imports).where(eq(schema.imports.workspaceId, request.workspaceId)).orderBy(desc(schema.imports.createdAt));
    return { imports: rows.map((row) => storedImportResponse(row)) };
  });

  app.post<{
    Body: { csv?: unknown; fileName?: unknown; fieldMapping?: unknown; listName?: unknown; listId?: unknown; mode?: unknown; variablesSequenceId?: unknown };
  }>("/v1/imports/preview", { bodyLimit: 11_000_000, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const csv = request.body?.csv;
    if (typeof csv !== "string" || csv.trim().length === 0) {
      reply.status(400);
      return { error: "Add a CSV file or paste CSV rows first." };
    }
    const mode = importMode(request.body.mode);
    if (!mode) return reply.status(400).send({ error: "mode must be add_only, update_only, or add_and_update." });
    const fieldMapping = importFieldMapping(request.body.fieldMapping);
    if (fieldMapping === null) return reply.status(400).send({ error: "fieldMapping must map CSV columns to lead fields." });
    const fileName = typeof request.body.fileName === "string" ? request.body.fileName.trim() : "leads.csv";
    if (!fileName || fileName.length > 240) return reply.status(400).send({ error: "fileName must be between 1 and 240 characters." });
    const requestedListName = typeof request.body.listName === "string" ? request.body.listName.trim() : "Imported leads";
    if (!requestedListName || requestedListName.length > 160) return reply.status(400).send({ error: "listName must be between 1 and 160 characters." });
    const listId = request.body.listId;
    if (listId !== undefined && (typeof listId !== "string" || !isUuid(listId))) return reply.status(400).send({ error: "listId must be a valid UUID." });
    const variablesSequenceId = request.body.variablesSequenceId;
    if (variablesSequenceId !== undefined && variablesSequenceId !== null && (typeof variablesSequenceId !== "string" || !isUuid(variablesSequenceId))) return reply.status(400).send({ error: "variablesSequenceId must be a valid UUID." });
    const variablesSequence = typeof variablesSequenceId === "string" ? variablesSequenceId : undefined;

    try {
      const probe = buildImportPreview({ csv, fileName, fieldMapping, listName: requestedListName, listId: typeof listId === "string" ? listId : undefined, mode, variablesSequenceId: variablesSequence, existingContacts: new Map(), suppressed: new Set() });
      if (db && variablesSequence) {
        // Campaign variables decide what a live campaign sends: same role as campaigns.setLeadVariables.
        await requireWorkspaceManager({ db, workspaceId: request.workspaceId, userId: request.userId, env: { edition, authSecret: env.AUTH_SECRET ?? "", apiBaseUrl: env.API_BASE_URL } });
        const [sequence] = await db.select({ id: schema.sequences.id }).from(schema.sequences).where(and(eq(schema.sequences.id, variablesSequence), eq(schema.sequences.workspaceId, request.workspaceId))).limit(1);
        if (!sequence) return reply.status(404).send({ error: "Sequence not found." });
      }
      let existingContacts: Map<string, ExistingImportContact> | undefined;
      let currentSuppressions: Set<string> | undefined;
      let listName = requestedListName;
      if (db) {
        if (typeof listId === "string") {
          const [list] = await db.select({ id: schema.contactLists.id, name: schema.contactLists.name }).from(schema.contactLists).where(and(eq(schema.contactLists.id, listId), eq(schema.contactLists.workspaceId, request.workspaceId))).limit(1);
          if (!list) return reply.status(404).send({ error: "List not found." });
          listName = list.name;
        }
        const normalizedEmails = Array.from(new Set(probe.rows.map((row) => normalizeEmail(row.email)).filter((email) => isValidEmail(email))));
        const emailHashes = normalizedEmails.map((email) => createHash("sha256").update(email).digest("hex"));
        const [contactRows, suppressionRows] = normalizedEmails.length
          ? await Promise.all([
              db.select({ id: schema.contacts.id, email: schema.contacts.email, normalizedEmail: schema.contacts.normalizedEmail, firstName: schema.contacts.firstName, lastName: schema.contacts.lastName, company: schema.contacts.company, title: schema.contacts.title, source: schema.contacts.source, status: schema.contacts.status, updatedAt: schema.contacts.updatedAt, customFields: schema.contacts.customFields }).from(schema.contacts).where(and(eq(schema.contacts.workspaceId, request.workspaceId), inArray(schema.contacts.normalizedEmail, normalizedEmails))),
              db.select({ normalizedEmail: schema.suppressions.normalizedEmail, emailHash: schema.suppressions.emailHash }).from(schema.suppressions).where(and(eq(schema.suppressions.workspaceId, request.workspaceId), or(inArray(schema.suppressions.normalizedEmail, normalizedEmails), inArray(schema.suppressions.emailHash, emailHashes)))),
            ])
          : [[], []];
        existingContacts = new Map(contactRows.map((contact) => [contact.normalizedEmail, contact]));
        const emailsByHash = new Map(normalizedEmails.map((email, index) => [emailHashes[index], email]));
        currentSuppressions = new Set(suppressionRows.flatMap((item) => item.normalizedEmail ? [item.normalizedEmail] : emailsByHash.get(item.emailHash) ? [emailsByHash.get(item.emailHash)!] : []));
      }
      const preview = buildImportPreview({
        csv,
        fileName,
        fieldMapping,
        listName,
        listId: typeof listId === "string" ? listId : undefined,
        mode,
        variablesSequenceId: variablesSequence,
        existingContacts,
        suppressed: currentSuppressions,
      });
      if (db) {
        await db.transaction(async (tx) => {
          if (typeof listId === "string") {
            const [lockedList] = await tx.select({ id: schema.contactLists.id, name: schema.contactLists.name }).from(schema.contactLists).where(and(eq(schema.contactLists.id, listId), eq(schema.contactLists.workspaceId, request.workspaceId))).for("update").limit(1);
            if (!lockedList) throw new OpError("NOT_FOUND", "List not found.");
            preview.listName = lockedList.name;
            for (const row of preview.rows) row.normalizedData.listName = lockedList.name;
          }
          await tx.insert(schema.imports).values({ id: preview.id, workspaceId: request.workspaceId, contactListId: typeof listId === "string" ? listId : null, status: "ready", mode, fileName: preview.fileName, listName: preview.listName, fieldMapping: preview.fieldMapping, options: { ...(typeof listId === "string" ? { requestedListId: listId } : { createList: true }), ...(variablesSequence ? { variablesSequenceId: variablesSequence } : {}) }, totalRows: preview.stats.totalRows, readyRows: preview.stats.readyRows, createRows: preview.stats.createRows, updateRows: preview.stats.updateRows, unchangedRows: preview.stats.unchangedRows, skippedRows: preview.stats.skippedRows, duplicateRows: preview.stats.duplicateRows, suppressedRows: preview.stats.suppressedRows, rejectedRows: preview.stats.rejectedRows, createdByUserId: request.userId });
          for (let offset = 0; offset < preview.rows.length; offset += 500) {
            await tx.insert(schema.importRows).values(preview.rows.slice(offset, offset + 500).map((row) => ({ id: randomUUID(), workspaceId: request.workspaceId, importId: preview.id, rowNumber: row.rowNumber, normalizedEmail: isValidEmail(normalizeEmail(row.email)) ? normalizeEmail(row.email) : null, status: row.status, action: row.action, errorCode: row.error, normalizedData: row.normalizedData, changedFields: row.changedFields ?? {}, previewSnapshot: row.previewSnapshot ?? {}, rawData: row.customValues ? { customFields: row.customValues } : {} })));
          }
        });
      } else imports.set(preview.id, preview);
      return { import: publicImportPreview(preview) };
    } catch (error) {
      if (error instanceof OpError) throw error;
      reply.status(400);
      return { error: error instanceof Error ? error.message : "CSV import failed." };
    }
  });

  app.post<{ Params: { id: string } }>("/v1/imports/:id/commit", async (request, reply) => {
    if (!db) {
      const preview = imports.get(request.params.id);
      if (!preview) return reply.status(404).send({ error: "Import not found." });
      if (preview.status === "committed") return { import: publicImportPreview(preview), campaignUpdates: [] };
      let createdRows = 0;
      let updatedRows = 0;
      let unchangedRows = 0;
      let suppressedRows = 0;
      for (const row of preview.rows) {
        const normalizedEmail = normalizeEmail(row.email);
        const current = leads.find((lead) => lead.normalizedEmail === normalizedEmail);
        if (row.action === "suppressed" || (row.status === "ready" && suppressedEmails.has(normalizedEmail))) {
          row.status = "suppressed";
          row.action = "suppressed";
          row.error = "Suppressed";
          suppressedRows += 1;
          continue;
        }
        if (row.action === "create") {
          if (current) {
            row.status = "skipped";
            row.error = "Conflict: lead now exists";
            continue;
          }
          const createdAt = new Date().toISOString();
          const lead = { id: randomUUID(), ...row.normalizedData, normalizedEmail, status: "Ready" as const, importedAt: createdAt };
          leads.unshift(lead);
          memoryLeadVersions.set(lead.id, createdAt);
          row.status = "created";
          row.error = null;
          createdRows += 1;
          continue;
        }
        if (row.action === "update") {
          if (!current || !row.previewSnapshot || current.id !== row.previewSnapshot.contactId || (memoryLeadVersions.get(current.id) ?? current.importedAt) !== row.previewSnapshot.updatedAt) {
            row.status = "skipped";
            row.error = "Conflict: lead changed after preview";
            continue;
          }
          for (const field of importProfileFields) {
            const change = row.changedFields?.[field];
            if (change) current[field] = change.after;
          }
          current.listName = preview.listName;
          memoryLeadVersions.set(current.id, new Date().toISOString());
          row.status = "updated";
          row.error = null;
          updatedRows += 1;
          continue;
        }
        if (row.action === "unchanged") unchangedRows += 1;
      }
      preview.status = "committed";
      preview.stats = { ...preview.stats, readyRows: createdRows + updatedRows, createdRows, updatedRows, unchangedRows, suppressedRows, skippedRows: preview.stats.totalRows - createdRows - updatedRows };
      return { import: publicImportPreview(preview), campaignUpdates: [] };
    }

    const operationContext = { db, workspaceId: request.workspaceId, userId: request.userId, env: { edition, authSecret: env.AUTH_SECRET ?? "", apiBaseUrl: env.API_BASE_URL }, logger: request.log };
    // Campaign variables decide what a live campaign sends: same role as campaigns.setLeadVariables.
    const [storedOptions] = await db.select({ options: schema.imports.options }).from(schema.imports).where(and(eq(schema.imports.id, request.params.id), eq(schema.imports.workspaceId, request.workspaceId))).limit(1);
    if (typeof objectValue(storedOptions?.options).variablesSequenceId === "string") await requireWorkspaceManager(operationContext);
    const customWrites = { variablesSequenceId: undefined as string | undefined, variablesUpdated: 0, variablesRerendered: 0, variableContactIds: [] as string[], fieldChangedContactIds: [] as string[], customRows: 0 };
    const committed = await db.transaction(async (tx) => {
      const [storedImport] = await tx.select().from(schema.imports).where(and(eq(schema.imports.id, request.params.id), eq(schema.imports.workspaceId, request.workspaceId))).for("update").limit(1);
      if (!storedImport) throw new OpError("NOT_FOUND", "Import not found.");
      const rows = await tx.select().from(schema.importRows).where(and(eq(schema.importRows.importId, storedImport.id), eq(schema.importRows.workspaceId, request.workspaceId))).orderBy(schema.importRows.rowNumber);
      if (storedImport.status === "committed") return { storedImport, rows, addedLeadIds: [] as string[], alreadyCommitted: true };
      if (storedImport.status !== "ready") throw new OpError("CONFLICT", "This import is not ready. Preview the CSV again.");

      const importOptions = objectValue(storedImport.options);
      // Custom CSV columns go to campaign variables of this sequence when one was chosen
      // at preview time, otherwise onto the lead's own custom fields.
      const variablesSequenceId = typeof importOptions.variablesSequenceId === "string" ? importOptions.variablesSequenceId : undefined;
      if (variablesSequenceId) {
        const [sequence] = await tx.select({ id: schema.sequences.id }).from(schema.sequences).where(and(eq(schema.sequences.id, variablesSequenceId), eq(schema.sequences.workspaceId, request.workspaceId))).limit(1);
        if (!sequence) throw new OpError("CONFLICT", "The campaign these variables were meant for no longer exists. Preview the import again.");
      }
      const rowCustomValues = (row: typeof rows[number]): Record<string, string> => {
        const stored = objectValue(objectValue(row.rawData).customFields);
        const result: Record<string, string> = {};
        for (const [name, value] of Object.entries(stored)) {
          const cleaned = typeof value === "string" ? sanitizeVariableValue(value) : undefined;
          if (cleaned !== undefined && VARIABLE_NAME_PATTERN.test(name) && !isBuiltInOrAliasVariable(name)) result[name] = cleaned;
        }
        return result;
      };
      const variableRows: Array<{ contactId: string; variables: Record<string, string> }> = [];
      const fieldChangedIds: string[] = [];
      const addedLeadIds: string[] = [];
      const requestedListId = typeof importOptions.requestedListId === "string" ? importOptions.requestedListId : storedImport.contactListId;
      let listId = storedImport.contactListId;
      if (requestedListId) {
        const [list] = await tx.select({ id: schema.contactLists.id }).from(schema.contactLists).where(and(eq(schema.contactLists.id, requestedListId), eq(schema.contactLists.workspaceId, request.workspaceId))).for("update").limit(1);
        if (!list) throw new OpError("CONFLICT", "The selected list no longer exists. Preview the import again.");
        listId = list.id;
      } else {
        const listName = storedImport.listName ?? "Imported leads";
        const [createdList] = await tx.insert(schema.contactLists).values({ id: randomUUID(), workspaceId: request.workspaceId, name: listName, createdByUserId: request.userId }).onConflictDoNothing().returning({ id: schema.contactLists.id });
        listId = createdList?.id ?? (await tx.select({ id: schema.contactLists.id }).from(schema.contactLists).where(and(eq(schema.contactLists.workspaceId, request.workspaceId), eq(schema.contactLists.name, listName))).limit(1))[0]?.id ?? null;
        if (!listId) throw new OpError("CONFLICT", "The import list could not be created.");
      }

      const normalizedEmails = Array.from(new Set(rows.flatMap((row) => row.normalizedEmail ? [row.normalizedEmail] : [])));
      const emailHashes = normalizedEmails.map((email) => createHash("sha256").update(email).digest("hex"));
      const currentContactRows = normalizedEmails.length
        ? await tx.select({ id: schema.contacts.id, email: schema.contacts.email, normalizedEmail: schema.contacts.normalizedEmail, firstName: schema.contacts.firstName, lastName: schema.contacts.lastName, company: schema.contacts.company, title: schema.contacts.title, source: schema.contacts.source, status: schema.contacts.status, updatedAt: schema.contacts.updatedAt }).from(schema.contacts).where(and(eq(schema.contacts.workspaceId, request.workspaceId), inArray(schema.contacts.normalizedEmail, normalizedEmails))).for("update")
        : [];
      const suppressionRows = normalizedEmails.length
        ? await tx.select({ normalizedEmail: schema.suppressions.normalizedEmail, emailHash: schema.suppressions.emailHash }).from(schema.suppressions).where(and(eq(schema.suppressions.workspaceId, request.workspaceId), or(inArray(schema.suppressions.normalizedEmail, normalizedEmails), inArray(schema.suppressions.emailHash, emailHashes))))
        : [];
      const currentContacts = new Map(currentContactRows.map((contact) => [contact.normalizedEmail, contact]));
      const emailsByHash = new Map(normalizedEmails.map((email, index) => [emailHashes[index], email]));
      const suppressedNow = new Set(suppressionRows.flatMap((item) => item.normalizedEmail ? [item.normalizedEmail] : emailsByHash.get(item.emailHash) ? [emailsByHash.get(item.emailHash)!] : []));
      let createdRows = 0;
      let updatedRows = 0;
      let unchangedRows = 0;
      let duplicateRows = 0;
      let suppressedRows = 0;
      let rejectedRows = 0;

      for (const row of rows) {
        const normalizedEmail = row.normalizedEmail;
        const action = importAction(row.action);
        if (action === "duplicate") { duplicateRows += 1; continue; }
        if (action === "rejected") { rejectedRows += 1; continue; }
        if (action === "not_found") continue;
        if (action === "suppressed") { suppressedRows += 1; continue; }
        if (!normalizedEmail) continue;
        const current = currentContacts.get(normalizedEmail);
        if (suppressedNow.has(normalizedEmail) || current?.status === "suppressed") {
          suppressedRows += 1;
          await tx.update(schema.importRows).set({ status: "suppressed", action: "suppressed", errorCode: "Suppressed at commit" }).where(and(eq(schema.importRows.id, row.id), eq(schema.importRows.workspaceId, request.workspaceId)));
          continue;
        }
        if (action === "unchanged") {
          if (!current) {
            await tx.update(schema.importRows).set({ status: "skipped", errorCode: "Conflict: lead no longer exists" }).where(and(eq(schema.importRows.id, row.id), eq(schema.importRows.workspaceId, request.workspaceId)));
            continue;
          }
          unchangedRows += 1;
          await tx.update(schema.importRows).set({ status: "unchanged", errorCode: null }).where(and(eq(schema.importRows.id, row.id), eq(schema.importRows.workspaceId, request.workspaceId)));
          continue;
        }

        if (action === "create") {
          if (current) {
            await tx.update(schema.importRows).set({ status: "skipped", errorCode: "Conflict: lead now exists" }).where(and(eq(schema.importRows.id, row.id), eq(schema.importRows.workspaceId, request.workspaceId)));
            continue;
          }
          const data = objectValue(row.normalizedData);
          const rowCustom = rowCustomValues(row);
          const hasCustom = Object.keys(rowCustom).length > 0;
          const [created] = await tx.insert(schema.contacts).values({ id: randomUUID(), workspaceId: request.workspaceId, email: typeof data.email === "string" ? data.email : normalizedEmail, normalizedEmail, ...(hasCustom && !variablesSequenceId ? { customFields: rowCustom } : {}), firstName: typeof data.firstName === "string" ? data.firstName : "", lastName: typeof data.lastName === "string" ? data.lastName : "", company: typeof data.company === "string" ? data.company : "", title: typeof data.title === "string" ? data.title : "", source: typeof data.source === "string" && data.source ? data.source : "CSV import", status: "active", createdByUserId: request.userId }).onConflictDoNothing().returning({ id: schema.contacts.id, email: schema.contacts.email, firstName: schema.contacts.firstName, lastName: schema.contacts.lastName, company: schema.contacts.company, title: schema.contacts.title, source: schema.contacts.source, updatedAt: schema.contacts.updatedAt });
          if (!created) {
            await tx.update(schema.importRows).set({ status: "skipped", errorCode: "Conflict: lead now exists" }).where(and(eq(schema.importRows.id, row.id), eq(schema.importRows.workspaceId, request.workspaceId)));
            continue;
          }
          createdRows += 1;
          if (hasCustom) (variablesSequenceId ? variableRows.push({ contactId: created.id, variables: rowCustom }) : fieldChangedIds.push(created.id));
          currentContacts.set(normalizedEmail, { ...created, normalizedEmail, status: "active" });
          const added = await tx.insert(schema.contactListMembers).values({ workspaceId: request.workspaceId, contactListId: listId, contactId: created.id, addedByUserId: request.userId }).onConflictDoNothing().returning({ contactId: schema.contactListMembers.contactId });
          addedLeadIds.push(...added.map((member) => member.contactId));
          await tx.update(schema.importRows).set({ status: "created", errorCode: null }).where(and(eq(schema.importRows.id, row.id), eq(schema.importRows.workspaceId, request.workspaceId)));
          continue;
        }

        const snapshot = objectValue(row.previewSnapshot);
        if (!current || snapshot.contactId !== current.id || snapshot.updatedAt !== current.updatedAt.toISOString()) {
          await tx.update(schema.importRows).set({ status: "skipped", errorCode: "Conflict: lead changed after preview" }).where(and(eq(schema.importRows.id, row.id), eq(schema.importRows.workspaceId, request.workspaceId)));
          continue;
        }
        const changes = objectValue(row.changedFields);
        if (importProfileFields.some((field) => Object.hasOwn(changes, field) && objectValue(changes[field]).before !== (current[field] ?? ""))) {
          await tx.update(schema.importRows).set({ status: "skipped", errorCode: "Conflict: lead changed after preview" }).where(and(eq(schema.importRows.id, row.id), eq(schema.importRows.workspaceId, request.workspaceId)));
          continue;
        }
        const updates: { firstName?: string; lastName?: string; company?: string; title?: string; source?: string; customFields?: ReturnType<typeof jsonbMergeSql>; updatedAt: Date } = { updatedAt: new Date() };
        for (const field of importProfileFields) {
          const change = objectValue(changes[field]);
          if (typeof change.after === "string" && change.after) updates[field] = change.after;
        }
        // Empty cells leave stored values unchanged; non-empty ones are merged in.
        const rowCustom = rowCustomValues(row);
        const hasCustom = Object.keys(rowCustom).length > 0;
        if (hasCustom && !variablesSequenceId) updates.customFields = jsonbMergeSql(schema.contacts.customFields, rowCustom, []);
        const [updated] = await tx.update(schema.contacts).set(updates).where(and(eq(schema.contacts.id, current.id), eq(schema.contacts.workspaceId, request.workspaceId))).returning({ id: schema.contacts.id });
        if (!updated) {
          await tx.update(schema.importRows).set({ status: "skipped", errorCode: "Conflict: lead changed after preview" }).where(and(eq(schema.importRows.id, row.id), eq(schema.importRows.workspaceId, request.workspaceId)));
          continue;
        }
        updatedRows += 1;
        if (hasCustom) (variablesSequenceId ? variableRows.push({ contactId: current.id, variables: rowCustom }) : fieldChangedIds.push(current.id));
        // Add-only imports leave existing leads out of the list: they only receive their custom values.
        if (storedImport.mode !== "add_only") {
          const added = await tx.insert(schema.contactListMembers).values({ workspaceId: request.workspaceId, contactListId: listId, contactId: current.id, addedByUserId: request.userId }).onConflictDoNothing().returning({ contactId: schema.contactListMembers.contactId });
          addedLeadIds.push(...added.map((member) => member.contactId));
        }
        await tx.update(schema.importRows).set({ status: "updated", errorCode: null }).where(and(eq(schema.importRows.id, row.id), eq(schema.importRows.workspaceId, request.workspaceId)));
      }

      // Values land before the import is marked committed and before auto-enrollment runs
      // (outside this transaction), so a lead added to a live campaign already has its lines.
      customWrites.variablesSequenceId = variablesSequenceId;
      customWrites.customRows = variableRows.length + fieldChangedIds.length;
      customWrites.fieldChangedContactIds = fieldChangedIds;
      if (variablesSequenceId && variableRows.length) {
        const written = await upsertLeadVariables(tx, request.workspaceId, variablesSequenceId, variableRows);
        customWrites.variablesUpdated = written.updated;
        customWrites.variableContactIds = written.contactIds;
        customWrites.variablesRerendered = await rerenderQueuedMessages(tx, request.workspaceId, variablesSequenceId, written.contactIds);
      }

      const skippedRows = storedImport.totalRows - createdRows - updatedRows;
      const [updatedImport] = await tx.update(schema.imports).set({ status: "committed", contactListId: listId, readyRows: createdRows + updatedRows, createdRows, updatedRows, unchangedRows, skippedRows, duplicateRows, suppressedRows, rejectedRows, updatedAt: new Date() }).where(and(eq(schema.imports.id, storedImport.id), eq(schema.imports.workspaceId, request.workspaceId))).returning();
      if (!updatedImport) throw new Error("Import disappeared while committing.");
      const updatedRowsResult = await tx.select().from(schema.importRows).where(and(eq(schema.importRows.importId, updatedImport.id), eq(schema.importRows.workspaceId, request.workspaceId))).orderBy(schema.importRows.rowNumber);
      return { storedImport: updatedImport, rows: updatedRowsResult, addedLeadIds, alreadyCommitted: false };
    });
    const campaignUpdates = new Map<string, CampaignUpdate>();
    if (committed.storedImport.contactListId && !committed.alreadyCommitted) {
      for (let offset = 0; offset < Math.max(1, committed.addedLeadIds.length); offset += 500) {
        const batch = await enrollNewListLeads(operationContext, { listId: committed.storedImport.contactListId, leadIds: committed.addedLeadIds.slice(offset, offset + 500) });
        for (const update of batch.campaignUpdates) {
          const previous = campaignUpdates.get(update.campaignId);
          campaignUpdates.set(update.campaignId, previous ? { ...previous, enrolled: previous.enrolled + update.enrolled, restarted: previous.restarted || update.restarted, blockedReason: previous.blockedReason ?? update.blockedReason } : update);
        }
      }
    }
    // Leads that were waiting on these values (already in a live campaign) enroll now, and
    // queued mail picks the new values up. Failures here never undo the committed import.
    let waitingEnrolled = 0;
    let fieldRefresh: { enrolled: number; rerendered: number } | null = null;
    if (!committed.alreadyCommitted) {
      try {
        // Includes leads just added to the import list: they may also sit in the campaign's own list.
        if (customWrites.variablesSequenceId && customWrites.variableContactIds.length) waitingEnrolled += (await enrollWaitingLeads(operationContext, customWrites.variablesSequenceId, customWrites.variableContactIds)).enrolled;
        if (customWrites.fieldChangedContactIds.length) {
          fieldRefresh = await refreshLeadsAfterFieldChange(operationContext, customWrites.fieldChangedContactIds);
          waitingEnrolled += fieldRefresh.enrolled;
        }
      } catch (error) {
        request.log.warn({ err: error, importId: request.params.id }, "Wake-up of leads waiting on imported custom fields failed.");
      }
    }
    return {
      import: storedImportResponse(committed.storedImport, committed.rows),
      campaignUpdates: [...campaignUpdates.values()],
      ...(!committed.alreadyCommitted && customWrites.customRows ? {
        customFields: {
          storedAs: customWrites.variablesSequenceId ? "campaign" as const : "lead" as const,
          ...(customWrites.variablesSequenceId ? { sequenceId: customWrites.variablesSequenceId } : {}),
          leads: customWrites.customRows,
          rerendered: customWrites.variablesRerendered + (fieldRefresh?.rerendered ?? 0),
          enrolledWaiting: waitingEnrolled,
        },
      } : {}),
    };
  });

  app.get("/v1/sequences", async (request) => db
    ? runWorkspaceOperation("sequences.list", request, {})
    : ({ workspaceId: request.workspaceId, sequences: await readSequences(request.workspaceId) }));
  app.get<{ Params: { id: string } }>("/v1/sequences/:id", async (request) => runWorkspaceOperation("sequences.get", request, { id: request.params.id }));

  // Per-lead custom {{variables}} of a campaign: thin adapters over the campaigns.* operations.
  app.get<{ Params: { id: string }; Querystring: { filter?: string; variable?: string; page?: string; pageSize?: string; search?: string } }>("/v1/sequences/:id/lead-variables", async (request) => runWorkspaceOperation("campaigns.getLeadVariables", request, {
    sequenceId: request.params.id,
    ...(request.query.filter !== undefined ? { filter: request.query.filter } : {}),
    ...(request.query.variable ? { variable: request.query.variable } : {}),
    ...(request.query.page !== undefined ? { page: Number(request.query.page) } : {}),
    ...(request.query.pageSize !== undefined ? { pageSize: Number(request.query.pageSize) } : {}),
    ...(request.query.search ? { search: request.query.search } : {}),
  }));
  app.put<{ Params: { id: string }; Body: { leads?: unknown } }>("/v1/sequences/:id/lead-variables", async (request, reply) => {
    const leads = request.body?.leads;
    if (!Array.isArray(leads)) return reply.status(400).send({ error: "leads must be an array of { contactId, variables }." });
    return runWorkspaceOperation("campaigns.setLeadVariables", request, {
      sequenceId: request.params.id,
      leads: leads.map((lead) => ({ contactId: objectValue(lead).contactId, variables: objectValue(lead).variables })),
    });
  });
  app.get("/v1/lead-variables/names", async (request) => runWorkspaceOperation("campaigns.listLeadVariableNames", request, {}));

  app.post<{ Body: unknown }>("/v1/sequences", async (request, reply) => {
    const payload = sequencePayload(request.body);
    if (!payload) {
      reply.status(400);
      return { error: "Add a name and at least one step with a subject and body." };
    }
    if (db) { reply.status(201); return runWorkspaceOperation("sequences.create", request, payload); }
    const now = new Date().toISOString();
    const sequence: Sequence = { id: randomUUID(), ...payload, status: "draft", displayStatus: "draft", statusReason: null, completedAt: null, enrolledCount: 0, createdAt: now, updatedAt: now };
    sequences.unshift(sequence);
    reply.status(201);
    return { sequence };
  });

  app.patch<{ Params: { id: string }; Body: unknown }>("/v1/sequences/:id", async (request, reply) => {
    if (db) {
      const sequence = (await readSequences(request.workspaceId)).find((item) => item.id === request.params.id);
      if (!sequence) { reply.status(404); return { error: "Sequence not found." }; }
      if (sequence.status === "archived") { reply.status(409); return { error: "Archived sequences cannot be edited." }; }
      const payload = sequencePayload(request.body); if (!payload) { reply.status(400); return { error: "Add a name and at least one valid step." }; }
      await db.transaction(async (tx) => {
        const [row] = await tx.select().from(schema.sequences).where(and(eq(schema.sequences.id, sequence.id), eq(schema.sequences.workspaceId, request.workspaceId))).for("update");
        if (!row) throw new OpError("NOT_FOUND", "Sequence not found.");
        if (row.status === "archived") throw new OpError("CONFLICT", "Archived sequences cannot be edited.");
        if (row.status === "active") {
          await requireWorkspaceManager({ db, workspaceId: request.workspaceId, userId: request.userId, env: { edition, authSecret: env.AUTH_SECRET ?? "", apiBaseUrl: env.API_BASE_URL } });
          const [inProgress] = await tx.select({ id: schema.enrollments.id }).from(schema.enrollments).where(and(eq(schema.enrollments.workspaceId, request.workspaceId), eq(schema.enrollments.sequenceId, row.id), inArray(schema.enrollments.status, ["scheduled", "active", "paused"]))).limit(1);
          if (inProgress) throw new OpError("CONFLICT", "Pause the sequence before editing it.");
        }
        if (row.status === "paused" || row.status === "active") {
          const versions = await tx.select({ version: schema.sequenceVersions.version }).from(schema.sequenceVersions).where(eq(schema.sequenceVersions.sequenceId, row.id)).orderBy(desc(schema.sequenceVersions.version)).limit(1);
          const versionId = randomUUID();
          await tx.insert(schema.sequenceVersions).values({ id: versionId, workspaceId: request.workspaceId, sequenceId: row.id, version: (versions[0]?.version ?? 0) + 1, status: row.status === "active" ? "active" : "draft", launchedAt: row.status === "active" ? new Date() : null, snapshot: { description: payload.description, enrolledCount: sequence.enrolledCount } });
          await tx.insert(schema.sequenceSteps).values(payload.steps.map((step, index) => ({ id: randomUUID(), workspaceId: request.workspaceId, sequenceVersionId: versionId, stepOrder: index + 1, delayDays: step.delayDays, subject: step.subject, bodyText: step.body })));
          await tx.update(schema.sequences).set({ name: payload.name, currentVersionId: versionId, updatedAt: new Date() }).where(eq(schema.sequences.id, row.id));
          return;
        }
        const version = row.currentVersionId ? (await tx.select().from(schema.sequenceVersions).where(and(eq(schema.sequenceVersions.id, row.currentVersionId), eq(schema.sequenceVersions.workspaceId, request.workspaceId))))[0] : undefined;
        if (version) {
          await tx.delete(schema.sequenceSteps).where(eq(schema.sequenceSteps.sequenceVersionId, version.id));
          await tx.update(schema.sequenceVersions).set({ snapshot: { description: payload.description, enrolledCount: sequence.enrolledCount }, updatedAt: new Date() }).where(eq(schema.sequenceVersions.id, version.id));
          await tx.insert(schema.sequenceSteps).values(payload.steps.map((step, index) => ({ id: step.id, workspaceId: request.workspaceId, sequenceVersionId: version.id, stepOrder: index + 1, delayDays: step.delayDays, subject: step.subject, bodyText: step.body })));
        }
        await tx.update(schema.sequences).set({ name: payload.name, updatedAt: new Date() }).where(eq(schema.sequences.id, row.id));
      });
      return { sequence: (await readSequences(request.workspaceId)).find((s) => s.id === sequence.id) };
    }
    const sequence = sequences.find((item) => item.id === request.params.id);
    if (!sequence) { reply.status(404); return { error: "Sequence not found." }; }
    if (sequence.status === "published" && sequence.enrolledCount > 0) { reply.status(409); return { error: "Pause the sequence before editing it." }; }
    if (sequence.status === "archived") { reply.status(409); return { error: "Archived sequences cannot be edited." }; }
    const payload = sequencePayload(request.body);
    if (!payload) { reply.status(400); return { error: "Add a name and at least one valid step." }; }
    Object.assign(sequence, payload, { updatedAt: new Date().toISOString() });
    return { sequence: (await readSequences(request.workspaceId)).find((item) => item.id === sequence.id) };
  });

  app.post<{ Params: { id: string } }>("/v1/sequences/:id/publish", async (request, reply) => {
    if (!db) { reply.status(503); return { error: "Sequence storage is unavailable." }; }
    return runWorkspaceOperation("sequences.publish", request, { id: request.params.id });
  });
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>("/v1/sequences/:id/launch", async (request) => runWorkspaceOperation("sequences.launch", request, { id: request.params.id, ...(request.body ?? {}) }));
  app.put<{ Params: { id: string }; Body: { mailboxIds?: unknown } }>("/v1/sequences/:id/mailboxes", async (request) => runWorkspaceOperation("sequences.setMailboxes", request, { id: request.params.id, mailboxIds: request.body?.mailboxIds }));

  app.post<{ Params: { id: string } }>("/v1/sequences/:id/pause", async (request, reply) => {
    if (!db) { reply.status(503); return { error: "Sequence storage is unavailable." }; }
    return runWorkspaceOperation("sequences.pause", request, { id: request.params.id });
  });

  app.post<{ Params: { id: string } }>("/v1/sequences/:id/resume", async (request, reply) => {
    if (!db) { reply.status(503); return { error: "Sequence storage is unavailable." }; }
    return runWorkspaceOperation("sequences.resume", request, { id: request.params.id });
  });

  app.post<{ Params: { id: string } }>("/v1/sequences/:id/archive", async (request, reply) => {
    if (!db) { reply.status(503); return { error: "Sequence storage is unavailable." }; }
    return runWorkspaceOperation("sequences.archive", request, { id: request.params.id });
  });

  app.delete<{ Params: { id: string } }>("/v1/sequences/:id", async (request, reply) => {
    if (!db) return reply.status(503).send({ error: "Sequence storage is unavailable." });
    await runWorkspaceOperation("sequences.delete", request, { id: request.params.id });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/v1/sequences/:id/duplicate", async (request, reply) => {
    if (!db) { reply.status(503); return { error: "Sequence storage is unavailable." }; }
    reply.status(201);
    return runWorkspaceOperation("sequences.duplicate", request, { id: request.params.id });
  });

  app.get<{ Params: { id: string }; Querystring: { version?: string } }>("/v1/sequences/:id/analytics", async (request, reply) => {
    if (!db) { reply.status(503); return { error: "Sequence analytics are unavailable." }; }
    return runWorkspaceOperation("sequences.analytics", request, { id: request.params.id, version: request.query.version });
  });

  app.get<{ Params: { id: string }; Querystring: { page?: string; pageSize?: string } }>("/v1/sequences/:id/enrollments", async (request) => runWorkspaceOperation("sequences.enrollments", request, { id: request.params.id, page: request.query.page ? Number(request.query.page) : undefined, pageSize: request.query.pageSize ? Number(request.query.pageSize) : undefined }));
  app.get<{ Querystring: { sequenceId?: string; status?: string; page?: string; pageSize?: string } }>("/v1/enrollments", async (request) => runWorkspaceOperation("enrollments.list", request, { sequenceId: request.query.sequenceId, status: request.query.status, page: request.query.page ? Number(request.query.page) : undefined, pageSize: request.query.pageSize ? Number(request.query.pageSize) : undefined }));
  app.get<{ Querystring: { page?: string; pageSize?: string; sequenceId?: string; emailAccountId?: string; unread?: string } }>("/v1/replies", async (request) => runWorkspaceOperation("replies.list", request, {
    page: request.query.page ? Number(request.query.page) : undefined,
    pageSize: request.query.pageSize ? Number(request.query.pageSize) : undefined,
    sequenceId: request.query.sequenceId,
    emailAccountId: request.query.emailAccountId,
    unread: request.query.unread === undefined ? undefined : request.query.unread === "true" ? true : request.query.unread === "false" ? false : request.query.unread,
  }));
  app.get<{ Params: { id: string } }>("/v1/replies/:id", async (request) => runWorkspaceOperation("replies.get", request, { id: request.params.id }));
  app.post<{ Params: { id: string } }>("/v1/replies/:id/read", async (request) => runWorkspaceOperation("replies.markRead", request, { id: request.params.id }));
  app.post<{ Params: { id: string }; Body: { body?: unknown; idempotencyKey?: unknown } }>("/v1/replies/:id/send", async (request) => runWorkspaceOperation("replies.send", request, { id: request.params.id, body: request.body?.body, idempotencyKey: request.body?.idempotencyKey }));

  app.post<{ Params: { id: string }; Body: { contactId?: unknown } }>("/v1/sequences/:id/preview", async (request, reply) => {
    if (!db) { reply.status(503); return { error: "Sequence preview is unavailable." }; }
    const contactId = typeof request.body?.contactId === "string" ? request.body.contactId : undefined;
    return runWorkspaceOperation("sequences.preview", request, { id: request.params.id, contactId });
  });

  app.post<{ Params: { id: string }; Body: { stepOrder?: unknown; to?: unknown; contactId?: unknown } }>("/v1/sequences/:id/test-send", async (request, reply) => {
    if (!db) { reply.status(503); return { error: "Test sending requires a configured database and Azure email provider." }; }
    if (!transactionalEmail.enabled) { reply.status(503); return { error: "Azure email is not configured." }; }
    const stepOrder = typeof request.body?.stepOrder === "number" && Number.isInteger(request.body.stepOrder) ? request.body.stepOrder : 0;
    const to = typeof request.body?.to === "string" ? request.body.to.trim() : "";
    const normalizedTo = normalizeEmail(to);
    if (stepOrder < 1 || !isValidEmail(normalizedTo)) { reply.status(400); return { error: "Provide a valid stepOrder and recipient email." }; }
    await requireVerifiedWorkspaceOwner({
      db,
      workspaceId: request.workspaceId,
      userId: request.userId,
      env: { edition, authSecret: env.AUTH_SECRET ?? "", apiBaseUrl: env.API_BASE_URL },
    });
    const [allowedRecipient] = await db.select({ id: schema.users.id }).from(schema.users).leftJoin(
      schema.memberships,
      and(
        eq(schema.memberships.userId, schema.users.id),
        eq(schema.memberships.workspaceId, request.workspaceId),
        eq(schema.memberships.status, "active"),
      ),
    ).where(and(
      eq(schema.users.normalizedEmail, normalizedTo),
      or(sql`${schema.users.id}::text = ${request.userId}`, sql`${schema.memberships.id} IS NOT NULL`),
    )).limit(1);
    if (!allowedRecipient) {
      return reply.code(403).send({ error: "Test emails can only be sent to members of this workspace." });
    }
    const [stored] = await db.select().from(schema.sequences).where(and(eq(schema.sequences.id, request.params.id), eq(schema.sequences.workspaceId, request.workspaceId)));
    if (!stored?.currentVersionId) { reply.status(404); return { error: "Sequence not found." }; }
    if (stored.status === "archived") { reply.status(409); return { error: "Archived sequences cannot send test emails." }; }
    const [version] = await db.select().from(schema.sequenceVersions).where(and(eq(schema.sequenceVersions.id, stored.currentVersionId), eq(schema.sequenceVersions.workspaceId, request.workspaceId)));
    if (!version) { reply.status(404); return { error: "Sequence version not found." }; }
    const [step] = await db.select().from(schema.sequenceSteps).where(and(eq(schema.sequenceSteps.sequenceVersionId, stored.currentVersionId), eq(schema.sequenceSteps.stepOrder, stepOrder)));
    if (!step) { reply.status(404); return { error: "Sequence step not found." }; }
    const [workspace] = await db.select({
      status: schema.workspaces.status,
      killSwitchEnabled: schema.workspaces.killSwitchEnabled,
      postalAddress: schema.workspaces.postalAddress,
      legacyFreeUntil: schema.workspaces.legacyFreeUntil,
    }).from(schema.workspaces).where(eq(schema.workspaces.id, request.workspaceId));
    if (workspace && workspace.status !== "active") {
      reply.status(409);
      return { error: "Test sending is blocked because sending is paused for this workspace.", code: "workspace_inactive" };
    }
    if (workspace?.killSwitchEnabled) {
      reply.status(409);
      return { error: "Test sending is blocked because the workspace kill switch is enabled.", code: "kill_switch" };
    }
    const postalAddress = workspace?.postalAddress?.trim();
    const emailHash = createHash("sha256").update(normalizedTo).digest("hex");
    const [suppression] = await db.select({ id: schema.suppressions.id }).from(schema.suppressions).where(and(
      eq(schema.suppressions.workspaceId, request.workspaceId),
      or(eq(schema.suppressions.normalizedEmail, normalizedTo), eq(schema.suppressions.emailHash, emailHash)),
    )).limit(1);
    if (suppression) { reply.status(409); return { error: "This recipient is suppressed and cannot receive test emails." }; }
    let lead: LeadVariableSource & { firstName: string; email: string } = { firstName: "Ada", lastName: "Lovelace", company: "Example Co", title: "Founder", email: to };
    let unsubscribeContactId: string = randomUUID();
    if (typeof request.body?.contactId === "string") { const [contact] = await db.select().from(schema.contacts).where(and(eq(schema.contacts.id, request.body.contactId), eq(schema.contacts.workspaceId, request.workspaceId))); if (!contact) { reply.status(404); return { error: "Contact not found." }; } const campaignVariables = (await loadLeadVariables(db, request.workspaceId, request.params.id, [contact.id])).get(contact.id) ?? {}; lead = { firstName: contact.firstName ?? "", lastName: contact.lastName ?? "", company: contact.company ?? "", title: contact.title ?? "", email: contact.email, customFields: contact.customFields as Record<string, unknown> | null, campaignVariables }; unsubscribeContactId = contact.id; }
    if (!env.AUTH_SECRET) { reply.status(503); return { error: "Unsubscribe protection is unavailable. Test sending remains disabled." }; }
    const periodStart = new Date();
    periodStart.setUTCHours(0, 0, 0, 0);
    const periodEnd = new Date(periodStart.getTime() + 86_400_000);
    const quota = await db.execute<{ value: number }>(sql`
      INSERT INTO usage_counters (id, workspace_id, counter_key, period_start, period_end, value, updated_at)
      VALUES (${randomUUID()}, ${request.workspaceId}, ${"test_sends"}, ${periodStart}, ${periodEnd}, 1, now())
      ON CONFLICT (workspace_id, counter_key, period_start)
      DO UPDATE SET value = usage_counters.value + 1, updated_at = now()
      WHERE usage_counters.value < 20
      RETURNING value
    `);
    if (!quota.rows.length) throw new OpError("test_send_quota_exceeded", "Daily test-send limit reached. Try again tomorrow.", { limit: 20, resetsAt: periodEnd.toISOString() });
    const token = createUnsubscribeToken({ workspaceId: request.workspaceId, contactId: unsubscribeContactId, normalizedEmail: normalizedTo }, env.AUTH_SECRET);
    const unsubscribeUrl = env.API_BASE_URL.replace(/\/$/, "") + "/v1/unsubscribe?token=" + encodeURIComponent(token);
    // Test sends preview the real footer: only legacy Free workspaces see "Sent via InboxJoy",
    // decided by the same sendingPlan() the worker uses at claim time.
    const [subscription] = await db.select({ status: schema.subscriptions.status, trialEnd: schema.subscriptions.trialEnd, updatedAt: schema.subscriptions.updatedAt }).from(schema.subscriptions).where(eq(schema.subscriptions.workspaceId, request.workspaceId)).limit(1);
    const footerOptions = { sentVia: sendingPlan({
      edition,
      subscription: subscription ? { status: subscription.status, trialEnd: subscription.trialEnd, onHoldGraceEndsAt: new Date(subscription.updatedAt.getTime() + 7 * 86_400_000) } : null,
      legacyFreeUntil: workspace?.legacyFreeUntil ?? null,
    }, new Date()) === "legacy_free" };
    const body = appendUnsubscribeFooter("[TEST SEND — no enrollment created]\n\n" + renderPersonalized(step.bodyText, lead, { enforceCustom: version.customVariablesEnforced }), unsubscribeUrl, postalAddress, footerOptions);
    const subject = "[TEST] " + renderPersonalized(step.subject, lead, { enforceCustom: version.customVariablesEnforced });
    await transactionalEmail.sendSequenceTest({ recipient: { email: to, name: lead.firstName }, subject, plainText: body, html: renderEmailHtml(body, unsubscribeUrl, undefined, postalAddress, footerOptions) });
    const sentAt = new Date().toISOString();
    await db.update(schema.sequenceVersions).set({
      snapshot: {
        ...(version.snapshot as Record<string, unknown>),
        lastSuccessfulTestSendAt: sentAt,
        lastSuccessfulTestSender: transactionalEmail.senderAddress ?? "Azure Communication Services",
        lastSuccessfulTestProvider: transactionalEmail.provider ?? "azure-communication-email",
      },
      updatedAt: new Date(sentAt),
    }).where(and(eq(schema.sequenceVersions.id, version.id), eq(schema.sequenceVersions.workspaceId, request.workspaceId)));
    return { sent: true, test: true, sender: transactionalEmail.senderAddress ?? "Azure Communication Services", sentAt, provider: transactionalEmail.provider ?? "azure-communication-email" };
  });

  app.post<{ Params: { id: string }; Body: { leadIds?: unknown; listIds?: unknown; listId?: unknown; listName?: unknown; inboxId?: unknown; inboxIds?: unknown } }>("/v1/sequences/:id/enroll", async (request, reply) => {
    if (!db) { reply.status(503); return { error: "Sequence enrollment is unavailable." }; }
    const leadIds = Array.isArray(request.body?.leadIds) ? request.body.leadIds.filter((value): value is string => typeof value === "string") : undefined;
    const listIds = Array.isArray(request.body?.listIds) ? request.body.listIds.filter((value): value is string => typeof value === "string") : undefined;
    const listId = typeof request.body?.listId === "string" ? request.body.listId : undefined;
    const listName = typeof request.body?.listName === "string" ? request.body.listName : undefined;
    const inboxId = typeof request.body?.inboxId === "string" ? request.body.inboxId : undefined;
    const inboxIds = Array.isArray(request.body?.inboxIds) ? request.body.inboxIds.filter((value): value is string => typeof value === "string") : undefined;
    return runWorkspaceOperation("sequences.enroll", request, { id: request.params.id, leadIds, listIds, listId, listName, inboxId, inboxIds });
  });

  app.get<{ Params: { id: string } }>("/v1/sequences/:id/queued", async (request, reply) => {
    if (!db) { reply.status(503); return { error: "Sequence enrollment is unavailable." }; }
    return runWorkspaceOperation("sequences.queued", request, { id: request.params.id });
  });

  app.post<{ Params: { id: string }; Body: { leadIds?: unknown } }>("/v1/sequences/:id/dequeue", async (request, reply) => {
    if (!db) { reply.status(503); return { error: "Sequence enrollment is unavailable." }; }
    const leadIds = Array.isArray(request.body?.leadIds) ? request.body.leadIds.filter((value): value is string => typeof value === "string") : undefined;
    return runWorkspaceOperation("sequences.dequeue", request, { id: request.params.id, leadIds });
  });

  return app;
}
