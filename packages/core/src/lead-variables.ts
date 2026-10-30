import { schema, type InboxJoyDb } from "@inboxjoy/db";
import { appendUnsubscribeFooter } from "@inboxjoy/email";
import { and, asc, eq, inArray, notExists, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";

import { reconcileCampaignStatus } from "./campaign-status.js";
import { enrollLeadsIntoCampaign, type CampaignUpdate } from "./enroll-new-list-leads.js";
import { convertQueuedLeads, type OperationContext } from "./index.js";
import {
  extractCustomVariables,
  isBuiltInOrAliasVariable,
  missingCustomVariables,
  renderTemplate,
  sanitizeVariableValue,
  VARIABLE_NAME_PATTERN,
} from "./template-variables.js";

type ReadDb = Pick<InboxJoyDb, "select">;
type WriteDb = Pick<InboxJoyDb, "select" | "insert" | "update" | "execute">;

const ID_CHUNK = 5_000;

function chunks<T>(items: T[], size = ID_CHUNK): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

export class LeadVariableError extends Error {
  constructor(public code: "BAD_INPUT" | "NOT_FOUND", message: string) {
    super(message);
    this.name = "LeadVariableError";
  }
}

// Validates a variable name for writing: custom names only (built-ins are columns).
export function assertWritableVariableName(name: string): void {
  if (!VARIABLE_NAME_PATTERN.test(name)) {
    throw new LeadVariableError("BAD_INPUT", `Variable name "${name}" is invalid. Use letters, digits and underscores, starting with a letter (max 64 characters).`);
  }
  if (isBuiltInOrAliasVariable(name)) {
    throw new LeadVariableError("BAD_INPUT", `"${name}" is a built-in field (firstName, lastName, company, title, email, or an alias such as first_name or company_name). Update it on the lead instead of setting it as a variable.`);
  }
}

// Splits a { name: value|null } map into keys to set (sanitized) and keys to delete.
// A null or blank value deletes the key.
export function splitVariableUpdates(variables: Record<string, string | null | undefined>): { set: Record<string, string>; remove: string[] } {
  const set: Record<string, string> = {};
  const remove: string[] = [];
  for (const [name, raw] of Object.entries(variables)) {
    assertWritableVariableName(name);
    const value = sanitizeVariableValue(raw);
    if (value === undefined) remove.push(name);
    else set[name] = value;
  }
  return { set, remove };
}

// jsonb column || {set} - {remove keys}. Arrays are passed as JSON because drizzle
// expands a raw JS array parameter into a value list.
export function jsonbMergeSql(column: AnyColumn, set: Record<string, string>, remove: string[]): SQL {
  let expression: SQL = sql`${column}`;
  if (Object.keys(set).length) expression = sql`(${expression} || ${JSON.stringify(set)}::jsonb)`;
  if (remove.length) expression = sql`(${expression} - ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(remove)}::jsonb)))`;
  return expression;
}

async function resolveVersionId(db: ReadDb, workspaceId: string, sequenceId: string, sequenceVersionId?: string): Promise<string | undefined> {
  if (sequenceVersionId) return sequenceVersionId;
  const [sequence] = await db.select({ currentVersionId: schema.sequences.currentVersionId }).from(schema.sequences).where(and(eq(schema.sequences.id, sequenceId), eq(schema.sequences.workspaceId, workspaceId))).limit(1);
  if (sequence?.currentVersionId) return sequence.currentVersionId;
  // Unpublished sequence without a current pointer: use its newest version.
  const [latest] = await db.select({ id: schema.sequenceVersions.id }).from(schema.sequenceVersions).where(and(eq(schema.sequenceVersions.sequenceId, sequenceId), eq(schema.sequenceVersions.workspaceId, workspaceId))).orderBy(sql`${schema.sequenceVersions.version} desc`).limit(1);
  return latest?.id;
}

// Whether a sequence version enforces custom {{variables}} (gates, skips, cancels). Versions
// published before the feature shipped are grandfathered: false. Unknown version: false.
export async function isCustomVariablesEnforced(db: ReadDb, workspaceId: string, sequenceId: string, sequenceVersionId?: string): Promise<boolean> {
  const versionId = await resolveVersionId(db, workspaceId, sequenceId, sequenceVersionId);
  if (!versionId) return false;
  const [version] = await db.select({ enforced: schema.sequenceVersions.customVariablesEnforced }).from(schema.sequenceVersions).where(and(
    eq(schema.sequenceVersions.id, versionId),
    eq(schema.sequenceVersions.sequenceId, sequenceId),
    eq(schema.sequenceVersions.workspaceId, workspaceId),
  )).limit(1);
  return version?.enforced === true;
}

async function stepTemplates(db: ReadDb, workspaceId: string, sequenceId: string, sequenceVersionId?: string): Promise<{ templates: string[]; enforced: boolean }> {
  const versionId = await resolveVersionId(db, workspaceId, sequenceId, sequenceVersionId);
  if (!versionId) return { templates: [], enforced: false };
  const rows = await db.select({ subject: schema.sequenceSteps.subject, bodyText: schema.sequenceSteps.bodyText, enforced: schema.sequenceVersions.customVariablesEnforced }).from(schema.sequenceSteps)
    .innerJoin(schema.sequenceVersions, eq(schema.sequenceSteps.sequenceVersionId, schema.sequenceVersions.id))
    .where(and(
      eq(schema.sequenceVersions.id, versionId),
      eq(schema.sequenceVersions.sequenceId, sequenceId),
      eq(schema.sequenceVersions.workspaceId, workspaceId),
      eq(schema.sequenceSteps.workspaceId, workspaceId),
    ))
    .orderBy(asc(schema.sequenceSteps.stepOrder));
  return { templates: rows.flatMap((row) => [row.subject, row.bodyText]), enforced: rows.length ? rows[0]!.enforced === true : false };
}

// Campaign-scoped values per contact for one sequence. Always workspace-filtered.
export async function loadLeadVariables(db: ReadDb, workspaceId: string, sequenceId: string, contactIds: string[]): Promise<Map<string, Record<string, string>>> {
  const result = new Map<string, Record<string, string>>();
  for (const batch of chunks([...new Set(contactIds)])) {
    const rows = await db.select({ contactId: schema.campaignLeadVariables.contactId, values: schema.campaignLeadVariables.values }).from(schema.campaignLeadVariables).where(and(
      eq(schema.campaignLeadVariables.workspaceId, workspaceId),
      eq(schema.campaignLeadVariables.sequenceId, sequenceId),
      inArray(schema.campaignLeadVariables.contactId, batch),
    ));
    for (const row of rows) result.set(row.contactId, row.values ?? {});
  }
  return result;
}

// Custom {{variables}} required by the steps of a version (default: current): the ones used
// across subject + body. A grandfathered version (published before custom variables shipped)
// requires none, its {{tokens}} are plain text.
export async function sequenceRequiredVariables(db: ReadDb, workspaceId: string, sequenceId: string, sequenceVersionId?: string): Promise<string[]> {
  const { templates, enforced } = await stepTemplates(db, workspaceId, sequenceId, sequenceVersionId);
  return enforced ? extractCustomVariables(...templates) : [];
}

// contactId -> custom variable names the lead cannot resolve (campaign value, then
// lead custom field). Only contacts with at least one missing name are returned.
export async function findLeadsMissingVariables(db: ReadDb, workspaceId: string, sequenceId: string, contactIds: string[], sequenceVersionId?: string): Promise<Map<string, string[]>> {
  const missing = new Map<string, string[]>();
  const ids = [...new Set(contactIds)];
  if (!ids.length) return missing;
  const { templates, enforced } = await stepTemplates(db, workspaceId, sequenceId, sequenceVersionId);
  if (!enforced || !extractCustomVariables(...templates).length) return missing;
  const campaignValues = await loadLeadVariables(db, workspaceId, sequenceId, ids);
  for (const batch of chunks(ids)) {
    const contacts = await db.select({ id: schema.contacts.id, customFields: schema.contacts.customFields }).from(schema.contacts).where(and(eq(schema.contacts.workspaceId, workspaceId), inArray(schema.contacts.id, batch)));
    for (const contact of contacts) {
      const names = missingCustomVariables(templates, { customFields: contact.customFields, campaignVariables: campaignValues.get(contact.id) ?? null });
      if (names.length) missing.set(contact.id, names);
    }
  }
  return missing;
}

// MERGE semantics: new keys are added/overwritten, untouched keys stay, null/blank
// deletes. Validates every name before writing anything. Contacts outside the
// workspace are ignored; the sequence must belong to the workspace.
export async function upsertLeadVariables(
  tx: WriteDb,
  workspaceId: string,
  sequenceId: string,
  rows: Array<{ contactId: string; variables: Record<string, string | null> }>,
): Promise<{ updated: number; contactIds: string[] }> {
  const merged = new Map<string, { set: Record<string, string>; remove: Set<string> }>();
  for (const row of rows) {
    const { set, remove } = splitVariableUpdates(row.variables);
    const entry = merged.get(row.contactId) ?? { set: {}, remove: new Set<string>() };
    for (const [name, value] of Object.entries(set)) { entry.set[name] = value; entry.remove.delete(name); }
    for (const name of remove) { delete entry.set[name]; entry.remove.add(name); }
    merged.set(row.contactId, entry);
  }
  const [sequence] = await tx.select({ id: schema.sequences.id }).from(schema.sequences).where(and(eq(schema.sequences.id, sequenceId), eq(schema.sequences.workspaceId, workspaceId))).limit(1);
  if (!sequence) throw new LeadVariableError("NOT_FOUND", "Campaign sequence not found in this workspace.");
  const owned = new Set<string>();
  for (const batch of chunks([...merged.keys()])) {
    const found = await tx.select({ id: schema.contacts.id }).from(schema.contacts).where(and(eq(schema.contacts.workspaceId, workspaceId), inArray(schema.contacts.id, batch)));
    for (const contact of found) owned.add(contact.id);
  }
  const valid = [...merged.entries()].filter(([contactId]) => owned.has(contactId));
  const inserts = valid.filter(([, entry]) => Object.keys(entry.set).length).map(([contactId, entry]) => ({ sequenceId, contactId, workspaceId, values: entry.set }));
  for (const batch of chunks(inserts, 1000)) {
    await tx.insert(schema.campaignLeadVariables).values(batch).onConflictDoUpdate({
      target: [schema.campaignLeadVariables.sequenceId, schema.campaignLeadVariables.contactId],
      set: { values: sql`${schema.campaignLeadVariables.values} || excluded."values"`, updatedAt: sql`now()` },
    });
  }
  for (const [contactId, entry] of valid) {
    if (!entry.remove.size) continue;
    await tx.update(schema.campaignLeadVariables)
      .set({ values: jsonbMergeSql(schema.campaignLeadVariables.values, {}, [...entry.remove]), updatedAt: sql`now()` })
      .where(and(eq(schema.campaignLeadVariables.workspaceId, workspaceId), eq(schema.campaignLeadVariables.sequenceId, sequenceId), eq(schema.campaignLeadVariables.contactId, contactId)));
  }
  return { updated: valid.length, contactIds: valid.map(([contactId]) => contactId) };
}

const LIVE_ENROLLMENT_STATUSES = ["scheduled", "active", "paused"] as const;
export const MISSING_VARIABLES_STOP_REASON = "missing_variables";

// Re-renders queued, never-attempted sequence messages of these contacts so a
// late-arriving value lands in mail that was scheduled before it existed, and stops
// mail whose value was cleared: a message of an ENFORCED version that can no longer be
// rendered is cancelled together with its enrollment (stop_reason missing_variables) and
// the lead is staged, so it re-enrolls automatically once the value returns. Old text is
// never sent for a cleared value. Rows are locked FOR UPDATE SKIP LOCKED so a message the
// worker is claiming is left alone; claimed or attempted messages are never touched.
// Versions published before custom variables shipped (not enforced) are left as they were.
export async function syncQueuedMessages(tx: WriteDb, workspaceId: string, sequenceId: string, contactIds: string[]): Promise<{ rerendered: number; cancelled: number; cancelledContactIds: string[] }> {
  const ids = [...new Set(contactIds)];
  const result = { rerendered: 0, cancelled: 0, cancelledContactIds: [] as string[] };
  if (!ids.length) return result;
  const [workspace] = await tx.select({ postalAddress: schema.workspaces.postalAddress }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).limit(1);
  const postalAddress = workspace?.postalAddress?.trim() || null;
  const campaignValues = await loadLeadVariables(tx, workspaceId, sequenceId, ids);
  const now = new Date();
  for (const batch of chunks(ids, 1000)) {
    const contacts = new Map((await tx.select().from(schema.contacts).where(and(eq(schema.contacts.workspaceId, workspaceId), inArray(schema.contacts.id, batch)))).map((contact) => [contact.id, contact]));
    const queued = await tx.select({
      id: schema.messages.id,
      contactId: schema.messages.contactId,
      subject: schema.messages.subject,
      metadata: schema.messages.metadata,
      enrollmentId: schema.enrollments.id,
      campaignId: schema.enrollments.campaignId,
      emailAccountId: schema.enrollments.emailAccountId,
      stepSubject: schema.sequenceSteps.subject,
      stepBody: schema.sequenceSteps.bodyText,
    }).from(schema.messages)
      .innerJoin(schema.enrollments, eq(schema.messages.enrollmentId, schema.enrollments.id))
      .innerJoin(schema.sequenceVersions, eq(schema.enrollments.sequenceVersionId, schema.sequenceVersions.id))
      .innerJoin(schema.sequenceSteps, eq(schema.messages.sequenceStepId, schema.sequenceSteps.id))
      .where(and(
        eq(schema.messages.workspaceId, workspaceId),
        eq(schema.enrollments.workspaceId, workspaceId),
        eq(schema.enrollments.sequenceId, sequenceId),
        eq(schema.sequenceVersions.customVariablesEnforced, true),
        eq(schema.messages.attemptKind, "sequence"),
        inArray(schema.messages.contactId, batch),
        inArray(schema.messages.status, ["scheduled", "retryable"]),
        inArray(schema.enrollments.status, [...LIVE_ENROLLMENT_STATUSES]),
        notExists(tx.select({ one: sql`1` }).from(schema.sendAttempts).where(eq(schema.sendAttempts.messageId, schema.messages.id))),
      ))
      .for("update", { of: schema.messages, skipLocked: true });
    const toCancel: Array<{ id: string; contactId: string; enrollmentId: string; campaignId: string | null; emailAccountId: string | null }> = [];
    for (const message of queued) {
      const contact = contacts.get(message.contactId);
      const unsubscribeUrl = typeof message.metadata.unsubscribeUrl === "string" ? message.metadata.unsubscribeUrl : null;
      if (!contact || !unsubscribeUrl) continue;
      const source = { ...contact, customFields: contact.customFields, campaignVariables: campaignValues.get(contact.id) ?? null };
      const subject = renderTemplate(message.stepSubject, source);
      const body = renderTemplate(message.stepBody, source);
      if (subject.missing.length || body.missing.length) {
        toCancel.push({ id: message.id, contactId: message.contactId, enrollmentId: message.enrollmentId, campaignId: message.campaignId, emailAccountId: message.emailAccountId });
        continue;
      }
      const bodyText = appendUnsubscribeFooter(body.text, unsubscribeUrl, postalAddress);
      if (subject.text === message.subject && bodyText === message.metadata.bodyText) continue;
      await tx.update(schema.messages).set({
        subject: subject.text,
        bodyHash: createHash("sha256").update(bodyText).digest("hex"),
        metadata: { ...message.metadata, bodyText },
        updatedAt: new Date(),
      }).where(and(eq(schema.messages.id, message.id), eq(schema.messages.workspaceId, workspaceId)));
      result.rerendered += 1;
    }
    if (toCancel.length) {
      const campaignIds = [...new Set(toCancel.flatMap((item) => item.campaignId ? [item.campaignId] : []))].sort();
      // Same lock order as the worker's bookkeeping: campaign rows first, then enrollments.
      if (campaignIds.length) await tx.select({ id: schema.campaigns.id }).from(schema.campaigns).where(and(eq(schema.campaigns.workspaceId, workspaceId), inArray(schema.campaigns.id, campaignIds))).orderBy(schema.campaigns.id).for("update");
      // The message's idempotency key is released so the re-enrollment can write its own.
      await tx.update(schema.messages).set({
        status: "cancelled",
        blockedReason: MISSING_VARIABLES_STOP_REASON,
        idempotencyKey: sql`${schema.messages.idempotencyKey} || ':cancelled:' || ${schema.messages.id}::text`,
        claimExpiresAt: null,
        updatedAt: now,
      }).where(and(eq(schema.messages.workspaceId, workspaceId), inArray(schema.messages.id, toCancel.map((item) => item.id))));
      await tx.update(schema.enrollments).set({
        status: "cancelled",
        statusBeforePause: null,
        pausedAt: null,
        nextDueAt: null,
        stoppedAt: now,
        stopReason: MISSING_VARIABLES_STOP_REASON,
        updatedAt: now,
      }).where(and(
        eq(schema.enrollments.workspaceId, workspaceId),
        inArray(schema.enrollments.id, toCancel.map((item) => item.enrollmentId)),
        inArray(schema.enrollments.status, [...LIVE_ENROLLMENT_STATUSES]),
      ));
      const cancelledContactIds = [...new Set(toCancel.map((item) => item.contactId))];
      // A lead live in several sequences only returns to "active" once none of them is live.
      await tx.update(schema.contacts).set({ status: "active", updatedAt: now }).where(and(
        eq(schema.contacts.workspaceId, workspaceId),
        inArray(schema.contacts.id, cancelledContactIds),
        eq(schema.contacts.status, "enrolled"),
        notExists(tx.select({ one: sql`1` }).from(schema.enrollments).where(and(
          eq(schema.enrollments.workspaceId, workspaceId),
          eq(schema.enrollments.contactId, schema.contacts.id),
          inArray(schema.enrollments.status, [...LIVE_ENROLLMENT_STATUSES]),
        ))),
      ));
      for (const item of toCancel) {
        await tx.insert(schema.stagedEnrollments).values({ id: randomUUID(), workspaceId, sequenceId, leadId: item.contactId, campaignId: item.campaignId, inboxIds: item.emailAccountId ? [item.emailAccountId] : null, createdAt: now }).onConflictDoNothing();
      }
      for (const campaignId of campaignIds) await reconcileCampaignStatus(tx, { workspaceId, campaignId, now, notify: false });
      result.cancelled += toCancel.length;
      result.cancelledContactIds.push(...cancelledContactIds);
    }
  }
  return result;
}

// Number of queued messages re-rendered (cancellations for cleared values happen as a
// side effect; see syncQueuedMessages for the counts).
export async function rerenderQueuedMessages(tx: WriteDb, workspaceId: string, sequenceId: string, contactIds: string[]): Promise<number> {
  return (await syncQueuedMessages(tx, workspaceId, sequenceId, contactIds)).rerendered;
}

// Stages the given contacts whose enrollment in this sequence was stopped for a missing value
// (stop_reason missing_variables) and that are not staged yet, so the staged conversion revives
// them once the value is back. Covers leads enrolled directly (no list brings them back) and
// enrollments the worker stopped before it staged them itself.
export async function stageStoppedForMissingVariables(db: WriteDb, workspaceId: string, sequenceId: string, contactIds: string[]): Promise<number> {
  let staged = 0;
  for (const batch of chunks([...new Set(contactIds)], 1000)) {
    const stopped = await db.select({ contactId: schema.enrollments.contactId, campaignId: schema.enrollments.campaignId, emailAccountId: schema.enrollments.emailAccountId, stoppedAt: schema.enrollments.stoppedAt }).from(schema.enrollments).where(and(
      eq(schema.enrollments.workspaceId, workspaceId),
      eq(schema.enrollments.sequenceId, sequenceId),
      inArray(schema.enrollments.contactId, batch),
      eq(schema.enrollments.status, "cancelled"),
      eq(schema.enrollments.stopReason, MISSING_VARIABLES_STOP_REASON),
    )).orderBy(sql`${schema.enrollments.stoppedAt} desc nulls last`);
    const byContact = new Map<string, (typeof stopped)[number]>();
    for (const row of stopped) if (!byContact.has(row.contactId)) byContact.set(row.contactId, row);
    if (!byContact.size) continue;
    const now = new Date();
    const inserted = await db.insert(schema.stagedEnrollments).values([...byContact.values()].map((row) => ({ id: randomUUID(), workspaceId, sequenceId, leadId: row.contactId, campaignId: row.campaignId, inboxIds: row.emailAccountId ? [row.emailAccountId] : null, createdAt: now }))).onConflictDoNothing().returning({ id: schema.stagedEnrollments.id });
    staged += inserted.length;
  }
  return staged;
}

// Enrolls leads that were waiting on variables: leads staged for the sequence (including ones
// whose enrollment was stopped for a missing value) convert, and for every live campaign of the
// sequence, the given contacts that are members of that campaign's lists go through the normal
// enrollSequence path (which skips anyone still missing values).
export async function enrollWaitingLeads(ctx: OperationContext, sequenceId: string, contactIds: string[]): Promise<{ enrolled: number; campaignUpdates: CampaignUpdate[] }> {
  const campaignUpdates: CampaignUpdate[] = [];
  const ids = [...new Set(contactIds)];
  if (!ids.length) return { enrolled: 0, campaignUpdates };
  let queuedEnrolled = 0;
  try {
    await stageStoppedForMissingVariables(ctx.db, ctx.workspaceId, sequenceId, ids);
    // Leads re-queued on an already-published sequence because a variable was missing
    // convert here once their values are complete (those still missing re-queue themselves).
    const queued: string[] = [];
    for (const batch of chunks(ids)) {
      const rows = await ctx.db.select({ leadId: schema.stagedEnrollments.leadId }).from(schema.stagedEnrollments).where(and(
        eq(schema.stagedEnrollments.workspaceId, ctx.workspaceId),
        eq(schema.stagedEnrollments.sequenceId, sequenceId),
        inArray(schema.stagedEnrollments.leadId, batch),
      ));
      queued.push(...rows.map((row) => row.leadId));
    }
    if (queued.length) {
      try {
        queuedEnrolled = (await convertQueuedLeads(ctx, sequenceId, queued))?.enrolled ?? 0;
      } catch (error) {
        try {
          ctx.logger?.warn?.({ error, sequenceId, workspaceId: ctx.workspaceId }, "Conversion of queued leads waiting on variables failed.");
        } catch {}
      }
    }
    const campaigns = await ctx.db.select().from(schema.campaigns).where(and(
      eq(schema.campaigns.workspaceId, ctx.workspaceId),
      eq(schema.campaigns.sequenceId, sequenceId),
      inArray(schema.campaigns.status, ["active", "paused", "completed"]),
    )).orderBy(asc(schema.campaigns.launchedAt), asc(schema.campaigns.id));
    for (const campaign of campaigns) {
      const linked = await ctx.db.select({ listId: schema.campaignContactLists.contactListId }).from(schema.campaignContactLists).where(and(eq(schema.campaignContactLists.workspaceId, ctx.workspaceId), eq(schema.campaignContactLists.campaignId, campaign.id)));
      const listIds = [...new Set([...linked.map((row) => row.listId), ...(campaign.contactListId ? [campaign.contactListId] : [])])];
      if (!listIds.length) continue;
      const members = await ctx.db.selectDistinct({ contactId: schema.contactListMembers.contactId }).from(schema.contactListMembers).where(and(
        eq(schema.contactListMembers.workspaceId, ctx.workspaceId),
        inArray(schema.contactListMembers.contactListId, listIds),
        inArray(schema.contactListMembers.contactId, ids),
      ));
      if (!members.length) continue;
      campaignUpdates.push(await enrollLeadsIntoCampaign(ctx, campaign, members.map((row) => row.contactId), (error, campaignId) => {
        try {
          ctx.logger?.warn?.({ error, campaignId, sequenceId, workspaceId: ctx.workspaceId }, "Enrollment of leads waiting on variables was blocked.");
        } catch {}
      }, { stageWhenPaused: true }));
    }
  } catch (error) {
    try {
      ctx.logger?.warn?.({ error, sequenceId, workspaceId: ctx.workspaceId }, "Enrollment of leads waiting on variables failed.");
    } catch {}
  }
  return { enrolled: queuedEnrolled + campaignUpdates.reduce((total, update) => total + update.enrolled, 0), campaignUpdates };
}

// Resolves exactly one of campaignId / sequenceId to a sequence in the workspace.
export async function resolveVariableSequence(db: ReadDb, workspaceId: string, input: { campaignId?: string; sequenceId?: string }): Promise<string> {
  if (Boolean(input.campaignId) === Boolean(input.sequenceId)) throw new LeadVariableError("BAD_INPUT", "Provide exactly one of campaignId or sequenceId.");
  if (input.campaignId) {
    const [campaign] = await db.select({ sequenceId: schema.campaigns.sequenceId }).from(schema.campaigns).where(and(eq(schema.campaigns.id, input.campaignId), eq(schema.campaigns.workspaceId, workspaceId))).limit(1);
    if (!campaign) throw new LeadVariableError("NOT_FOUND", "Campaign not found.");
    return campaign.sequenceId;
  }
  const [sequence] = await db.select({ id: schema.sequences.id }).from(schema.sequences).where(and(eq(schema.sequences.id, input.sequenceId!), eq(schema.sequences.workspaceId, workspaceId))).limit(1);
  if (!sequence) throw new LeadVariableError("NOT_FOUND", "Sequence not found.");
  return sequence.id;
}

export type SetLeadVariablesResult = {
  sequenceId: string;
  updated: number;
  notFound: string[];
  enrolled: number;
  rerendered: number;
  stillMissing: Array<{ email: string; missing: string[] }>;
};

// The full write path behind campaigns.setLeadVariables: upsert + re-render queued
// mail in one transaction, then enroll leads that were waiting on these values.
export async function applyLeadVariables(
  ctx: OperationContext,
  sequenceId: string,
  rows: Array<{ contactId: string; variables: Record<string, string | null> }>,
): Promise<{ updated: number; contactIds: string[]; rerendered: number; enrolled: number; stillMissing: Array<{ email: string; missing: string[] }> }> {
  const written = await ctx.db.transaction(async (tx) => {
    const result = await upsertLeadVariables(tx, ctx.workspaceId, sequenceId, rows);
    const rerendered = await rerenderQueuedMessages(tx, ctx.workspaceId, sequenceId, result.contactIds);
    return { ...result, rerendered };
  });
  const waiting = await enrollWaitingLeads(ctx, sequenceId, written.contactIds);
  const missing = await findLeadsMissingVariables(ctx.db, ctx.workspaceId, sequenceId, written.contactIds);
  const stillMissing: Array<{ email: string; missing: string[] }> = [];
  if (missing.size) {
    for (const batch of chunks([...missing.keys()])) {
      const contacts = await ctx.db.select({ id: schema.contacts.id, email: schema.contacts.email }).from(schema.contacts).where(and(eq(schema.contacts.workspaceId, ctx.workspaceId), inArray(schema.contacts.id, batch)));
      for (const contact of contacts) stillMissing.push({ email: contact.email, missing: missing.get(contact.id) ?? [] });
    }
  }
  return { updated: written.updated, contactIds: written.contactIds, rerendered: written.rerendered, enrolled: waiting.enrolled, stillMissing };
}

// After lead-level custom fields change (no campaign named): every sequence these contacts
// are part of may now have complete values. Sequences considered are the ones the contacts
// have live mail in (queued unattempted messages are re-rendered), the ones with a live
// campaign whose lists contain them, the ones holding them in the staged queue and the ones
// that stopped them for a missing value (they are enrolled or revived once complete).
export async function refreshLeadsAfterFieldChange(ctx: OperationContext, contactIds: string[]): Promise<{ enrolled: number; rerendered: number; sequenceIds: string[] }> {
  const ids = [...new Set(contactIds)];
  if (!ids.length) return { enrolled: 0, rerendered: 0, sequenceIds: [] };
  const withMail = new Set<string>();
  const toWake = new Set<string>();
  for (const batch of chunks(ids)) {
    const live = await ctx.db.selectDistinct({ sequenceId: schema.enrollments.sequenceId }).from(schema.enrollments).where(and(
      eq(schema.enrollments.workspaceId, ctx.workspaceId),
      inArray(schema.enrollments.contactId, batch),
      inArray(schema.enrollments.status, ["scheduled", "active", "paused"]),
    ));
    for (const row of live) withMail.add(row.sequenceId);
    const staged = await ctx.db.selectDistinct({ sequenceId: schema.stagedEnrollments.sequenceId }).from(schema.stagedEnrollments).where(and(eq(schema.stagedEnrollments.workspaceId, ctx.workspaceId), inArray(schema.stagedEnrollments.leadId, batch)));
    for (const row of staged) toWake.add(row.sequenceId);
    const stopped = await ctx.db.selectDistinct({ sequenceId: schema.enrollments.sequenceId }).from(schema.enrollments).where(and(
      eq(schema.enrollments.workspaceId, ctx.workspaceId),
      inArray(schema.enrollments.contactId, batch),
      eq(schema.enrollments.status, "cancelled"),
      eq(schema.enrollments.stopReason, MISSING_VARIABLES_STOP_REASON),
    ));
    for (const row of stopped) toWake.add(row.sequenceId);
    const memberships = await ctx.db.selectDistinct({ listId: schema.contactListMembers.contactListId }).from(schema.contactListMembers).where(and(eq(schema.contactListMembers.workspaceId, ctx.workspaceId), inArray(schema.contactListMembers.contactId, batch)));
    const listIds = memberships.map((row) => row.listId);
    if (!listIds.length) continue;
    const direct = await ctx.db.selectDistinct({ sequenceId: schema.campaigns.sequenceId }).from(schema.campaigns).where(and(
      eq(schema.campaigns.workspaceId, ctx.workspaceId),
      inArray(schema.campaigns.status, ["active", "paused", "completed"]),
      inArray(schema.campaigns.contactListId, listIds),
    ));
    for (const row of direct) toWake.add(row.sequenceId);
    const linked = await ctx.db.selectDistinct({ sequenceId: schema.campaigns.sequenceId }).from(schema.campaignContactLists)
      .innerJoin(schema.campaigns, eq(schema.campaignContactLists.campaignId, schema.campaigns.id))
      .where(and(
        eq(schema.campaignContactLists.workspaceId, ctx.workspaceId),
        eq(schema.campaigns.workspaceId, ctx.workspaceId),
        inArray(schema.campaigns.status, ["active", "paused", "completed"]),
        inArray(schema.campaignContactLists.contactListId, listIds),
      ));
    for (const row of linked) toWake.add(row.sequenceId);
  }
  let rerendered = 0;
  for (const sequenceId of withMail) rerendered += await ctx.db.transaction((tx) => rerenderQueuedMessages(tx, ctx.workspaceId, sequenceId, ids));
  let enrolled = 0;
  for (const sequenceId of toWake) enrolled += (await enrollWaitingLeads(ctx, sequenceId, ids)).enrolled;
  return { enrolled, rerendered, sequenceIds: [...new Set([...withMail, ...toWake])].sort() };
}
