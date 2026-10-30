import { schema } from "@inboxjoy/db";
import { splitQuotedReply } from "@inboxjoy/email";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import { campaignDisplayStatuses, deriveSequenceDisplay } from "./campaign-status.js";
import { canSend, UNHEALTHY_MAILBOX_STATES, type DenyReason, type MailboxHealthState } from "./delivery/can-send.js";
import { providerCircuitKeySql } from "./delivery/circuit.js";
import { rfcMessageId } from "./delivery/message-id.js";
import { assertComposioProvider, type MailboxProvider } from "./mailbox-provider.js";
import type { Operation, OperationContext } from "./index.js";
import { pagedEnrollments } from "./sending-analytics.js";
import { readSequenceMailboxIds, sequenceMailboxIdsSchema } from "./sequence-mailboxes.js";
import { enrollNewListLeads } from "./enroll-new-list-leads.js";
import { applyLeadVariables, enrollWaitingLeads, refreshLeadsAfterFieldChange, jsonbMergeSql, LeadVariableError, loadLeadVariables, rerenderQueuedMessages, resolveVariableSequence, splitVariableUpdates, upsertLeadVariables } from "./lead-variables.js";
import { listLeadVariableNames, readLeadVariables } from "./lead-variables-view.js";
import { MAX_VARIABLE_VALUE_LENGTH } from "./template-variables.js";
import { assertLaunchAudienceComplete } from "./launch-gate.js";

type RunNamed = (name: string, ctx: OperationContext, input: unknown) => Promise<any>;
type OpErrorConstructor = new (code: "BAD_INPUT" | "NOT_FOUND" | "CONFLICT" | "UNAVAILABLE" | "FORBIDDEN", message: string, details?: unknown) => Error;
export type ReplySender = {
  enabled: boolean;
  sendEmail(input: {
    connectedAccountId: string;
    userId: string;
    provider: MailboxProvider;
    to: string;
    subject: string;
    body: string;
    threadId?: string;
    from?: string;
    messageId?: string;
    inReplyTo?: string;
    references?: string;
  }): Promise<{ providerMessageId?: string; providerThreadId?: string; logId?: string }>;
};

type ReplyListItem = {
  id: string;
  contactId: string;
  email: string;
  firstName: string;
  lastName: string;
  company: string;
  sequenceId: string | null;
  sequenceName: string | null;
  stepId: string | null;
  stepOrder: number | null;
  subject: string | null;
  snippet: string | null;
  receivedAt: string;
  readAt: string | null;
  isAutoReply: boolean;
  intent: string;
  providerThreadId: string | null;
  emailAccountId: string | null;
  mailboxEmail: string | null;
};

type ReplyThreadEntry = {
  direction: "inbound" | "outbound";
  subject: string | null;
  body: string;
  // The quoted email history trimmed off `body` for an inbound entry; always null for
  // outbound entries since those bodies are our own sends and were never quoted.
  quotedText: string | null;
  at: string;
  stepOrder: number | null;
};

type ManualReplyGateRow = {
  gate_now: Date | string;
  workspace_status: string;
  kill_switch_enabled: boolean;
  workspace_daily_cap: number;
  workspace_today: number;
  owner_email_verified: boolean;
  subscription_status: string | null;
  subscription_trial_end: Date | string | null;
  subscription_grace_end: Date | string | null;
  mailbox_status: string;
  daily_limit: number;
  hourly_limit: number;
  ramp_started_on: string | null;
  ramp_paused_days: number;
  mailbox_today: number;
  mailbox_hour: number;
  in_sending_window: boolean;
  next_allowed_at: Date | string | null;
  health_state: string | null;
  effective_daily_limit: number | null;
  throttled_until: Date | string | null;
  circuit_state: string | null;
  next_probe_at: Date | string | null;
  suppressed: boolean;
};

function gateDate(value: Date | string | null): Date | null {
  return value ? new Date(value) : null;
}

const manualReplyDenyMessages: Record<DenyReason, string> = {
  payment_required: "Campaign sending needs the $79 lifetime license. Get it from Settings → Billing.",
  free_monthly_cap: "The free plan's monthly send limit is reached. Get the $79 lifetime license to keep sending.",
  email_unverified: "Verify your email address to send.",
  workspace_inactive: "This workspace is inactive and cannot send email.",
  kill_switch: "Sending is paused for this workspace.",
  sequence_inactive: "This campaign is not active.",
  enrollment_inactive: "This enrollment is not active.",
  mailbox_inactive: "This mailbox is inactive and cannot send email.",
  suppressed: "This contact has unsubscribed and cannot be emailed.",
  mailbox_daily_cap: "This mailbox has reached today's sending limit.",
  mailbox_hourly_cap: "This mailbox has reached its hourly sending limit.",
  mailbox_min_gap: "This mailbox needs a short pause before sending again.",
  workspace_daily_cap: "This workspace has reached today's sending limit.",
  warmup_limit: "This mailbox has reached today's warm-up limit.",
  outside_window: "This mailbox is outside its sending hours.",
  mailbox_throttled: "This mailbox is temporarily paused by its health checks.",
  mailbox_unhealthy: "This mailbox needs attention before it can send.",
  provider_circuit_open: "The email provider is temporarily unavailable.",
  already_replied: "This contact has already replied.",
};

function manualReplyDenyMessage(reason: DenyReason): string {
  return manualReplyDenyMessages[reason] ?? "This reply cannot be sent right now.";
}

function providerErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const value = error as { status?: unknown; statusCode?: unknown };
  if (typeof value.status === "number") return value.status;
  return typeof value.statusCode === "number" ? value.statusCode : null;
}

function definiteProviderRejection(error: unknown): number | null {
  if (error instanceof Error && error.name === "SmtpSendError") {
    const smtpError = error as Error & { stage?: string; code?: string; responseCode?: number };
    if (smtpError.responseCode && smtpError.responseCode >= 400 && smtpError.responseCode < 500) return smtpError.responseCode;
    if ((smtpError.stage === "auth" && (smtpError.responseCode ?? 0) >= 500) || [530, 534, 535, 538].includes(smtpError.responseCode ?? 0)) return 401;
    if (smtpError.responseCode && smtpError.responseCode >= 400 && smtpError.responseCode < 600) return smtpError.responseCode;
    if (smtpError.stage === "data") return null;
    if (smtpError.stage === "auth" && smtpError.code === "EAUTH") return 401;
    if (smtpError.stage === "connect" || smtpError.stage === "mail" || smtpError.stage === "auth") return 503;
    return null;
  }
  const status = providerErrorStatus(error);
  return status !== null && status >= 400 && status < 500 && status !== 408 ? status : null;
}

function replyRfcMessageId(value: unknown): string | undefined {
  return typeof value === "string" && /^<[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9.-]+>$/.test(value) ? value : undefined;
}

function providerRejectionMessage(status: number): string {
  if (status === 401 || status === 403) return "Reconnect this mailbox and try again.";
  if (status === 429) return "The email provider is limiting sends. Wait a moment and try again.";
  if (status === 400 || status === 422) return "The email provider rejected this reply. Check the message and try again.";
  return "The email provider rejected this reply. Check the mailbox and try again.";
}

const anyOutput = z.any();
const id = z.string().uuid();
const listIds = z.preprocess((value) => Array.isArray(value) ? [...new Set(value)] : value, z.array(id).max(20));
const email = z.string().email();
const enrollmentStatus = z.enum(["scheduled", "active", "paused", "replied", "bounced", "unsubscribed", "completed", "cancelled"]);
// { variableName: "text" | null }. null (or blank text) deletes the key.
const variableValues = z.record(z.string(), z.string().max(MAX_VARIABLE_VALUE_LENGTH * 10).nullable()).refine((value) => Object.keys(value).length <= 50, "At most 50 variables per lead.");
const importedLeadSchema = z.object({
  email: z.string(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  company: z.string().optional(),
  title: z.string().optional(),
  source: z.string().optional(),
  // Lead-level custom text fields, available to every campaign as {{name}}.
  customFields: variableValues.optional(),
  // Campaign-scoped values for the campaignId/sequenceId given on the import call.
  variables: variableValues.optional(),
});

export type ImportedLead = z.infer<typeof importedLeadSchema> & { normalizedEmail: string };

export function prepareImportedLeads(rows: z.infer<typeof importedLeadSchema>[]): { leads: ImportedLead[]; skippedInvalid: number } {
  const leads: ImportedLead[] = [];
  const seen = new Set<string>();
  let skippedInvalid = 0;
  for (const row of rows) {
    const normalizedEmail = row.email.trim().toLowerCase();
    if (!email.safeParse(normalizedEmail).success) {
      skippedInvalid++;
      continue;
    }
    if (seen.has(normalizedEmail)) continue;
    seen.add(normalizedEmail);
    leads.push({ ...row, email: row.email.trim(), normalizedEmail });
  }
  return { leads, skippedInvalid };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function importedLeadUpdates(lead: ImportedLead): { firstName?: string; lastName?: string; company?: string; title?: string; source?: string } {
  const updates: { firstName?: string; lastName?: string; company?: string; title?: string; source?: string } = {};
  const firstName = nonEmpty(lead.firstName);
  const lastName = nonEmpty(lead.lastName);
  const company = nonEmpty(lead.company);
  const title = nonEmpty(lead.title);
  const source = nonEmpty(lead.source);
  if (firstName) updates.firstName = firstName;
  if (lastName) updates.lastName = lastName;
  if (company) updates.company = company;
  if (title) updates.title = title;
  if (source) updates.source = source;
  return updates;
}

function leadStatus(status: string): string {
  return status === "replied" ? "Replied" : status === "suppressed" ? "Suppressed" : status === "enrolled" ? "Enrolled" : status === "bounced" ? "Bounced" : status === "unsubscribed" ? "Unsubscribed" : "Ready";
}

// Splits an inbound reply body into the new text vs. the quoted email history, using
// the same markers the webhook classifier uses so intent detection and thread display
// never disagree about where a reply ends. Never returns an empty body: if the marker
// cuts off everything (a quote-only reply), the full original body is kept instead.
function inboundReplyBody(bodyText: string | null): { body: string; quotedText: string | null } {
  const safeBody = bodyText ?? "";
  const { text, quoted } = splitQuotedReply(safeBody);
  if (!text) return { body: safeBody, quotedText: null };
  return { body: text, quotedText: quoted };
}

async function replyListItems(ctx: OperationContext, replyRows: Array<typeof schema.replies.$inferSelect>): Promise<ReplyListItem[]> {
  const contactIds = [...new Set(replyRows.map((reply) => reply.contactId))];
  const sequenceIds = [...new Set(replyRows.flatMap((reply) => reply.sequenceId ? [reply.sequenceId] : []))];
  const emailAccountIds = [...new Set(replyRows.flatMap((reply) => reply.emailAccountId ? [reply.emailAccountId] : []))];
  const messageIds = [...new Set(replyRows.flatMap((reply) => reply.inReplyToMessageId ? [reply.inReplyToMessageId] : []))];
  const [contacts, sequences, emailAccounts, messages] = await Promise.all([
    contactIds.length ? ctx.db.select({ id: schema.contacts.id, email: schema.contacts.email, firstName: schema.contacts.firstName, lastName: schema.contacts.lastName, company: schema.contacts.company }).from(schema.contacts).where(and(eq(schema.contacts.workspaceId, ctx.workspaceId), inArray(schema.contacts.id, contactIds))) : [],
    sequenceIds.length ? ctx.db.select({ id: schema.sequences.id, name: schema.sequences.name }).from(schema.sequences).where(and(eq(schema.sequences.workspaceId, ctx.workspaceId), inArray(schema.sequences.id, sequenceIds))) : [],
    emailAccountIds.length ? ctx.db.select({ id: schema.emailAccounts.id, email: schema.emailAccounts.email }).from(schema.emailAccounts).where(and(eq(schema.emailAccounts.workspaceId, ctx.workspaceId), inArray(schema.emailAccounts.id, emailAccountIds))) : [],
    messageIds.length ? ctx.db.select({ id: schema.messages.id, sequenceStepId: schema.messages.sequenceStepId }).from(schema.messages).where(and(eq(schema.messages.workspaceId, ctx.workspaceId), inArray(schema.messages.id, messageIds))) : [],
  ]);
  const stepIds = [...new Set(messages.map((message) => message.sequenceStepId))];
  const steps = stepIds.length ? await ctx.db.select({ id: schema.sequenceSteps.id, stepOrder: schema.sequenceSteps.stepOrder }).from(schema.sequenceSteps).where(and(eq(schema.sequenceSteps.workspaceId, ctx.workspaceId), inArray(schema.sequenceSteps.id, stepIds))) : [];
  const contactsById = new Map(contacts.map((contact) => [contact.id, contact]));
  const sequencesById = new Map(sequences.map((sequence) => [sequence.id, sequence]));
  const emailAccountsById = new Map(emailAccounts.map((account) => [account.id, account]));
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const stepsById = new Map(steps.map((step) => [step.id, step]));

  return replyRows.map((reply) => {
    const contact = contactsById.get(reply.contactId);
    const message = reply.inReplyToMessageId ? messagesById.get(reply.inReplyToMessageId) : undefined;
    const step = message ? stepsById.get(message.sequenceStepId) : undefined;
    return {
      id: reply.id,
      contactId: reply.contactId,
      email: contact?.email ?? reply.fromEmail,
      firstName: contact?.firstName ?? "",
      lastName: contact?.lastName ?? "",
      company: contact?.company ?? "",
      sequenceId: reply.sequenceId,
      sequenceName: reply.sequenceId ? sequencesById.get(reply.sequenceId)?.name ?? null : null,
      stepId: step?.id ?? null,
      stepOrder: step?.stepOrder ?? null,
      subject: reply.subject,
      snippet: reply.snippet,
      receivedAt: reply.receivedAt.toISOString(),
      readAt: reply.readAt?.toISOString() ?? null,
      isAutoReply: reply.isAutoReply,
      intent: reply.intent,
      providerThreadId: reply.providerThreadId,
      emailAccountId: reply.emailAccountId,
      mailboxEmail: reply.emailAccountId ? emailAccountsById.get(reply.emailAccountId)?.email ?? null : null,
    };
  });
}

export function createMcpOperations(runNamed: RunNamed, OpError: OpErrorConstructor, requireWorkspaceManager: (ctx: OperationContext) => Promise<void>, requireVerifiedWorkspaceOwner: (ctx: OperationContext) => Promise<void>): Array<Operation<any, any>> {
  const mapVariableError = (error: unknown): never => {
    if (error instanceof LeadVariableError) throw new OpError(error.code, error.message);
    throw error;
  };
  return [
    {
      name: "leads.import",
      description: "Import leads from external providers into InboxJoy. Adding new members to a list used by an active or finished campaign automatically enrolls them and can start sends. Each lead may carry customFields (lead-level custom text, available to every campaign as {{name}}; null deletes a key) and variables (campaign-scoped text for the campaignId or sequenceId given on this call; they override customFields of the same name and are stored before auto-enrollment, so one call can import, write personalized lines and enroll). Variable names use letters, digits and underscores and cannot reuse firstName, lastName, company, title or email. Leads missing a custom variable used by the campaign's steps wait unenrolled until their values arrive.",
      access: "write",
      inputSchema: z.object({ leads: z.array(importedLeadSchema).min(1).max(1000), listName: z.string().trim().min(1).max(160).optional(), campaignId: id.optional(), sequenceId: id.optional() }).refine((value) => !(value.campaignId && value.sequenceId), "Provide only one of campaignId or sequenceId."),
      outputSchema: anyOutput,
      handler: async (ctx, input) => {
        const prepared = prepareImportedLeads(input.leads);
        const fieldPlans = new Map<string, { set: Record<string, string>; remove: string[] }>();
        const variableRows = new Map<string, Record<string, string | null>>();
        try {
          for (const lead of prepared.leads) {
            if (lead.customFields) fieldPlans.set(lead.normalizedEmail, splitVariableUpdates(lead.customFields));
            if (lead.variables && Object.keys(lead.variables).length) {
              splitVariableUpdates(lead.variables);
              variableRows.set(lead.normalizedEmail, lead.variables);
            }
          }
        } catch (error) {
          mapVariableError(error);
        }
        if (variableRows.size && !input.campaignId && !input.sequenceId) throw new OpError("BAD_INPUT", "Provide campaignId or sequenceId to store per-lead variables.");
        // Campaign variables decide what a live campaign sends, so they need the same role as campaigns.setLeadVariables.
        if (variableRows.size) await requireWorkspaceManager(ctx);
        const variableSequenceId = (input.campaignId || input.sequenceId) ? await resolveVariableSequence(ctx.db, ctx.workspaceId, input).catch(mapVariableError) : undefined;
        const result = await ctx.db.transaction(async (tx) => {
          const normalizedEmails = prepared.leads.map((lead) => lead.normalizedEmail);
          const existingRows = normalizedEmails.length ? await tx.select().from(schema.contacts).where(and(eq(schema.contacts.workspaceId, ctx.workspaceId), inArray(schema.contacts.normalizedEmail, normalizedEmails))) : [];
          const suppressionRows = normalizedEmails.length ? await tx.select({ normalizedEmail: schema.suppressions.normalizedEmail }).from(schema.suppressions).where(and(eq(schema.suppressions.workspaceId, ctx.workspaceId), inArray(schema.suppressions.normalizedEmail, normalizedEmails))) : [];
          const existingByEmail = new Map<string, { id: string }>(existingRows.map((contact) => [contact.normalizedEmail, { id: contact.id }]));
          const suppressedEmails = new Set(suppressionRows.flatMap((row) => row.normalizedEmail ? [row.normalizedEmail] : []));
          const contactIds: string[] = [];
          const contactIdByEmail = new Map<string, string>();
          const fieldChangedContactIds: string[] = [];
          let imported = 0;
          let updated = 0;
          let skippedSuppressed = 0;

          for (const lead of prepared.leads) {
            if (suppressedEmails.has(lead.normalizedEmail)) {
              skippedSuppressed++;
              continue;
            }
            const updates = importedLeadUpdates(lead);
            const fieldPlan = fieldPlans.get(lead.normalizedEmail);
            const fieldUpdate = fieldPlan && (Object.keys(fieldPlan.set).length || fieldPlan.remove.length) ? { customFields: jsonbMergeSql(schema.contacts.customFields, fieldPlan.set, fieldPlan.remove) } : {};
            const hasUpdates = Object.keys(updates).length > 0 || Object.keys(fieldUpdate).length > 0;
            const existing = existingByEmail.get(lead.normalizedEmail);
            if (existing) {
              if (hasUpdates) await tx.update(schema.contacts).set({ ...updates, ...fieldUpdate, updatedAt: new Date() }).where(and(eq(schema.contacts.id, existing.id), eq(schema.contacts.workspaceId, ctx.workspaceId)));
              if (Object.keys(fieldUpdate).length) fieldChangedContactIds.push(existing.id);
              contactIds.push(existing.id);
              contactIdByEmail.set(lead.normalizedEmail, existing.id);
              updated++;
              continue;
            }
            const contactId = randomUUID();
            const [created] = await tx.insert(schema.contacts).values({ id: contactId, workspaceId: ctx.workspaceId, email: lead.email, normalizedEmail: lead.normalizedEmail, ...updates, ...(fieldPlan && Object.keys(fieldPlan.set).length ? { customFields: fieldPlan.set } : {}), status: "active", createdByUserId: ctx.userId }).onConflictDoNothing().returning({ id: schema.contacts.id });
            if (created) {
              existingByEmail.set(lead.normalizedEmail, { id: created.id });
              if (fieldPlan && Object.keys(fieldPlan.set).length) fieldChangedContactIds.push(created.id);
              contactIds.push(created.id);
              contactIdByEmail.set(lead.normalizedEmail, created.id);
              imported++;
              continue;
            }
            const [concurrent] = await tx.select().from(schema.contacts).where(and(eq(schema.contacts.workspaceId, ctx.workspaceId), eq(schema.contacts.normalizedEmail, lead.normalizedEmail))).limit(1);
            if (!concurrent) throw new OpError("CONFLICT", `Lead ${lead.email} could not be imported.`);
            if (hasUpdates) await tx.update(schema.contacts).set({ ...updates, ...fieldUpdate, updatedAt: new Date() }).where(and(eq(schema.contacts.id, concurrent.id), eq(schema.contacts.workspaceId, ctx.workspaceId)));
            if (Object.keys(fieldUpdate).length) fieldChangedContactIds.push(concurrent.id);
            contactIds.push(concurrent.id);
            contactIdByEmail.set(lead.normalizedEmail, concurrent.id);
            updated++;
          }

          // Campaign variables land before list membership and auto-enrollment so a lead
          // added to a live campaign in this same call already has its lines.
          let variablesUpdated = 0;
          let variablesRerendered = 0;
          const variableContactIds: string[] = [];
          if (variableSequenceId && variableRows.size) {
            const rows = [...variableRows.entries()].flatMap(([normalizedEmail, variables]) => {
              const contactId = contactIdByEmail.get(normalizedEmail);
              return contactId ? [{ contactId, variables }] : [];
            });
            try {
              const written = await upsertLeadVariables(tx, ctx.workspaceId, variableSequenceId, rows);
              variablesUpdated = written.updated;
              variableContactIds.push(...written.contactIds);
              variablesRerendered = await rerenderQueuedMessages(tx, ctx.workspaceId, variableSequenceId, written.contactIds);
            } catch (error) {
              mapVariableError(error);
            }
          }

          let listId: string | undefined;
          let addedLeadIds: string[] = [];
          if (input.listName) {
            const [created] = await tx.insert(schema.contactLists).values({ id: randomUUID(), workspaceId: ctx.workspaceId, name: input.listName, createdByUserId: ctx.userId }).onConflictDoNothing().returning({ id: schema.contactLists.id });
            const list = created ?? (await tx.select({ id: schema.contactLists.id }).from(schema.contactLists).where(and(eq(schema.contactLists.workspaceId, ctx.workspaceId), eq(schema.contactLists.name, input.listName))).limit(1))[0];
            if (!list) throw new OpError("CONFLICT", "The contact list could not be created.");
            listId = list.id;
            if (contactIds.length) {
              const added = await tx.insert(schema.contactListMembers).values([...new Set(contactIds)].map((contactId) => ({ workspaceId: ctx.workspaceId, contactListId: list.id, contactId, addedByUserId: ctx.userId }))).onConflictDoNothing().returning({ contactId: schema.contactListMembers.contactId });
              addedLeadIds = added.map((row) => row.contactId);
            }
          }

          return { imported, updated, skippedSuppressed, skippedInvalid: prepared.skippedInvalid, listId, addedLeadIds, variablesUpdated, variablesRerendered, variableContactIds, fieldChangedContactIds };
        });
        const { addedLeadIds, listId, variablesUpdated, variablesRerendered, variableContactIds, fieldChangedContactIds, ...counts } = result;
        const listEnrollment = listId ? await enrollNewListLeads(ctx, { listId, leadIds: addedLeadIds }) : { campaignUpdates: [] };
        // Leads whose lines just arrived (including ones also in the campaign through another
        // list): enroll them if they are complete now. Already-enrolled leads are skipped.
        const waiting = variableSequenceId ? await enrollWaitingLeads(ctx, variableSequenceId, variableContactIds) : null;
        // Lead-level custom fields count for every campaign: wake leads waiting on them and
        // refresh queued mail in each sequence these contacts are part of.
        const fieldRefresh = fieldChangedContactIds.length ? await refreshLeadsAfterFieldChange(ctx, fieldChangedContactIds).catch(() => null) : null;
        return {
          ...counts,
          ...(listId ? { listId } : {}),
          ...listEnrollment,
          ...(fieldRefresh ? { customFieldsRefresh: { enrolledWaiting: fieldRefresh.enrolled, rerendered: fieldRefresh.rerendered } } : {}),
          ...(variableSequenceId ? { variables: { sequenceId: variableSequenceId, updated: variablesUpdated, rerendered: variablesRerendered, enrolledWaiting: waiting?.enrolled ?? 0 } } : {}),
        };
      },
    },
    {
      name: "campaigns.setLeadVariables",
      description: "Set per-lead custom text variables for a campaign so steps can use tokens like {{icebreaker}}. Pass exactly one of campaignId or sequenceId, and up to 1000 leads, each identified by email or contactId with a variables object of { name: text }. Names use letters, digits and underscores (max 64) and cannot reuse the built-ins firstName, lastName, company, title or email. Values are trimmed, line breaks become spaces, and they are capped at 1000 characters. Writes MERGE into what is stored: named keys are added or overwritten, other keys stay, and a null or blank value deletes that key. When a step renders, each token resolves in this order: built-in lead field (blank when empty), then this campaign's variable, then the lead's customFields value of the same name. Launching a campaign is blocked until every lead in its audience has a value for every custom variable used in the steps' subject or body. Leads waiting on variables in a live campaign are enrolled automatically as soon as their values are complete, and queued emails that were scheduled but not yet attempted are re-rendered with the new values. Clearing a value that a queued, unattempted email needs cancels that email and its enrollment (the lead waits in the queue and re-enrolls when the value returns), so the old text is never sent. Only campaigns published after custom variables shipped enforce them; older sequences keep unknown {{tokens}} as literal text. Returns { sequenceId, updated, notFound, enrolled, rerendered, stillMissing: [{ email, missing }] }.",
      access: "write",
      inputSchema: z.object({
        campaignId: id.optional(),
        sequenceId: id.optional(),
        leads: z.array(z.object({ email: z.string().optional(), contactId: id.optional(), variables: variableValues }).refine((lead) => lead.email || lead.contactId, "Each lead needs an email or contactId.")).min(1).max(1000),
      }).refine((value) => Boolean(value.campaignId) !== Boolean(value.sequenceId), "Provide exactly one of campaignId or sequenceId."),
      outputSchema: anyOutput,
      handler: async (ctx, input) => {
        await requireWorkspaceManager(ctx);
        const sequenceId = await resolveVariableSequence(ctx.db, ctx.workspaceId, input).catch(mapVariableError);
        type LeadRef = { email?: string; contactId?: string; variables: Record<string, string | null> };
        const leadRefs: LeadRef[] = input.leads;
        const contactIds = [...new Set(leadRefs.flatMap((lead) => lead.contactId ? [lead.contactId] : []))];
        const emails = [...new Set(leadRefs.flatMap((lead) => !lead.contactId && lead.email ? [lead.email.trim().toLowerCase()] : []))];
        const [byId, byEmail] = await Promise.all([
          contactIds.length ? ctx.db.select({ id: schema.contacts.id, email: schema.contacts.email, normalizedEmail: schema.contacts.normalizedEmail }).from(schema.contacts).where(and(eq(schema.contacts.workspaceId, ctx.workspaceId), inArray(schema.contacts.id, contactIds))) : [],
          emails.length ? ctx.db.select({ id: schema.contacts.id, email: schema.contacts.email, normalizedEmail: schema.contacts.normalizedEmail }).from(schema.contacts).where(and(eq(schema.contacts.workspaceId, ctx.workspaceId), inArray(schema.contacts.normalizedEmail, emails))) : [],
        ]);
        const idMap = new Map(byId.map((contact) => [contact.id, contact.id]));
        const emailMap = new Map(byEmail.map((contact) => [contact.normalizedEmail, contact.id]));
        const notFound: string[] = [];
        const rows: Array<{ contactId: string; variables: Record<string, string | null> }> = [];
        for (const lead of leadRefs) {
          const contactId = lead.contactId ? idMap.get(lead.contactId) : emailMap.get((lead.email ?? "").trim().toLowerCase());
          if (!contactId) notFound.push(lead.contactId ?? lead.email!);
          else rows.push({ contactId, variables: lead.variables });
        }
        try {
          const result = await applyLeadVariables(ctx, sequenceId, rows);
          return { sequenceId, updated: result.updated, notFound, enrolled: result.enrolled, rerendered: result.rerendered, stillMissing: result.stillMissing };
        } catch (error) {
          return mapVariableError(error);
        }
      },
    },
    {
      name: "campaigns.getLeadVariables",
      description: "Read the per-lead custom variables of a campaign: which custom {{variables}} the steps of its current version use, how many audience leads are ready or missing each, and a paged list of leads with each value and where it comes from. Pass exactly one of campaignId or sequenceId. Audience = leads with a live or completed enrollment in the sequence, leads queued for it, and members of the lists selected on its campaigns (suppressed, unsubscribed and bounced leads excluded). filter is all (default) or missing (leads lacking at least one variable; add variable to narrow to one name). search matches email or name. pageSize max 200 (default 50). Returns { variables: [{ name, ready, missing }], audienceTotal, leads: [{ contactId, email, firstName, lastName, values: { name: { value, source: \"campaign\" | \"lead\" } | null }, missing: [name] }], page, pageSize, total }. Write values with campaigns.setLeadVariables.",
      access: "read",
      inputSchema: z.object({
        campaignId: id.optional(),
        sequenceId: id.optional(),
        filter: z.enum(["all", "missing"]).default("all"),
        variable: z.string().trim().min(1).max(64).optional(),
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(200).default(50),
        search: z.string().trim().max(200).optional(),
      }).refine((value) => Boolean(value.campaignId) !== Boolean(value.sequenceId), "Provide exactly one of campaignId or sequenceId."),
      outputSchema: anyOutput,
      handler: async (ctx, input) => readLeadVariables(ctx.db, ctx.workspaceId, input).catch(mapVariableError),
    },
    {
      name: "campaigns.listLeadVariableNames",
      description: "List the distinct custom variable names already in use in this workspace (keys of lead customFields plus keys of per-campaign values), sorted, at most 200. Returns { names: string[] }.",
      access: "read",
      inputSchema: z.object({}),
      outputSchema: anyOutput,
      handler: async (ctx) => ({ names: await listLeadVariableNames(ctx.db, ctx.workspaceId) }),
    },
    {
      name: "leads.get",
      description: "Get one workspace lead by contact ID or email, including list memberships, sequence enrollments, customFields (lead-level custom text usable as {{name}} in every campaign) and campaignVariables (per-campaign values keyed by sequence).",
      access: "read",
      inputSchema: z.object({ id: id.optional(), email: z.string().email().optional() }).refine((value) => value.id || value.email, "Provide id or email."),
      outputSchema: anyOutput,
      handler: async (ctx, input) => {
        const [contact] = await ctx.db.select().from(schema.contacts).where(and(
          eq(schema.contacts.workspaceId, ctx.workspaceId),
          input.id ? eq(schema.contacts.id, input.id) : eq(schema.contacts.normalizedEmail, input.email!.toLowerCase()),
        )).limit(1);
        if (!contact) throw new OpError("NOT_FOUND", "Lead not found.");
        const [lists, enrollments, touches, campaignVariables] = await Promise.all([
          ctx.db.select({ id: schema.contactLists.id, name: schema.contactLists.name }).from(schema.contactListMembers).innerJoin(schema.contactLists, eq(schema.contactListMembers.contactListId, schema.contactLists.id)).where(and(eq(schema.contactListMembers.workspaceId, ctx.workspaceId), eq(schema.contactLists.workspaceId, ctx.workspaceId), eq(schema.contactListMembers.contactId, contact.id))).orderBy(schema.contactLists.name),
          ctx.db.select({ id: schema.enrollments.id, sequenceId: schema.enrollments.sequenceId, sequenceName: schema.sequences.name, status: schema.enrollments.status, nextStepOrder: schema.enrollments.nextStepOrder, startedAt: schema.enrollments.startedAt, stoppedAt: schema.enrollments.stoppedAt }).from(schema.enrollments).innerJoin(schema.sequences, eq(schema.enrollments.sequenceId, schema.sequences.id)).where(and(eq(schema.enrollments.workspaceId, ctx.workspaceId), eq(schema.sequences.workspaceId, ctx.workspaceId), eq(schema.enrollments.contactId, contact.id))).orderBy(desc(schema.enrollments.createdAt)),
          ctx.db.select({ acceptedAt: schema.messages.acceptedAt }).from(schema.messages).where(and(eq(schema.messages.workspaceId, ctx.workspaceId), eq(schema.messages.contactId, contact.id), eq(schema.messages.status, "accepted"))).orderBy(desc(schema.messages.acceptedAt)).limit(1),
          ctx.db.select({ sequenceId: schema.campaignLeadVariables.sequenceId, sequenceName: schema.sequences.name, values: schema.campaignLeadVariables.values }).from(schema.campaignLeadVariables).innerJoin(schema.sequences, eq(schema.campaignLeadVariables.sequenceId, schema.sequences.id)).where(and(eq(schema.campaignLeadVariables.workspaceId, ctx.workspaceId), eq(schema.sequences.workspaceId, ctx.workspaceId), eq(schema.campaignLeadVariables.contactId, contact.id))).orderBy(schema.sequences.name),
        ]);
        return {
          id: contact.id,
          email: contact.email,
          normalizedEmail: contact.normalizedEmail,
          firstName: contact.firstName ?? "",
          lastName: contact.lastName ?? "",
          company: contact.company ?? "",
          title: contact.title ?? "",
          source: contact.source ?? "",
          status: leadStatus(contact.status),
          listName: lists[0]?.name ?? "Imported leads",
          importedAt: contact.createdAt.toISOString(),
          lastTouchAt: touches[0]?.acceptedAt?.toISOString() ?? null,
          lists,
          customFields: contact.customFields,
          campaignVariables,
          enrollments: enrollments.map((row) => ({ ...row, startedAt: row.startedAt?.toISOString() ?? null, stoppedAt: row.stoppedAt?.toISOString() ?? null })),
        };
      },
    },
    {
      name: "sequences.get",
      description: "Get a sequence's full current definition, saved mailboxIds ([] means all healthy mailboxes), performance, lifecycle timestamps, and version details. Includes the same displayStatus, statusReason, and completedAt fields as sequences.list, including the finished state of a direct sequence-level run with no launched campaign.",
      access: "read",
      inputSchema: z.object({ id }),
      outputSchema: anyOutput,
      handler: async (ctx, input) => {
        const [sequence] = await ctx.db.select().from(schema.sequences).where(and(eq(schema.sequences.id, input.id), eq(schema.sequences.workspaceId, ctx.workspaceId))).limit(1);
        if (!sequence) throw new OpError("NOT_FOUND", "Sequence not found.");
        const version = sequence.currentVersionId ? (await ctx.db.select().from(schema.sequenceVersions).where(and(eq(schema.sequenceVersions.id, sequence.currentVersionId), eq(schema.sequenceVersions.workspaceId, ctx.workspaceId))).limit(1))[0] : undefined;
        const steps = version ? await ctx.db.select().from(schema.sequenceSteps).where(and(eq(schema.sequenceSteps.sequenceVersionId, version.id), eq(schema.sequenceSteps.workspaceId, ctx.workspaceId))).orderBy(schema.sequenceSteps.stepOrder) : [];
        // The most recently created non-archived-sibling campaign for this sequence, same
        // selection readSequences uses for sequences.list (campaigns ordered desc(createdAt),
        // first one kept per sequence).
        const [campaign] = await ctx.db.select({ id: schema.campaigns.id, status: schema.campaigns.status, completedAt: schema.campaigns.completedAt })
          .from(schema.campaigns)
          .where(and(eq(schema.campaigns.sequenceId, sequence.id), eq(schema.campaigns.workspaceId, ctx.workspaceId)))
          .orderBy(desc(schema.campaigns.createdAt))
          .limit(1);
        const [enrollmentRows, sentRows] = await Promise.all([
          ctx.db.select({ status: schema.enrollments.status, stoppedAt: schema.enrollments.stoppedAt }).from(schema.enrollments).where(and(eq(schema.enrollments.sequenceId, sequence.id), eq(schema.enrollments.workspaceId, ctx.workspaceId))),
          ctx.db.select({ id: schema.messages.id }).from(schema.messages).innerJoin(schema.enrollments, eq(schema.messages.enrollmentId, schema.enrollments.id)).where(and(eq(schema.messages.workspaceId, ctx.workspaceId), eq(schema.enrollments.workspaceId, ctx.workspaceId), eq(schema.enrollments.sequenceId, sequence.id), eq(schema.messages.status, "accepted"))),
        ]);
        const snapshot = (version?.snapshot ?? {}) as Record<string, unknown>;
        const replied = enrollmentRows.filter((row) => row.status === "replied").length;
        const inProgressCount = enrollmentRows.filter((row) => row.status === "scheduled" || row.status === "active" || row.status === "paused").length;
        let lastStoppedAt: Date | null = null;
        for (const row of enrollmentRows) if (row.stoppedAt && (!lastStoppedAt || row.stoppedAt > lastStoppedAt)) lastStoppedAt = row.stoppedAt;
        const displayStatuses = await campaignDisplayStatuses(ctx.db, ctx.workspaceId, [
          { id: sequence.id, sequenceId: sequence.id, status: sequence.status },
          ...(campaign ? [{ id: campaign.id, sequenceId: sequence.id, status: campaign.status }] : []),
        ], ctx.env.edition);
        const display = deriveSequenceDisplay({
          sequenceStatus: sequence.status,
          campaign,
          enrolledCount: enrollmentRows.length,
          inProgressCount,
          lastStoppedAt,
          sequenceOwnDisplay: displayStatuses.get(sequence.id)!,
          campaignDisplay: campaign ? displayStatuses.get(campaign.id) : undefined,
        });
        return {
          id: sequence.id,
          name: sequence.name,
          mailboxIds: await readSequenceMailboxIds(ctx.db, ctx.workspaceId, sequence.id),
          description: typeof snapshot.description === "string" ? snapshot.description : "",
          status: sequence.status === "active" ? "published" : sequence.status,
          displayStatus: display.displayStatus,
          statusReason: display.statusReason,
          completedAt: display.completedAt,
          steps: steps.map((step) => ({ id: step.id, delayDays: step.delayDays, subject: step.subject, body: step.bodyText })),
          enrolledCount: enrollmentRows.length,
          replyRate: sentRows.length ? Number(((replied / sentRows.length) * 100).toFixed(1)) : 0,
          createdAt: sequence.createdAt.toISOString(),
          updatedAt: sequence.updatedAt.toISOString(),
          currentVersionId: sequence.currentVersionId,
          version: version?.version ?? null,
          versionStatus: version?.status ?? null,
          launchedAt: version?.launchedAt?.toISOString() ?? null,
          pausedAt: sequence.pausedAt?.toISOString() ?? null,
          archivedAt: sequence.archivedAt?.toISOString() ?? null,
        };
      },
    },
    {
      name: "sequences.launch",
      description: "Publish a sequence and optionally enroll each contact once from up to 20 contact lists. Supplied mailboxIds are saved; otherwise use the saved sender selection. Use listIds for multiple lists or legacy listId for one list. Enrolled contacts join the sequence's single launched campaign when it has one, which restarts a finished campaign and starts sends.",
      access: "write",
      inputSchema: z.object({ id, listIds: listIds.optional(), listId: id.nullable().optional(), mailboxIds: sequenceMailboxIdsSchema.optional() }),
      outputSchema: anyOutput,
      handler: async (ctx, input) => {
        await requireWorkspaceManager(ctx);
        await requireVerifiedWorkspaceOwner(ctx);
        if (input.listIds !== undefined && input.listId !== undefined) throw new OpError("BAD_INPUT", "Provide either listIds or the legacy listId, not both.");
        const selectedListIds = input.listIds !== undefined ? input.listIds : input.listId ? [input.listId] : [];
        if (selectedListIds.length) {
          // The campaign enrollSequence will attach (the sequence's single non-archived,
          // already-launched campaign) decides duplicate rules, so the gate must use the same one.
          const attachable = await ctx.db.select({ id: schema.campaigns.id, status: schema.campaigns.status }).from(schema.campaigns).where(and(eq(schema.campaigns.workspaceId, ctx.workspaceId), eq(schema.campaigns.sequenceId, input.id), ne(schema.campaigns.status, "archived"))).limit(2);
          const gateCampaignId = attachable.length === 1 && attachable[0]!.status !== "draft" ? attachable[0]!.id : undefined;
          await assertLaunchAudienceComplete(ctx.db, OpError, { workspaceId: ctx.workspaceId, sequenceId: input.id, campaignId: gateCampaignId, listIds: selectedListIds });
        }
        if (input.mailboxIds !== undefined) await runNamed("sequences.setMailboxes", ctx, { id: input.id, mailboxIds: input.mailboxIds });
        const published = await runNamed("sequences.publish", ctx, { id: input.id });
        if (!selectedListIds.length) return { sequence: published.sequence, enrolled: 0, skipped: {} };
        const enrollment = await runNamed("sequences.enroll", ctx, { id: input.id, listIds: selectedListIds });
        return { sequence: published.sequence, enrolled: enrollment.enrolled, skipped: enrollment.skipped };
      },
    },
    {
      name: "enrollments.list",
      description: "List filtered, paginated enrollments for a workspace sequence with contact and latest-event details.",
      access: "read",
      inputSchema: z.object({ sequenceId: id, status: enrollmentStatus.optional(), page: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(100).default(25) }),
      outputSchema: anyOutput,
      handler: async (ctx, input) => pagedEnrollments(ctx, input.sequenceId, input, OpError),
    },
    {
      name: "replies.list",
      description: "List captured workspace replies with contact, sequence, step, and mailbox details.",
      access: "read",
      inputSchema: z.object({ sequenceId: id.optional(), emailAccountId: id.optional(), unread: z.boolean().optional(), autoReplies: z.boolean().optional(), page: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(100).default(25) }),
      outputSchema: anyOutput,
      handler: async (ctx, input) => {
        const filtered = and(
          eq(schema.replies.workspaceId, ctx.workspaceId),
          input.sequenceId ? eq(schema.replies.sequenceId, input.sequenceId) : undefined,
          input.emailAccountId ? eq(schema.replies.emailAccountId, input.emailAccountId) : undefined,
          input.unread ? isNull(schema.replies.readAt) : undefined,
          input.autoReplies === false ? eq(schema.replies.isAutoReply, false) : undefined,
        );
        const unreadFilter = and(
          eq(schema.replies.workspaceId, ctx.workspaceId),
          input.sequenceId ? eq(schema.replies.sequenceId, input.sequenceId) : undefined,
          input.emailAccountId ? eq(schema.replies.emailAccountId, input.emailAccountId) : undefined,
          input.autoReplies === false ? eq(schema.replies.isAutoReply, false) : undefined,
          isNull(schema.replies.readAt),
        );
        const [[countRow], [unreadCountRow], replyRows] = await Promise.all([
          ctx.db.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(schema.replies).where(filtered),
          ctx.db.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(schema.replies).where(unreadFilter),
          ctx.db.select().from(schema.replies).where(filtered).orderBy(desc(schema.replies.receivedAt)).limit(input.pageSize).offset((input.page - 1) * input.pageSize),
        ]);
        return {
          replies: await replyListItems(ctx, replyRows),
          pagination: { page: input.page, pageSize: input.pageSize, total: countRow?.count ?? 0, unreadTotal: unreadCountRow?.count ?? 0 },
        };
      },
    },
    {
      name: "replies.get",
      description: "Get one workspace reply and its outbound campaign thread.",
      access: "read",
      inputSchema: z.object({ id }),
      outputSchema: anyOutput,
      handler: async (ctx, input) => {
        const [reply] = await ctx.db.select().from(schema.replies).where(and(eq(schema.replies.id, input.id), eq(schema.replies.workspaceId, ctx.workspaceId))).limit(1);
        if (!reply) throw new OpError("NOT_FOUND", "Reply not found.");
        const [listItem] = await replyListItems(ctx, [reply]);
        const [outbound, manualReplies] = await Promise.all([
          reply.enrollmentId ? ctx.db.select({ subject: schema.messages.subject, metadata: schema.messages.metadata, acceptedAt: schema.messages.acceptedAt, stepOrder: schema.sequenceSteps.stepOrder }).from(schema.messages).innerJoin(schema.sequenceSteps, eq(schema.messages.sequenceStepId, schema.sequenceSteps.id)).where(and(eq(schema.messages.workspaceId, ctx.workspaceId), eq(schema.sequenceSteps.workspaceId, ctx.workspaceId), eq(schema.messages.enrollmentId, reply.enrollmentId), eq(schema.messages.status, "accepted"), isNotNull(schema.messages.acceptedAt))).orderBy(asc(schema.messages.acceptedAt)) : Promise.resolve([]),
          ctx.db.select({ metadata: schema.messageEvents.metadata, occurredAt: schema.messageEvents.occurredAt }).from(schema.messageEvents).where(and(
            eq(schema.messageEvents.workspaceId, ctx.workspaceId),
            eq(schema.messageEvents.eventType, "manual_reply_sent"),
            sql`${schema.messageEvents.metadata}->>'replyId' = ${reply.id}`,
          )).orderBy(asc(schema.messageEvents.occurredAt)),
        ]);
        const inboundSplit = inboundReplyBody(reply.bodyText);
        const thread: ReplyThreadEntry[] = [
          ...outbound.map((message) => ({
            direction: "outbound" as const,
            subject: message.subject,
            body: typeof message.metadata?.bodyText === "string" ? message.metadata.bodyText : "",
            quotedText: null,
            at: message.acceptedAt!.toISOString(),
            stepOrder: message.stepOrder,
          })),
          { direction: "inbound" as const, subject: reply.subject, body: inboundSplit.body, quotedText: inboundSplit.quotedText, at: reply.receivedAt.toISOString(), stepOrder: null },
          ...manualReplies.map((event) => ({
            direction: "outbound" as const,
            subject: typeof event.metadata?.subject === "string" ? event.metadata.subject : reply.subject,
            body: typeof event.metadata?.bodyText === "string" ? event.metadata.bodyText : "",
            quotedText: null,
            at: event.occurredAt.toISOString(),
            stepOrder: null,
          })),
        ].sort((left, right) => left.at.localeCompare(right.at));
        return {
          reply: {
            ...listItem!,
            bodyText: reply.bodyText,
            thread,
          },
        };
      },
    },
    {
      name: "replies.markRead",
      description: "Mark one workspace reply as read.",
      access: "write",
      inputSchema: z.object({ id }),
      outputSchema: anyOutput,
      handler: async (ctx, input) => {
        const [updated] = await ctx.db.update(schema.replies).set({ readAt: new Date(), updatedAt: new Date() }).where(and(eq(schema.replies.id, input.id), eq(schema.replies.workspaceId, ctx.workspaceId), isNull(schema.replies.readAt))).returning();
        const reply = updated ?? (await ctx.db.select().from(schema.replies).where(and(eq(schema.replies.id, input.id), eq(schema.replies.workspaceId, ctx.workspaceId))).limit(1))[0];
        if (!reply) throw new OpError("NOT_FOUND", "Reply not found.");
        const [listItem] = await replyListItems(ctx, [reply]);
        return { reply: listItem! };
      },
    },
    {
      name: "replies.send",
      description: "Send a one-off response to a captured reply without restarting its enrollment.",
      access: "write",
      inputSchema: z.object({ id, body: z.string().trim().min(1), idempotencyKey: z.string().uuid().optional() }),
      outputSchema: anyOutput,
      handler: async (ctx, input) => {
        const [reply] = await ctx.db.select().from(schema.replies).where(and(eq(schema.replies.id, input.id), eq(schema.replies.workspaceId, ctx.workspaceId))).limit(1);
        if (!reply) throw new OpError("NOT_FOUND", "Reply not found.");
        const [[contact], [emailAccount]] = await Promise.all([
          ctx.db.select().from(schema.contacts).where(and(eq(schema.contacts.id, reply.contactId), eq(schema.contacts.workspaceId, ctx.workspaceId))).limit(1),
          reply.emailAccountId ? ctx.db.select().from(schema.emailAccounts).where(and(eq(schema.emailAccounts.id, reply.emailAccountId), eq(schema.emailAccounts.workspaceId, ctx.workspaceId))).limit(1) : Promise.resolve([]),
        ]);
        if (!contact) throw new OpError("NOT_FOUND", "Reply contact not found.");
        if (!emailAccount) throw new OpError("CONFLICT", "Reply is not associated with a sending mailbox.");
        const normalizedEmail = contact.normalizedEmail;
        const emailHash = createHash("sha256").update(normalizedEmail).digest("hex");
        const originalSubject = reply.subject?.trim() ?? "";
        const subject = /^re\s*:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`.trimEnd();
        const [originalMessage] = emailAccount.provider === "smtp" && reply.inReplyToMessageId
          ? await ctx.db.select().from(schema.messages).where(and(
            eq(schema.messages.id, reply.inReplyToMessageId),
            eq(schema.messages.workspaceId, ctx.workspaceId),
            eq(schema.messages.emailAccountId, emailAccount.id),
            eq(schema.messages.contactId, contact.id),
          )).limit(1)
          : [];
        const inReplyTo = emailAccount.provider === "smtp"
          ? replyRfcMessageId(reply.providerMessageId) ?? replyRfcMessageId(originalMessage?.internetMessageId) ?? replyRfcMessageId(originalMessage?.providerMessageId)
          : undefined;
        const references = [...new Set([
          replyRfcMessageId(reply.providerThreadId),
          replyRfcMessageId(originalMessage?.internetMessageId) ?? replyRfcMessageId(originalMessage?.providerMessageId),
          inReplyTo,
        ].filter((messageId): messageId is string => Boolean(messageId)))];
        const threading = emailAccount.provider === "gmail" || (emailAccount.provider === "smtp" && inReplyTo) ? "in_thread" as const : "new_thread" as const;
        const bodyHash = createHash("sha256").update(input.body).digest("hex");
        const providerEventId = `manual-reply:${input.idempotencyKey ?? `${reply.id}:${bodyHash}`}`;
        // Reserve the send before calling the provider. If a provider response or
        // post-send database write is ambiguous, a retry must never send twice.
        const reservation = await ctx.db.transaction(async (tx) => {
          const gateResult = await tx.execute(sql`
            SELECT now() AS gate_now,
              w.status::text AS workspace_status,w.kill_switch_enabled,w.daily_send_cap AS workspace_daily_cap,
              COALESCE((SELECT au.email_verified FROM memberships om JOIN auth_users au ON au.id=om.user_id
                WHERE om.workspace_id=w.id AND om.role='owner' AND om.status='active'
                ORDER BY om.created_at LIMIT 1),false) AS owner_email_verified,
              sub.status AS subscription_status,sub.trial_end AS subscription_trial_end,
              sub.updated_at + interval '7 days' AS subscription_grace_end,
              a.status::text AS mailbox_status,a.daily_limit,a.hourly_limit,a.ramp_started_on,a.ramp_paused_days,
              mh.state AS health_state,mh.effective_daily_limit,mh.throttled_until,
              pc.state AS circuit_state,pc.next_probe_at,
              (c.unsubscribed_at IS NOT NULL OR c.status IN ('suppressed','unsubscribed')
                OR EXISTS (SELECT 1 FROM suppressions su WHERE su.workspace_id=w.id
                  AND (su.normalized_email=c.normalized_email OR su.email_hash=${emailHash}))) AS suppressed,
              (NOT EXISTS (SELECT 1 FROM mailbox_schedules ms WHERE ms.email_account_id=a.id AND ms.is_active=true)
                OR EXISTS (SELECT 1 FROM mailbox_schedules ms WHERE ms.email_account_id=a.id AND ms.is_active=true
                  AND ms.day_of_week=extract(dow FROM now() AT TIME ZONE ms.timezone)::int
                  AND (now() AT TIME ZONE ms.timezone)::time BETWEEN ms.start_time AND ms.end_time)) AS in_sending_window,
              (SELECT count(*)::int FROM messages m WHERE m.workspace_id=w.id AND (
                (m.status='accepted' AND m.accepted_at::date=CURRENT_DATE)
                OR (m.status='sending' AND m.claim_expires_at>now())
                OR (m.status='failed' AND m.error_class='unknown_provider_result' AND m.updated_at::date=CURRENT_DATE)
              )) + (SELECT count(*)::int FROM message_events ev WHERE ev.workspace_id=w.id
                AND ev.event_type IN ('manual_reply_pending','manual_reply_sent')
                AND ev.occurred_at::date=CURRENT_DATE) AS workspace_today,
              (SELECT count(*)::int FROM messages m WHERE m.email_account_id=a.id AND (
                (m.status='accepted' AND m.accepted_at::date=CURRENT_DATE)
                OR (m.status='sending' AND m.claim_expires_at>now())
                OR (m.status='failed' AND m.error_class='unknown_provider_result' AND m.updated_at::date=CURRENT_DATE)
              )) + (SELECT count(*)::int FROM message_events ev WHERE ev.workspace_id=w.id
                AND ev.event_type IN ('manual_reply_pending','manual_reply_sent')
                AND ev.metadata->>'emailAccountId'=a.id::text AND ev.occurred_at::date=CURRENT_DATE) AS mailbox_today,
              (SELECT count(*)::int FROM messages m WHERE m.email_account_id=a.id AND (
                (m.status='accepted' AND m.accepted_at>now()-interval '1 hour')
                OR (m.status='sending' AND m.claim_expires_at>now())
                OR (m.status='failed' AND m.error_class='unknown_provider_result' AND m.updated_at>now()-interval '1 hour')
              )) + (SELECT count(*)::int FROM message_events ev WHERE ev.workspace_id=w.id
                AND ev.event_type IN ('manual_reply_pending','manual_reply_sent')
                AND ev.metadata->>'emailAccountId'=a.id::text AND ev.occurred_at>now()-interval '1 hour') AS mailbox_hour,
              GREATEST(
                (SELECT max(COALESCE(m.accepted_at,m.claimed_at)) FROM messages m
                  WHERE m.email_account_id=a.id AND m.status IN ('accepted','sending')),
                (SELECT max(ev.occurred_at) FROM message_events ev WHERE ev.workspace_id=w.id
                  AND ev.event_type IN ('manual_reply_pending','manual_reply_sent')
                  AND ev.metadata->>'emailAccountId'=a.id::text)
              ) + interval '30 seconds' AS next_allowed_at
            FROM email_accounts a
            JOIN workspaces w ON w.id=a.workspace_id
            JOIN contacts c ON c.id=${reply.contactId} AND c.workspace_id=w.id
            LEFT JOIN subscriptions sub ON sub.workspace_id=w.id
            LEFT JOIN mailbox_health mh ON mh.email_account_id=a.id
            LEFT JOIN provider_circuit pc ON pc.provider=${sql.raw(providerCircuitKeySql("a"))}
            WHERE a.id=${emailAccount.id} AND a.workspace_id=${ctx.workspaceId}
            FOR UPDATE OF a,w,c
          `);
          const gate = gateResult.rows[0] as ManualReplyGateRow | undefined;
          if (!gate) throw new OpError("CONFLICT", "The sending mailbox is no longer available.");
          const [existing] = await tx.select().from(schema.messageEvents).where(and(
            eq(schema.messageEvents.workspaceId, ctx.workspaceId),
            eq(schema.messageEvents.providerEventId, providerEventId),
          )).limit(1);
          if (existing) {
            if (existing.metadata?.replyId !== reply.id || existing.metadata?.bodyHash !== bodyHash) {
              throw new OpError("CONFLICT", "This send request was already used for another reply.");
            }
            if (existing.eventType !== "manual_reply_sent") {
              throw new OpError("CONFLICT", "This reply may already have been sent. Check the conversation before trying again.");
            }
            return {
              alreadySent: true as const,
              providerMessageId: typeof existing.metadata?.providerMessageId === "string" ? existing.metadata.providerMessageId : null,
              threading: existing.metadata?.threading === "in_thread" ? "in_thread" as const : "new_thread" as const,
            };
          }
          const gateNow = new Date(gate.gate_now);
          const decision = canSend({
            now: gateNow,
            edition: ctx.env.edition,
            ownerEmailVerified: gate.owner_email_verified,
            // canSend never applies the plan gate (license, legacy Free cap) to
            // manual replies, so the month count and legacy window are not read.
            workspace: { status: gate.workspace_status, killSwitchEnabled: gate.kill_switch_enabled, dailySendCap: gate.workspace_daily_cap, sentToday: gate.workspace_today, sentThisMonth: 0, legacyFreeUntil: null },
            subscription: gate.subscription_status ? { status: gate.subscription_status, trialEnd: gateDate(gate.subscription_trial_end), onHoldGraceEndsAt: gateDate(gate.subscription_grace_end) } : null,
            mailbox: {
              status: gate.mailbox_status,
              dailyLimit: gate.daily_limit,
              hourlyLimit: gate.hourly_limit,
              rampStartedOn: gate.ramp_started_on,
              rampPausedDays: gate.ramp_paused_days,
              sentToday: gate.mailbox_today,
              sentLastHour: gate.mailbox_hour,
              inSendingWindow: gate.in_sending_window,
              nextAllowedAt: gateDate(gate.next_allowed_at),
            },
            health: gate.health_state ? { state: gate.health_state, effectiveDailyLimit: gate.effective_daily_limit, throttledUntil: gateDate(gate.throttled_until) } : null,
            providerCircuit: gate.circuit_state ? { state: gate.circuit_state, nextProbeAt: gateDate(gate.next_probe_at), probeAllowed: false } : null,
          }, { mode: "manual_reply", sequenceStatus: "replied", enrollmentStatus: "replied", suppressed: gate.suppressed, alreadyReplied: true });
          if (!decision.allowed) throw new OpError("FORBIDDEN", manualReplyDenyMessage(decision.reason));
          const eventId = randomUUID();
          await tx.insert(schema.messageEvents).values({
            id: eventId,
            workspaceId: ctx.workspaceId,
            messageId: reply.inReplyToMessageId,
            eventType: "manual_reply_pending",
            providerEventId,
            occurredAt: gateNow,
            metadata: { replyId: reply.id, contactId: contact.id, emailAccountId: emailAccount.id, bodyHash, bodyText: input.body, subject, threading },
          });
          return { alreadySent: false as const, eventId };
        });
        if (reservation.alreadySent) return { sent: true, providerMessageId: reservation.providerMessageId, threading: reservation.threading };
        let mailClient: ReplySender | undefined;
        try {
          mailClient = ctx.mailClientFor
            ? await ctx.mailClientFor({ provider: emailAccount.provider, emailAccountId: emailAccount.id })
            : ctx.composio;
        } catch {
          await ctx.db.delete(schema.messageEvents).where(eq(schema.messageEvents.id, reservation.eventId));
          throw new OpError("UNAVAILABLE", "Reply sending is not configured.");
        }
        if (!mailClient?.enabled || (emailAccount.provider === "smtp" && !ctx.mailClientFor)) {
          await ctx.db.delete(schema.messageEvents).where(eq(schema.messageEvents.id, reservation.eventId));
          throw new OpError("UNAVAILABLE", "Reply sending is not configured.");
        }
        let sent: Awaited<ReturnType<ReplySender["sendEmail"]>>;
        try {
          if (emailAccount.provider !== "smtp") assertComposioProvider(emailAccount.provider, "replies.send.sendEmail");
          sent = await mailClient.sendEmail({
            connectedAccountId: emailAccount.composioConnectedAccountId,
            userId: emailAccount.userId,
            provider: emailAccount.provider,
            to: contact.email,
            subject,
            body: input.body,
            ...(emailAccount.provider === "gmail" && reply.providerThreadId ? { threadId: reply.providerThreadId } : {}),
            ...(emailAccount.provider === "smtp" ? {
              from: emailAccount.email ?? undefined,
              messageId: rfcMessageId(reservation.eventId, ctx.env.edition, emailAccount.email),
              ...(inReplyTo ? { inReplyTo, references: references.join(" ") } : {}),
            } : {}),
          });
        } catch (error) {
          const rejectionStatus = definiteProviderRejection(error);
          if (rejectionStatus !== null) {
            await ctx.db.delete(schema.messageEvents).where(eq(schema.messageEvents.id, reservation.eventId));
            ctx.logger?.warn?.({ replyId: reply.id, providerStatus: rejectionStatus }, "Manual reply rejected; reservation released");
            throw new OpError("UNAVAILABLE", providerRejectionMessage(rejectionStatus));
          }
          ctx.logger?.warn?.({ replyId: reply.id, ...(emailAccount.provider === "smtp" ? { provider: "smtp" } : { error }) }, "Manual reply result is unknown; reservation retained");
          throw new OpError("UNAVAILABLE", "The send result is unknown. Check the conversation before trying again.");
        }
        try {
          await ctx.db.update(schema.messageEvents).set({
            eventType: "manual_reply_sent",
            occurredAt: new Date(),
            metadata: {
              replyId: reply.id,
              contactId: contact.id,
              emailAccountId: emailAccount.id,
              bodyHash,
              provider: emailAccount.provider,
              providerMessageId: sent.providerMessageId ?? null,
              providerThreadId: sent.providerThreadId ?? reply.providerThreadId,
              composioLogId: sent.logId ?? null,
              subject,
              bodyText: input.body,
              threading,
            },
          }).where(eq(schema.messageEvents.id, reservation.eventId));
        } catch (error) {
          ctx.logger?.warn?.({ replyId: reply.id, error }, "Manual reply accepted but bookkeeping failed");
          throw new OpError("UNAVAILABLE", "The reply may have been sent. Check the conversation before trying again.");
        }
        return { sent: true, providerMessageId: sent.providerMessageId ?? null, threading };
      },
    },
    {
      name: "analytics.overview",
      description: "Get workspace delivery, sequence, and healthy-mailbox KPIs for a custom date range.",
      access: "read",
      inputSchema: z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() }),
      outputSchema: anyOutput,
      handler: async (ctx, input) => {
        const to = input.to ? new Date(input.to) : new Date();
        const from = input.from ? new Date(input.from) : new Date(to);
        if (!input.from) {
          from.setUTCDate(from.getUTCDate() - 29);
          from.setUTCHours(0, 0, 0, 0);
        }
        if (from > to) throw new OpError("BAD_INPUT", "from must be before or equal to to.");
        const [messageRows, openRows, replyRows, bounceRows, sequenceRows, mailboxRows] = await Promise.all([
          ctx.db.select({ id: schema.messages.id }).from(schema.messages).where(and(eq(schema.messages.workspaceId, ctx.workspaceId), eq(schema.messages.status, "accepted"), gte(schema.messages.acceptedAt, from), lte(schema.messages.acceptedAt, to))),
          ctx.db.select({ messageId: schema.messageEvents.messageId }).from(schema.messageEvents).where(and(eq(schema.messageEvents.workspaceId, ctx.workspaceId), eq(schema.messageEvents.eventType, "opened"), gte(schema.messageEvents.occurredAt, from), lte(schema.messageEvents.occurredAt, to))),
          ctx.db.select({ id: schema.enrollments.id }).from(schema.enrollments).where(and(eq(schema.enrollments.workspaceId, ctx.workspaceId), eq(schema.enrollments.status, "replied"), gte(schema.enrollments.stoppedAt, from), lte(schema.enrollments.stoppedAt, to))),
          ctx.db.select({ id: schema.enrollments.id }).from(schema.enrollments).where(and(eq(schema.enrollments.workspaceId, ctx.workspaceId), eq(schema.enrollments.status, "bounced"), gte(schema.enrollments.stoppedAt, from), lte(schema.enrollments.stoppedAt, to))),
          ctx.db.select({ id: schema.sequences.id }).from(schema.sequences).where(and(eq(schema.sequences.workspaceId, ctx.workspaceId), eq(schema.sequences.status, "active"))),
          ctx.db.select({ state: schema.mailboxHealth.state }).from(schema.emailAccounts).leftJoin(schema.mailboxHealth, and(eq(schema.mailboxHealth.emailAccountId, schema.emailAccounts.id), eq(schema.mailboxHealth.workspaceId, ctx.workspaceId))).where(and(eq(schema.emailAccounts.workspaceId, ctx.workspaceId), eq(schema.emailAccounts.status, "active"))),
        ]);
        const sent = messageRows.length;
        const bounced = bounceRows.length;
        return { sent, delivered: Math.max(0, sent - bounced), opened: new Set(openRows.flatMap((row) => row.messageId ? [row.messageId] : [])).size, replied: replyRows.length, bounced, activeSequences: sequenceRows.length, healthyMailboxes: mailboxRows.filter((row) => !row.state || !UNHEALTHY_MAILBOX_STATES.has(row.state as MailboxHealthState)).length };
      },
    },
    {
      name: "reports.campaign",
      description: "Get a sequence campaign funnel, per-step performance, and the best-performing sent step.",
      access: "read",
      inputSchema: z.object({ id }),
      outputSchema: anyOutput,
      handler: async (ctx, input) => {
        const analytics = await runNamed("sequences.analytics", ctx, { id: input.id });
        const enrollmentStatus = analytics.enrollmentStatus as Record<string, number>;
        const enrolled = Object.values(enrollmentStatus).reduce((total, count) => total + count, 0);
        const candidates = (analytics.steps as Array<{ sent: number; replyRate: number; stepOrder: number }>).filter((step) => step.sent > 0).sort((left, right) => right.replyRate - left.replyRate || left.stepOrder - right.stepOrder);
        return { sequenceId: analytics.sequenceId, funnel: { enrolled, sent: analytics.totals.sent, opened: analytics.totals.opened, replied: analytics.totals.replied, bounced: analytics.totals.bounced }, steps: analytics.steps, bestPerformingStep: candidates[0] ?? null };
      },
    },
  ];
}
