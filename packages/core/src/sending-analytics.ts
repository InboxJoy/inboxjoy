import { schema } from "@inboxjoy/db";
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { findEligibleEnrollmentAudience } from "./enrollment-eligibility.js";
import { assertLaunchAudienceComplete, EMPTY_MISSING_VARIABLES, summarizeMissingVariables } from "./launch-gate.js";
import { campaignDisplayStatuses, reconcileCampaignStatus, type CampaignDisplayStatus, type CampaignStatusReason } from "./campaign-status.js";
import { refreshPendingOnResume } from "./resume-pending.js";
import { z } from "zod";

import { convertQueuedLeads, type Operation, type OperationContext } from "./index.js";

type RunNamed = (name: string, ctx: OperationContext, input: unknown) => Promise<any>;
type OpErrorConstructor = new (code: "BAD_INPUT" | "NOT_FOUND" | "CONFLICT" | "UNAVAILABLE" | "FORBIDDEN", message: string, details?: unknown) => Error;
type EnrollmentStatus = (typeof schema.enrollments.$inferSelect)["status"];
type Campaign = typeof schema.campaigns.$inferSelect;

const anyOutput = z.any();
const id = z.string().uuid();
const listIds = z.preprocess((value) => Array.isArray(value) ? [...new Set(value)] : value, z.array(id).max(20));
const percent = (value: number, total: number) => total ? Number(((value / total) * 100).toFixed(1)) : 0;
const softBounceEventTypes = ["soft_bounce", "mailbox_full", "rate_limit", "temporary_provider_error", "auth_failure"];

export type DailyMetric = { date: string; sent: number; replied: number; opened: number; humanOpened: number; bounced: number };

export function dailySeries(range: 7 | 30 | 90, now = new Date()): DailyMetric[] {
  const end = new Date(now);
  end.setUTCHours(0, 0, 0, 0);
  return Array.from({ length: range }, (_, index) => {
    const date = new Date(end.getTime() - (range - index - 1) * 86_400_000).toISOString().slice(0, 10);
    return { date, sent: 0, replied: 0, opened: 0, humanOpened: 0, bounced: 0 };
  });
}

export function csvCell(value: unknown): string {
  const rawText = value == null ? "" : String(value);
  const text = /^[=+\-@\t\r]/.test(rawText) ? `'${rawText}` : rawText;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

// Built-ins stay code-defined until workspace-editable template management is introduced.
export const builtInTemplates = [
  { key: "cold-opener", name: "Cold opener", description: "A concise five-touch outbound sequence.", steps: [
    { delayDays: 0, subject: "Quick question, {{firstName}}", body: "Hi {{firstName}},\n\nI noticed {{company}} and thought this might be relevant." },
    { delayDays: 2, subject: "Re: Quick question", body: "Hi {{firstName}},\n\nWorth a quick conversation?" },
    { delayDays: 3, subject: "A useful example", body: "Hi {{firstName}},\n\nI can share a short example from a similar team." },
    { delayDays: 4, subject: "Should I close this out?", body: "Hi {{firstName}},\n\nShould I close the loop for now?" },
    { delayDays: 7, subject: "Last note", body: "Hi {{firstName}},\n\nLast note from me. Happy to reconnect when timing is better." },
  ] },
  { key: "reactivation", name: "Reactivation", description: "Reconnect with previously engaged leads.", steps: [
    { delayDays: 0, subject: "Still a priority at {{company}}?", body: "Hi {{firstName}},\n\nIs this still something your team is considering?" },
    { delayDays: 3, subject: "What changed", body: "Hi {{firstName}},\n\nA lot has changed since we last spoke. Want the short version?" },
    { delayDays: 7, subject: "Keep the door open", body: "Hi {{firstName}},\n\nI’ll leave this here and keep the door open." },
  ] },
  { key: "event-follow-up", name: "Event follow-up", description: "Follow up after a conference or webinar.", steps: [
    { delayDays: 0, subject: "Great meeting you, {{firstName}}", body: "Hi {{firstName}},\n\nGreat meeting you at the event." },
    { delayDays: 1, subject: "The resource I mentioned", body: "Hi {{firstName}},\n\nHere is the resource I mentioned." },
    { delayDays: 3, subject: "Your take?", body: "Hi {{firstName}},\n\nCurious what stood out to you." },
    { delayDays: 7, subject: "Continue the conversation", body: "Hi {{firstName}},\n\nWould a short follow-up conversation be useful?" },
  ] },
] as const;

async function campaignFor(ctx: OperationContext, campaignId: string, OpError: OpErrorConstructor) {
  const [campaign] = await ctx.db.select().from(schema.campaigns).where(and(eq(schema.campaigns.id, campaignId), eq(schema.campaigns.workspaceId, ctx.workspaceId)));
  if (!campaign) throw new OpError("NOT_FOUND", "Campaign not found.");
  return campaign;
}

function requestedCampaignListIds(input: { listIds?: string[]; listId?: string | null }, OpError: OpErrorConstructor): string[] | undefined {
  if (input.listIds !== undefined && input.listId !== undefined) throw new OpError("BAD_INPUT", "Provide either listIds or the legacy listId, not both.");
  if (input.listIds !== undefined) return input.listIds;
  if (input.listId !== undefined) return input.listId ? [input.listId] : [];
  return undefined;
}

async function validateCampaignListIds(ctx: OperationContext, selectedListIds: string[], OpError: OpErrorConstructor) {
  if (!selectedListIds.length) return;
  const lists = await ctx.db.select({ id: schema.contactLists.id }).from(schema.contactLists).where(and(
    eq(schema.contactLists.workspaceId, ctx.workspaceId),
    inArray(schema.contactLists.id, selectedListIds),
  ));
  if (lists.length !== selectedListIds.length) throw new OpError("NOT_FOUND", "One or more contact lists were not found in this workspace.");
}

async function campaignAudienceMap(ctx: OperationContext, campaigns: Array<Pick<Campaign, "id" | "contactListId">>) {
  const audiences = new Map<string, string[]>();
  if (!campaigns.length) return audiences;
  const rows = await ctx.db.select({ campaignId: schema.campaignContactLists.campaignId, contactListId: schema.campaignContactLists.contactListId })
    .from(schema.campaignContactLists)
    .where(and(eq(schema.campaignContactLists.workspaceId, ctx.workspaceId), inArray(schema.campaignContactLists.campaignId, campaigns.map((campaign) => campaign.id))))
    .orderBy(schema.campaignContactLists.createdAt, schema.campaignContactLists.contactListId);
  for (const row of rows) audiences.set(row.campaignId, [...(audiences.get(row.campaignId) ?? []), row.contactListId]);
  const legacyListIds = [...new Set(campaigns.flatMap((campaign) => campaign.contactListId ? [campaign.contactListId] : []))];
  const legacyLists = legacyListIds.length ? await ctx.db.select({ id: schema.contactLists.id }).from(schema.contactLists).where(and(eq(schema.contactLists.workspaceId, ctx.workspaceId), inArray(schema.contactLists.id, legacyListIds))) : [];
  const validLegacyListIds = new Set(legacyLists.map((list) => list.id));
  for (const campaign of campaigns) {
    if (campaign.contactListId && validLegacyListIds.has(campaign.contactListId)) {
      const selected = audiences.get(campaign.id) ?? [];
      audiences.set(campaign.id, [campaign.contactListId, ...selected.filter((listId) => listId !== campaign.contactListId)]);
    }
  }
  return audiences;
}

async function campaignWithAudience<T extends Campaign>(ctx: OperationContext, campaign: T, audiences: Map<string, string[]>, statuses?: Map<string, { displayStatus: CampaignDisplayStatus; statusReason: CampaignStatusReason }>) {
  const selected = audiences.get(campaign.id) ?? [];
  const first = campaign.contactListId && selected.includes(campaign.contactListId) ? campaign.contactListId : (selected[0] ?? null);
  const ordered = first ? [first, ...selected.filter((listId) => listId !== first)] : selected;
  const display = (statuses ?? await campaignDisplayStatuses(ctx.db, ctx.workspaceId, [campaign], ctx.env.edition)).get(campaign.id)!;
  return { ...campaign, ...display, completedAt: campaign.completedAt?.toISOString() ?? null, listIds: ordered, listId: first };
}

async function campaignListMetrics(ctx: OperationContext) {
  const enrolled = await ctx.db.select({
    campaignId: schema.enrollments.campaignId,
    enrolled: sql<number>`count(*)`.mapWith(Number),
    replied: sql<number>`count(*) filter (where ${schema.enrollments.status} = 'replied')`.mapWith(Number),
  }).from(schema.enrollments).where(and(eq(schema.enrollments.workspaceId, ctx.workspaceId), isNotNull(schema.enrollments.campaignId))).groupBy(schema.enrollments.campaignId);
  const sent = await ctx.db.select({
    campaignId: schema.enrollments.campaignId,
    sent: sql<number>`count(*) filter (where ${schema.messages.status} = 'accepted')`.mapWith(Number),
  }).from(schema.messages).innerJoin(schema.enrollments, eq(schema.messages.enrollmentId, schema.enrollments.id))
    .where(and(eq(schema.messages.workspaceId, ctx.workspaceId), eq(schema.enrollments.workspaceId, ctx.workspaceId), isNotNull(schema.enrollments.campaignId))).groupBy(schema.enrollments.campaignId);
  const opened = await ctx.db.select({
    campaignId: schema.enrollments.campaignId,
    opened: sql<number>`count(distinct ${schema.messageEvents.messageId})`.mapWith(Number),
  }).from(schema.messageEvents).innerJoin(schema.messages, eq(schema.messageEvents.messageId, schema.messages.id)).innerJoin(schema.enrollments, eq(schema.messages.enrollmentId, schema.enrollments.id))
    .where(and(eq(schema.messageEvents.workspaceId, ctx.workspaceId), eq(schema.messages.workspaceId, ctx.workspaceId), eq(schema.enrollments.workspaceId, ctx.workspaceId), eq(schema.messageEvents.eventType, "opened"), isNotNull(schema.enrollments.campaignId))).groupBy(schema.enrollments.campaignId);
  const enrollmentCounts = new Map(enrolled.map((row) => [row.campaignId, row]));
  const sentCounts = new Map(sent.map((row) => [row.campaignId, row.sent]));
  const openedCounts = new Map(opened.map((row) => [row.campaignId, row.opened]));
  return (campaignId: string) => {
    const enrolled = enrollmentCounts.get(campaignId)?.enrolled ?? 0;
    const replied = enrollmentCounts.get(campaignId)?.replied ?? 0;
    const sent = sentCounts.get(campaignId) ?? 0;
    const opened = openedCounts.get(campaignId) ?? 0;
    return { enrolled, sent, replied, opened, replyRate: percent(replied, sent), openRate: percent(opened, sent) };
  };
}

async function campaignMetrics(ctx: OperationContext, campaignId: string) {
  const enrollmentRows = await ctx.db.select({ id: schema.enrollments.id, status: schema.enrollments.status }).from(schema.enrollments)
    .where(and(eq(schema.enrollments.workspaceId, ctx.workspaceId), eq(schema.enrollments.campaignId, campaignId)));
  const enrollmentIds = enrollmentRows.map((row) => row.id);
  const messageRows = enrollmentIds.length ? await ctx.db.select({ id: schema.messages.id, enrollmentId: schema.messages.enrollmentId, stepId: schema.messages.sequenceStepId, status: schema.messages.status, acceptedAt: schema.messages.acceptedAt }).from(schema.messages)
    .where(and(eq(schema.messages.workspaceId, ctx.workspaceId), inArray(schema.messages.enrollmentId, enrollmentIds))) : [];
  const messageIds = messageRows.map((row) => row.id);
  const openedRows = messageIds.length ? await ctx.db.select({ messageId: schema.messageEvents.messageId }).from(schema.messageEvents)
    .where(and(eq(schema.messageEvents.workspaceId, ctx.workspaceId), eq(schema.messageEvents.eventType, "opened"), inArray(schema.messageEvents.messageId, messageIds))) : [];
  const openedIds = new Set(openedRows.flatMap((row) => row.messageId ? [row.messageId] : []));
  const sent = messageRows.filter((row) => row.status === "accepted").length;
  const replied = enrollmentRows.filter((row) => row.status === "replied").length;
  return { enrolled: enrollmentRows.length, sent, replied, opened: openedIds.size, replyRate: percent(replied, sent), openRate: percent(openedIds.size, sent), enrollmentRows, messageRows, openedIds };
}

async function pauseCampaign(ctx: OperationContext, campaign: Campaign, OpError: OpErrorConstructor) {
  if (campaign.status === "archived") throw new OpError("CONFLICT", "Archived campaigns cannot be paused.");
  if (campaign.status !== "active") throw new OpError("CONFLICT", "Only active campaigns can be paused.");
  const now = new Date();
  await ctx.db.transaction(async (tx) => {
    const [locked] = await tx.select({ status: schema.campaigns.status }).from(schema.campaigns).where(and(
      eq(schema.campaigns.id, campaign.id),
      eq(schema.campaigns.workspaceId, ctx.workspaceId),
    )).for("update");
    if (!locked || locked.status !== "active") throw new OpError("CONFLICT", "Only active campaigns can be paused.");
    const pausedRows = await tx.update(schema.campaigns).set({ status: "paused", updatedAt: now }).where(and(
      eq(schema.campaigns.id, campaign.id),
      eq(schema.campaigns.workspaceId, ctx.workspaceId),
      eq(schema.campaigns.status, "active"),
    )).returning({ id: schema.campaigns.id });
    if (!pausedRows.length) return;
    await tx.update(schema.enrollments).set({ status: "paused", statusBeforePause: sql`${schema.enrollments.status}`, pausedAt: now, updatedAt: now }).where(and(
      eq(schema.enrollments.workspaceId, ctx.workspaceId),
      eq(schema.enrollments.campaignId, campaign.id),
      inArray(schema.enrollments.status, ["scheduled", "active"]),
    ));
  });
  return { ...campaign, status: "paused" as const, updatedAt: now };
}

async function resumeCampaign(ctx: OperationContext, campaign: Campaign, OpError: OpErrorConstructor) {
  if (campaign.status === "archived") throw new OpError("CONFLICT", "Archived campaigns cannot be resumed.");
  if (campaign.status !== "paused") throw new OpError("CONFLICT", "Only paused campaigns can be resumed.");
  const now = new Date();
  let reconciledStatus: Campaign["status"] = "active";
  await ctx.db.transaction(async (tx) => {
    const [locked] = await tx.select({ status: schema.campaigns.status }).from(schema.campaigns).where(and(
      eq(schema.campaigns.id, campaign.id),
      eq(schema.campaigns.workspaceId, ctx.workspaceId),
    )).for("update");
    if (!locked || locked.status !== "paused") throw new OpError("CONFLICT", "Only paused campaigns can be resumed.");
    const pausedEnrollments = await tx.select({ id: schema.enrollments.id }).from(schema.enrollments).where(and(
      eq(schema.enrollments.workspaceId, ctx.workspaceId),
      eq(schema.enrollments.campaignId, campaign.id),
      eq(schema.enrollments.status, "paused"),
      isNull(schema.enrollments.stopReason),
    ));
    await refreshPendingOnResume(tx, { workspaceId: ctx.workspaceId, sequenceId: campaign.sequenceId, enrollmentIds: pausedEnrollments.map((enrollment) => enrollment.id), now });
    if (pausedEnrollments.length) await tx.update(schema.enrollments).set({ status: sql`COALESCE(${schema.enrollments.statusBeforePause}, 'active'::enrollment_status)`, statusBeforePause: null, pausedAt: null, updatedAt: now }).where(and(
      eq(schema.enrollments.workspaceId, ctx.workspaceId),
      inArray(schema.enrollments.id, pausedEnrollments.map((enrollment) => enrollment.id)),
      eq(schema.enrollments.status, "paused"),
      isNull(schema.enrollments.stopReason),
    ));
    await tx.update(schema.campaigns).set({ status: "active", updatedAt: now }).where(and(
      eq(schema.campaigns.id, campaign.id),
      eq(schema.campaigns.workspaceId, ctx.workspaceId),
      eq(schema.campaigns.status, "paused"),
    ));
    reconciledStatus = (await reconcileCampaignStatus(tx, { workspaceId: ctx.workspaceId, campaignId: campaign.id, now }))?.status as Campaign["status"] ?? "active";
  });
  // Leads parked while the campaign was paused (values written meanwhile, or never enrolled) enroll
  // now if they are complete; the ones still missing values go back in the queue.
  try {
    const parked = await ctx.db.select({ leadId: schema.stagedEnrollments.leadId }).from(schema.stagedEnrollments).where(and(eq(schema.stagedEnrollments.workspaceId, ctx.workspaceId), eq(schema.stagedEnrollments.campaignId, campaign.id)));
    if (parked.length) await convertQueuedLeads(ctx, campaign.sequenceId, parked.map((row) => row.leadId));
  } catch (error) {
    try { ctx.logger?.warn?.({ error, campaignId: campaign.id, workspaceId: ctx.workspaceId }, "Enrolling leads parked while the campaign was paused failed."); } catch {}
  }
  const [persisted] = await ctx.db.select().from(schema.campaigns).where(and(eq(schema.campaigns.workspaceId, ctx.workspaceId), eq(schema.campaigns.id, campaign.id)));
  return persisted ?? { ...campaign, status: reconciledStatus, updatedAt: now };
}
async function archiveCampaign(ctx: OperationContext, campaign: Campaign, OpError: OpErrorConstructor) {
  if (campaign.status === "archived") throw new OpError("CONFLICT", "Campaign is already archived.");
  const now = new Date();
  await ctx.db.transaction(async (tx) => {
    const [archived] = await tx.update(schema.campaigns).set({ status: "archived", updatedAt: now }).where(and(
      eq(schema.campaigns.id, campaign.id),
      eq(schema.campaigns.workspaceId, ctx.workspaceId),
      sql`${schema.campaigns.status} <> 'archived'`,
    )).returning({ id: schema.campaigns.id });
    if (!archived) throw new OpError("CONFLICT", "Campaign is already archived.");
    await tx.update(schema.messages).set({ status: "cancelled", blockedReason: "campaign_archived", updatedAt: now }).where(and(
      eq(schema.messages.workspaceId, ctx.workspaceId),
      inArray(schema.messages.status, ["scheduled", "retryable"]),
      inArray(schema.messages.enrollmentId, tx.select({ id: schema.enrollments.id }).from(schema.enrollments).where(and(
        eq(schema.enrollments.workspaceId, ctx.workspaceId),
        eq(schema.enrollments.campaignId, campaign.id),
      ))),
    ));
    await tx.update(schema.enrollments).set({ status: "cancelled", statusBeforePause: null, pausedAt: null, stoppedAt: now, stopReason: "campaign_archived", updatedAt: now }).where(and(
      eq(schema.enrollments.workspaceId, ctx.workspaceId),
      eq(schema.enrollments.campaignId, campaign.id),
      inArray(schema.enrollments.status, ["scheduled", "active", "paused"]),
    ));
  });
  return { ...campaign, status: "archived" as const, updatedAt: now };
}

export async function pagedEnrollments(
  ctx: OperationContext,
  sequenceId: string,
  input: { status?: EnrollmentStatus; page: number; pageSize: number },
  OpError: OpErrorConstructor,
) {
  const [sequence] = await ctx.db.select({ id: schema.sequences.id }).from(schema.sequences).where(and(eq(schema.sequences.id, sequenceId), eq(schema.sequences.workspaceId, ctx.workspaceId)));
  if (!sequence) throw new OpError("NOT_FOUND", "Sequence not found.");
  const offset = (input.page - 1) * input.pageSize;
  const enrollmentFilter = and(
    eq(schema.enrollments.sequenceId, sequenceId),
    eq(schema.enrollments.workspaceId, ctx.workspaceId),
    input.status ? eq(schema.enrollments.status, input.status) : undefined,
  );
  const [countRow] = await ctx.db.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(schema.enrollments).where(enrollmentFilter);
  const rows = await ctx.db.select({ id: schema.enrollments.id, status: schema.enrollments.status, nextStepOrder: schema.enrollments.nextStepOrder, createdAt: schema.enrollments.createdAt, contactId: schema.contacts.id, email: schema.contacts.email, firstName: schema.contacts.firstName, lastName: schema.contacts.lastName, company: schema.contacts.company }).from(schema.enrollments)
    .innerJoin(schema.contacts, eq(schema.enrollments.contactId, schema.contacts.id)).where(enrollmentFilter).orderBy(desc(schema.enrollments.createdAt)).limit(input.pageSize).offset(offset);
  const enrollmentIds = rows.map((row) => row.id);
  const events = enrollmentIds.length ? await ctx.db.select({ enrollmentId: schema.messages.enrollmentId, eventType: schema.messageEvents.eventType, occurredAt: schema.messageEvents.occurredAt }).from(schema.messageEvents).innerJoin(schema.messages, eq(schema.messageEvents.messageId, schema.messages.id)).where(and(eq(schema.messageEvents.workspaceId, ctx.workspaceId), eq(schema.messages.workspaceId, ctx.workspaceId), inArray(schema.messages.enrollmentId, enrollmentIds))).orderBy(desc(schema.messageEvents.occurredAt)) : [];
  const latest = new Map<string, { type: string; occurredAt: string }>();
  for (const event of events) if (!latest.has(event.enrollmentId)) latest.set(event.enrollmentId, { type: event.eventType, occurredAt: event.occurredAt.toISOString() });
  return { enrollments: rows.map((row) => ({ id: row.id, contact: { id: row.contactId, email: row.email, firstName: row.firstName ?? "", lastName: row.lastName ?? "", company: row.company ?? "" }, status: row.status, nextStepOrder: row.nextStepOrder, lastEvent: latest.get(row.id) ?? null, createdAt: row.createdAt.toISOString() })), pagination: { page: input.page, pageSize: input.pageSize, total: countRow?.count ?? 0 } };
}

export function createSendingAnalyticsOperations(runNamed: RunNamed, OpError: OpErrorConstructor, requireWorkspaceManager: (ctx: OperationContext) => Promise<void>, requireVerifiedWorkspaceOwner: (ctx: OperationContext) => Promise<void>): Array<Operation<any, any>> {
  return [
    {
      name: "campaigns.list", description: "List campaigns with enrollment, send, open, and reply performance.", access: "read", inputSchema: z.object({}), outputSchema: anyOutput,
      handler: async (ctx) => {
        const campaigns = await ctx.db.select().from(schema.campaigns).where(eq(schema.campaigns.workspaceId, ctx.workspaceId)).orderBy(desc(schema.campaigns.createdAt));
        const audiences = await campaignAudienceMap(ctx, campaigns);
        const metricsFor = await campaignListMetrics(ctx);
        const statuses = await campaignDisplayStatuses(ctx.db, ctx.workspaceId, campaigns, ctx.env.edition);
        return { campaigns: await Promise.all(campaigns.map(async (campaign) => ({ ...await campaignWithAudience(ctx, campaign, audiences, statuses), ...metricsFor(campaign.id), launchedAt: campaign.launchedAt?.toISOString() ?? null, createdAt: campaign.createdAt.toISOString(), updatedAt: campaign.updatedAt.toISOString() }))) };
      },
    },
    {
      name: "campaigns.create", description: "Create a draft campaign for a sequence, up to 20 contact lists, and a sending inbox. Use listIds for multiple lists or legacy listId for one list; omit both for all ready leads.", access: "write", inputSchema: z.object({ name: z.string().trim().min(1).max(180), sequenceId: id, listIds: listIds.optional(), listId: id.nullable().optional(), inboxId: id }), outputSchema: anyOutput,
      handler: async (ctx, input) => {
        const selectedListIds = requestedCampaignListIds(input, OpError) ?? [];
        const [sequence] = await ctx.db.select({ id: schema.sequences.id, status: schema.sequences.status }).from(schema.sequences).where(and(eq(schema.sequences.id, input.sequenceId), eq(schema.sequences.workspaceId, ctx.workspaceId)));
        if (!sequence) throw new OpError("NOT_FOUND", "Sequence not found.");
        if (sequence.status === "archived") throw new OpError("CONFLICT", "Archived sequences cannot be used for campaigns.");
        const [inbox] = await ctx.db.select({ id: schema.emailAccounts.id }).from(schema.emailAccounts).where(and(eq(schema.emailAccounts.id, input.inboxId), eq(schema.emailAccounts.workspaceId, ctx.workspaceId)));
        if (!inbox) throw new OpError("NOT_FOUND", "Inbox not found.");
        await validateCampaignListIds(ctx, selectedListIds, OpError);
        const campaign = await ctx.db.transaction(async (tx) => {
          const [created] = await tx.insert(schema.campaigns).values({ id: randomUUID(), workspaceId: ctx.workspaceId, sequenceId: input.sequenceId, contactListId: selectedListIds[0] ?? null, emailAccountId: input.inboxId, name: input.name, createdByUserId: ctx.userId }).returning();
          if (selectedListIds.length) await tx.insert(schema.campaignContactLists).values(selectedListIds.map((contactListId) => ({ campaignId: created!.id, contactListId, workspaceId: ctx.workspaceId })));
          return created!;
        });
        return { campaign: await campaignWithAudience(ctx, campaign, new Map([[campaign.id, selectedListIds]])) };
      },
    },
    {
      name: "campaigns.audiencePreview", description: "Preview the distinct eligible audience for a campaign sequence and selected contact lists.", access: "read", inputSchema: z.object({ campaignId: id.optional(), sequenceId: id.optional(), listIds: listIds.optional(), listId: id.nullable().optional() }), outputSchema: anyOutput,
      handler: async (ctx, input) => {
        const selectedListIds = requestedCampaignListIds(input, OpError) ?? [];
        await validateCampaignListIds(ctx, selectedListIds, OpError);
        const campaign = input.campaignId ? await campaignFor(ctx, input.campaignId, OpError) : undefined;
        if (campaign && input.sequenceId && campaign.sequenceId !== input.sequenceId) throw new OpError("BAD_INPUT", "Campaign does not belong to this sequence.");
        const sequenceId = input.sequenceId ?? campaign?.sequenceId;
        const [sequence] = sequenceId ? await ctx.db.select({ id: schema.sequences.id, currentVersionId: schema.sequences.currentVersionId }).from(schema.sequences).where(and(eq(schema.sequences.id, sequenceId), eq(schema.sequences.workspaceId, ctx.workspaceId))) : [];
        if (input.sequenceId && !sequence) throw new OpError("NOT_FOUND", "Sequence not found.");
        const leadIds = selectedListIds.length ? undefined : (await ctx.db.select({ id: schema.contacts.id }).from(schema.contacts).where(and(eq(schema.contacts.workspaceId, ctx.workspaceId), inArray(schema.contacts.status, ["active", "enrolled"])))).map((contact) => contact.id);
        const audience = await findEligibleEnrollmentAudience({ db: ctx.db, workspaceId: ctx.workspaceId, campaignId: campaign?.id, sequenceId: sequence?.id, sequenceVersionId: sequence?.currentVersionId ?? null, listIds: selectedListIds.length ? selectedListIds : undefined, leadIds });
        // Read-only: leads (eligible or parked for incomplete variables) missing a custom variable the steps use.
        const parkedLeadIds = (audience.skippedLeadIds as unknown as Partial<Record<string, string[]>>).missing_variables ?? [];
        const missingVariables = sequence ? await summarizeMissingVariables(ctx.db, ctx.workspaceId, sequence.id, [...audience.eligible.map((lead) => lead.id), ...parkedLeadIds], sequence.currentVersionId) : EMPTY_MISSING_VARIABLES;
        return { eligible: audience.eligible.length, total: audience.candidates, skipped: audience.skipped, missingVariables: { total: missingVariables.total, byVariable: missingVariables.byVariable, sampleEmails: missingVariables.sampleEmails } };
      },
    },
    {
      name: "campaigns.update", description: "Update a draft campaign. Use listIds to replace its full set of up to 20 contact lists, legacy listId for one list, or an empty list or null listId for all ready leads.", access: "write", inputSchema: z.object({ id, name: z.string().trim().min(1).max(180).optional(), sequenceId: id.optional(), listIds: listIds.optional(), listId: id.nullable().optional(), inboxId: id.optional() }), outputSchema: anyOutput,
      handler: async (ctx, input) => {
        await requireWorkspaceManager(ctx);
        const campaign = await campaignFor(ctx, input.id, OpError);
        if (campaign.status !== "draft") throw new OpError("CONFLICT", "Only draft campaigns can be updated.");
        const selectedListIds = requestedCampaignListIds(input, OpError);
        if (input.sequenceId) {
          const [sequence] = await ctx.db.select({ id: schema.sequences.id, status: schema.sequences.status }).from(schema.sequences).where(and(eq(schema.sequences.id, input.sequenceId), eq(schema.sequences.workspaceId, ctx.workspaceId)));
          if (!sequence) throw new OpError("NOT_FOUND", "Sequence not found.");
          if (sequence.status === "archived") throw new OpError("CONFLICT", "Archived sequences cannot be used for campaigns.");
          // lists.delete releases the last list of a campaign on an archived sequence,
          // so moving such a campaign to a live sequence takes an explicit audience.
          if (input.sequenceId !== campaign.sequenceId && selectedListIds === undefined && !(await campaignAudienceMap(ctx, [campaign])).get(campaign.id)?.length) {
            const [currentSequence] = await ctx.db.select({ status: schema.sequences.status }).from(schema.sequences).where(and(eq(schema.sequences.id, campaign.sequenceId), eq(schema.sequences.workspaceId, ctx.workspaceId)));
            if (currentSequence?.status === "archived") throw new OpError("CONFLICT", "Choose this campaign's contact lists when moving it to a new sequence. Send listIds, or an empty listIds for all ready leads.");
          }
        }
        if (input.inboxId) {
          const [inbox] = await ctx.db.select({ id: schema.emailAccounts.id }).from(schema.emailAccounts).where(and(eq(schema.emailAccounts.id, input.inboxId), eq(schema.emailAccounts.workspaceId, ctx.workspaceId)));
          if (!inbox) throw new OpError("NOT_FOUND", "Inbox not found.");
        }
        if (selectedListIds) await validateCampaignListIds(ctx, selectedListIds, OpError);
        const updated = await ctx.db.transaction(async (tx) => {
          const [row] = await tx.update(schema.campaigns).set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.sequenceId !== undefined ? { sequenceId: input.sequenceId } : {}),
            ...(selectedListIds !== undefined ? { contactListId: selectedListIds[0] ?? null } : {}),
            ...(input.inboxId !== undefined ? { emailAccountId: input.inboxId } : {}),
            updatedAt: new Date(),
          }).where(and(eq(schema.campaigns.id, campaign.id), eq(schema.campaigns.workspaceId, ctx.workspaceId), eq(schema.campaigns.status, "draft"))).returning();
          if (!row) throw new OpError("CONFLICT", "Only draft campaigns can be updated.");
          if (selectedListIds !== undefined) {
            await tx.delete(schema.campaignContactLists).where(and(eq(schema.campaignContactLists.campaignId, campaign.id), eq(schema.campaignContactLists.workspaceId, ctx.workspaceId)));
            if (selectedListIds.length) await tx.insert(schema.campaignContactLists).values(selectedListIds.map((contactListId) => ({ campaignId: campaign.id, contactListId, workspaceId: ctx.workspaceId })));
          }
          return row;
        });
        const audiences = selectedListIds === undefined ? await campaignAudienceMap(ctx, [updated]) : new Map([[updated.id, selectedListIds]]);
        return { campaign: await campaignWithAudience(ctx, updated, audiences) };
      },
    },
    {
      name: "campaigns.launch", description: "Publish the campaign sequence and start sends for eligible leads never previously enrolled in this campaign. New members added to its lists while active or finished are automatically enrolled and can start sends.", access: "write", inputSchema: z.object({ id }), outputSchema: anyOutput,
      handler: async (ctx, input) => {
        await requireWorkspaceManager(ctx);
        await requireVerifiedWorkspaceOwner(ctx);
        const campaign = await campaignFor(ctx, input.id, OpError);
        if (campaign.status === "archived") throw new OpError("CONFLICT", "Archived campaigns cannot be launched.");
        const audiences = await campaignAudienceMap(ctx, [campaign]);
        const selectedListIds = audiences.get(campaign.id) ?? [];
        // A finished campaign can lose its last list to lists.delete; relaunching it
        // with zero lists would enroll all ready leads, so it needs a chosen list.
        if (campaign.status === "completed" && !selectedListIds.length) throw new OpError("CONFLICT", "Relaunching a finished campaign needs a contact list. Create a new campaign and choose its contact list.");
        // Publishing a paused sequence flips it to active and leaves its paused leads
        // stranded; resuming restores them and reschedules their next email first.
        const readyLeadIds = selectedListIds.length ? undefined : (await ctx.db.select({ id: schema.contacts.id }).from(schema.contacts).where(and(eq(schema.contacts.workspaceId, ctx.workspaceId), inArray(schema.contacts.status, ["active", "enrolled"])))).map((contact) => contact.id);
        // Blocks before anything is published or enrolled when a lead lacks a custom variable the steps use.
        await assertLaunchAudienceComplete(ctx.db, OpError, { workspaceId: ctx.workspaceId, sequenceId: campaign.sequenceId, campaignId: campaign.id, listIds: selectedListIds, leadIds: readyLeadIds });
        const [storedSequence] = await ctx.db.select({ status: schema.sequences.status }).from(schema.sequences).where(and(eq(schema.sequences.id, campaign.sequenceId), eq(schema.sequences.workspaceId, ctx.workspaceId)));
        if (storedSequence?.status === "paused") await runNamed("sequences.resume", ctx, { id: campaign.sequenceId });
        const sequence = await runNamed("sequences.publish", ctx, { id: campaign.sequenceId });
        const launchableCampaign = campaign.status === "paused" ? await resumeCampaign(ctx, campaign, OpError) : campaign;
        const enrollment = await runNamed("sequences.enroll", ctx, { id: campaign.sequenceId, listIds: selectedListIds.length ? selectedListIds : undefined, leadIds: readyLeadIds, inboxId: campaign.emailAccountId, campaignId: campaign.id });
        const now = new Date();
        // This call's own enroll can land zero new leads (e.g. a staged queue
        // already converted them while publishing above, or every ready lead
        // was already attributed to this campaign some other way - including
        // a crash between an earlier enroll commit and this activation flip)
        // while the campaign still legitimately has enrollments under it. Check
        // for those before giving up on activating a still-draft campaign.
        const launched = enrollment.enrolled > 0
          || Boolean((await ctx.db.select({ id: schema.enrollments.id }).from(schema.enrollments).where(and(eq(schema.enrollments.workspaceId, ctx.workspaceId), eq(schema.enrollments.campaignId, campaign.id))).limit(1))[0])
          || launchableCampaign.status !== "draft";
        // A finished campaign reactivates so the worker sends its new enrollments; a
        // concurrent pause or archive stays in place.
        if (launched) await ctx.db.transaction(async (tx) => {
          await reconcileCampaignStatus(tx, { workspaceId: ctx.workspaceId, campaignId: campaign.id, now });
          await tx.update(schema.campaigns).set({ status: "active", launchedAt: campaign.launchedAt ?? now, updatedAt: now }).where(and(eq(schema.campaigns.id, campaign.id), eq(schema.campaigns.workspaceId, ctx.workspaceId), inArray(schema.campaigns.status, ["draft", "active"])));
        });
        const [persisted] = await ctx.db.select().from(schema.campaigns).where(and(eq(schema.campaigns.id, campaign.id), eq(schema.campaigns.workspaceId, ctx.workspaceId)));
        const finalCampaign = persisted ?? launchableCampaign;
        return { campaign: { ...await campaignWithAudience(ctx, finalCampaign, audiences), status: finalCampaign.status, launchedAt: finalCampaign.launchedAt?.toISOString() ?? null, updatedAt: finalCampaign.updatedAt.toISOString() }, sequence: sequence.sequence, enrollment };
      },
    },
    ...(["pause", "resume", "archive"] as const).map((action) => ({
      name: `campaigns.${action}`, description: `${action[0]!.toUpperCase()}${action.slice(1)} a campaign without changing other campaigns on the same sequence.`, access: "write" as const, inputSchema: z.object({ id }), outputSchema: anyOutput,
      handler: async (ctx: OperationContext, input: { id: string }) => {
        await requireWorkspaceManager(ctx);
        const campaign = await campaignFor(ctx, input.id, OpError);
        const updatedCampaign = action === "pause" ? await pauseCampaign(ctx, campaign, OpError) : action === "resume" ? await resumeCampaign(ctx, campaign, OpError) : await archiveCampaign(ctx, campaign, OpError);
        const audiences = await campaignAudienceMap(ctx, [updatedCampaign]);
        return { campaign: { ...await campaignWithAudience(ctx, updatedCampaign, audiences), launchedAt: updatedCampaign.launchedAt?.toISOString() ?? null, createdAt: updatedCampaign.createdAt.toISOString(), updatedAt: updatedCampaign.updatedAt.toISOString() } };
      },
    })),
    {
      name: "campaigns.get", description: "Get campaign details, display status, analytics, and newLeadsReady: eligible list leads never enrolled in this campaign. Adding leads to its lists while active or finished automatically enrolls them and can start sends.", access: "read", inputSchema: z.object({ id }), outputSchema: anyOutput,
      handler: async (ctx, input) => {
        const campaign = await campaignFor(ctx, input.id, OpError);
        const audiences = await campaignAudienceMap(ctx, [campaign]);
        const metrics = await campaignMetrics(ctx, campaign.id);
        const selectedListIds = audiences.get(campaign.id) ?? [];
        const [sequence] = await ctx.db.select({ currentVersionId: schema.sequences.currentVersionId }).from(schema.sequences).where(and(eq(schema.sequences.id, campaign.sequenceId), eq(schema.sequences.workspaceId, ctx.workspaceId)));
        const newLeadsReady = campaign.status !== "draft" && campaign.status !== "archived" && selectedListIds.length
          ? (await findEligibleEnrollmentAudience({ db: ctx.db, workspaceId: ctx.workspaceId, campaignId: campaign.id, sequenceId: campaign.sequenceId, sequenceVersionId: sequence?.currentVersionId ?? null, listIds: selectedListIds })).eligible.length
          : 0;
        const steps = await ctx.db.select({ id: schema.sequenceSteps.id, stepOrder: schema.sequenceSteps.stepOrder, subject: schema.sequenceSteps.subject }).from(schema.sequenceSteps)
          .innerJoin(schema.sequenceVersions, eq(schema.sequenceSteps.sequenceVersionId, schema.sequenceVersions.id))
          .where(and(eq(schema.sequenceVersions.sequenceId, campaign.sequenceId), eq(schema.sequenceVersions.workspaceId, ctx.workspaceId))).orderBy(asc(schema.sequenceSteps.stepOrder));
        const byStep = new Map(steps.map((step) => [step.id, { sent: 0, opened: 0 }]));
        for (const message of metrics.messageRows) {
          const item = byStep.get(message.stepId);
          if (!item) continue;
          if (message.status === "accepted") item.sent++;
          if (metrics.openedIds.has(message.id)) item.opened++;
        }
        const enrollmentStatus = metrics.enrollmentRows.reduce<Record<string, number>>((result, row) => ({ ...result, [row.status]: (result[row.status] ?? 0) + 1 }), {});
        for (const enrollment of metrics.enrollmentRows.filter((row) => row.status === "replied")) {
          const accepted = metrics.messageRows.filter((row) => row.enrollmentId === enrollment.id && row.status === "accepted" && row.acceptedAt).sort((left, right) => right.acceptedAt!.getTime() - left.acceptedAt!.getTime());
          const attributed = accepted[0];
          if (attributed) (byStep.get(attributed.stepId) as { sent: number; opened: number; replied?: number }).replied = ((byStep.get(attributed.stepId) as { replied?: number }).replied ?? 0) + 1;
        }
        return { newLeadsReady, campaign: { ...await campaignWithAudience(ctx, campaign, audiences), newLeadsReady, launchedAt: campaign.launchedAt?.toISOString() ?? null, createdAt: campaign.createdAt.toISOString(), updatedAt: campaign.updatedAt.toISOString() }, totals: { enrolled: metrics.enrolled, sent: metrics.sent, replied: metrics.replied, opened: metrics.opened, replyRate: metrics.replyRate, openRate: metrics.openRate }, enrollmentStatus, steps: steps.map((step) => { const item = byStep.get(step.id)! as { sent: number; opened: number; replied?: number }; const replied = item.replied ?? 0; return { ...step, sent: item.sent, opened: item.opened, replied, openRate: percent(item.opened, item.sent), replyRate: percent(replied, item.sent) }; }) };
      },
    },
    {
      name: "sequences.enrollments", description: "List a sequence's enrollments with contact details, status, next step, and latest event.", access: "read", inputSchema: z.object({ id, page: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(100).default(25) }), outputSchema: anyOutput,
      handler: async (ctx, input) => pagedEnrollments(ctx, input.id, input, OpError),
    },
    { name: "templates.list", description: "List built-in sequence templates.", access: "read", inputSchema: z.object({}), outputSchema: anyOutput, handler: async () => ({ templates: builtInTemplates }) },
    { name: "sequences.fromTemplate", description: "Create a draft sequence from a built-in template.", access: "write", inputSchema: z.object({ templateKey: z.string() }), outputSchema: anyOutput, handler: async (ctx, input) => { const template = builtInTemplates.find((item) => item.key === input.templateKey); if (!template) throw new OpError("NOT_FOUND", "Template not found."); return runNamed("sequences.create", ctx, { name: template.name, description: template.description, steps: template.steps }); } },
    {
      name: "analytics.summary", description: "Get workspace delivery analytics and daily time-series buckets.", access: "read", inputSchema: z.object({ range: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(30) }), outputSchema: anyOutput,
      handler: async (ctx, input) => {
        const series = dailySeries(input.range);
        const since = new Date(`${series[0]!.date}T00:00:00.000Z`);
        const today = new Date(); today.setUTCHours(0, 0, 0, 0);
        const tomorrow = new Date(today.getTime() + 86_400_000);
        const [messageRows, enrollmentRows, terminalRows, sequenceRows, inboxRows, suppressionRows, replyRows, abuseRows, openRows, softBounceRows] = await Promise.all([
          ctx.db.select({ id: schema.messages.id, status: schema.messages.status, scheduledAt: schema.messages.scheduledAt, acceptedAt: schema.messages.acceptedAt, sequenceId: schema.enrollments.sequenceId }).from(schema.messages).innerJoin(schema.enrollments, eq(schema.messages.enrollmentId, schema.enrollments.id)).where(and(eq(schema.messages.workspaceId, ctx.workspaceId), sql`(${schema.messages.createdAt} >= ${since} or ${schema.messages.acceptedAt} >= ${since} or ${schema.messages.scheduledAt} >= ${today})`)),
          ctx.db.select({ status: schema.enrollments.status, sequenceId: schema.enrollments.sequenceId, stoppedAt: schema.enrollments.stoppedAt }).from(schema.enrollments).where(and(eq(schema.enrollments.workspaceId, ctx.workspaceId), gte(schema.enrollments.createdAt, since))),
          ctx.db.select({ status: schema.enrollments.status, stoppedAt: schema.enrollments.stoppedAt }).from(schema.enrollments).where(and(eq(schema.enrollments.workspaceId, ctx.workspaceId), gte(schema.enrollments.stoppedAt, since))),
          ctx.db.select({ id: schema.sequences.id, name: schema.sequences.name, status: schema.sequences.status }).from(schema.sequences).where(eq(schema.sequences.workspaceId, ctx.workspaceId)),
          // Deleted mailboxes are gone from the app, so they do not count toward inbox health.
          ctx.db.select({ status: schema.emailAccounts.status }).from(schema.emailAccounts).where(and(eq(schema.emailAccounts.workspaceId, ctx.workspaceId), ne(schema.emailAccounts.status, "removed"))),
          ctx.db.select({ id: schema.suppressions.id }).from(schema.suppressions).where(and(eq(schema.suppressions.workspaceId, ctx.workspaceId), gte(schema.suppressions.createdAt, since))),
          ctx.db.select({ email: schema.contacts.email, firstName: schema.contacts.firstName, lastName: schema.contacts.lastName, company: schema.contacts.company, repliedAt: schema.contacts.repliedAt, bouncedAt: schema.contacts.bouncedAt, sequence: schema.sequences.name }).from(schema.enrollments).innerJoin(schema.contacts, eq(schema.enrollments.contactId, schema.contacts.id)).innerJoin(schema.sequences, eq(schema.enrollments.sequenceId, schema.sequences.id)).where(and(eq(schema.enrollments.workspaceId, ctx.workspaceId), eq(schema.enrollments.status, "replied"), isNotNull(schema.contacts.repliedAt))).orderBy(desc(schema.contacts.repliedAt)).limit(5),
          ctx.db.select({ id: schema.abuseFlags.id }).from(schema.abuseFlags).where(and(eq(schema.abuseFlags.workspaceId, ctx.workspaceId), sql`${schema.abuseFlags.resolvedAt} is null`)),
          ctx.db.select({ messageId: schema.messageEvents.messageId, occurredAt: schema.messageEvents.occurredAt, metadata: schema.messageEvents.metadata }).from(schema.messageEvents).where(and(eq(schema.messageEvents.workspaceId, ctx.workspaceId), eq(schema.messageEvents.eventType, "opened"), gte(schema.messageEvents.occurredAt, since))),
          ctx.db.select({ messageId: schema.messageEvents.messageId }).from(schema.messageEvents).where(and(eq(schema.messageEvents.workspaceId, ctx.workspaceId), inArray(schema.messageEvents.eventType, softBounceEventTypes), gte(schema.messageEvents.occurredAt, since))),
        ]);
        const sent = messageRows.filter((item) => item.status === "accepted").length;
        const failed = messageRows.filter((item) => item.status === "failed").length;
        const replied = enrollmentRows.filter((item) => item.status === "replied").length;
        const bounced = enrollmentRows.filter((item) => item.status === "bounced").length;
        const unsubscribed = enrollmentRows.filter((item) => item.status === "unsubscribed").length;
        const openedMessageIds = new Set(openRows.flatMap((row) => row.messageId ? [row.messageId] : []));
        const humanOpenedMessageIds = new Set(openRows.flatMap((row) => row.messageId && row.metadata.bot !== true ? [row.messageId] : []));
        const opened = openedMessageIds.size;
        const humanOpened = humanOpenedMessageIds.size;
        const botOpened = opened - humanOpened;
        const softBounced = new Set(softBounceRows.flatMap((row) => row.messageId ? [row.messageId] : [])).size;
        const buckets = new Map(series.map((item) => [item.date, item]));
        for (const message of messageRows) if (message.status === "accepted" && message.acceptedAt) { const bucket = buckets.get(message.acceptedAt.toISOString().slice(0, 10)); if (bucket) bucket.sent++; }
        const openedPerDay = new Map<string, Set<string>>();
        const humanOpenedPerDay = new Map<string, Set<string>>();
        for (const event of openRows) if (event.messageId) {
          const date = event.occurredAt.toISOString().slice(0, 10);
          const openedIds = openedPerDay.get(date) ?? new Set<string>();
          openedIds.add(event.messageId);
          openedPerDay.set(date, openedIds);
          if (event.metadata.bot !== true) {
            const humanOpenedIds = humanOpenedPerDay.get(date) ?? new Set<string>();
            humanOpenedIds.add(event.messageId);
            humanOpenedPerDay.set(date, humanOpenedIds);
          }
        }
        for (const [date, ids] of openedPerDay) { const bucket = buckets.get(date); if (bucket) bucket.opened = ids.size; }
        for (const [date, ids] of humanOpenedPerDay) { const bucket = buckets.get(date); if (bucket) bucket.humanOpened = ids.size; }
        for (const enrollment of terminalRows) if (enrollment.stoppedAt) { const bucket = buckets.get(enrollment.stoppedAt.toISOString().slice(0, 10)); if (bucket && enrollment.status === "replied") bucket.replied++; if (bucket && enrollment.status === "bounced") bucket.bounced++; }
        const inboxProblems = inboxRows.filter((item) => item.status === "expired" || item.status === "error").length;
        const activeInboxes = inboxRows.filter((item) => item.status === "active").length;
        const bySequence = sequenceRows.map((sequence) => {
          const sequenceSent = messageRows.filter((item) => item.sequenceId === sequence.id && item.status === "accepted").length;
          const sequenceReplied = enrollmentRows.filter((item) => item.sequenceId === sequence.id && item.status === "replied").length;
          const sequenceUnsubscribed = enrollmentRows.filter((item) => item.sequenceId === sequence.id && item.status === "unsubscribed").length;
          return { sequenceId: sequence.id, name: sequence.name, sent: sequenceSent, replied: sequenceReplied, unsubscribed: sequenceUnsubscribed, unsubscribeRate: percent(sequenceUnsubscribed, sequenceSent) };
        }).filter((item) => item.sent || item.replied || item.unsubscribed);
        return { summary: { activeSequences: sequenceRows.filter((item) => item.status === "active").length, sendingToday: messageRows.filter((item) => item.status === "scheduled" && item.scheduledAt >= today && item.scheduledAt < tomorrow).length, inboxHealth: inboxRows.length ? Math.round((activeInboxes / inboxRows.length) * 100) : 0, needsAttention: inboxProblems + failed + abuseRows.length, sent, replied, opened, humanOpened, botOpened, bounced, softBounced, unsubscribed: Math.max(unsubscribed, suppressionRows.length), failed, replyRate: percent(replied, sent), openRate: percent(humanOpened, sent), bounceRate: percent(bounced, sent), unsubscribeRate: percent(Math.max(unsubscribed, suppressionRows.length), sent), bySequence, recentReplies: replyRows.map((item) => ({ lead: [item.firstName, item.lastName].filter(Boolean).join(" ") || item.email, company: item.company ?? "", sequence: item.sequence, when: item.repliedAt?.toISOString() })), series } };
      },
    },
    {
      name: "export.csv", description: "Export leads, suppressions, or campaign results as CSV text.", access: "read", inputSchema: z.object({ kind: z.enum(["leads", "suppressions", "campaign-results"]), campaignId: id.optional() }), outputSchema: anyOutput,
      handler: async (ctx, input) => {
        if (input.kind === "leads") { const rows = await ctx.db.select().from(schema.contacts).where(eq(schema.contacts.workspaceId, ctx.workspaceId)).orderBy(asc(schema.contacts.createdAt)); return { kind: input.kind, csv: toCsv(["id", "email", "firstName", "lastName", "company", "title", "status", "createdAt"], rows.map((row) => [row.id, row.email, row.firstName, row.lastName, row.company, row.title, row.status, row.createdAt.toISOString()])) }; }
        if (input.kind === "suppressions") { const rows = await ctx.db.select().from(schema.suppressions).where(eq(schema.suppressions.workspaceId, ctx.workspaceId)).orderBy(asc(schema.suppressions.createdAt)); return { kind: input.kind, csv: toCsv(["id", "email", "reason", "source", "createdAt"], rows.map((row) => [row.id, row.email, row.reason, row.source, row.createdAt.toISOString()])) }; }
        if (!input.campaignId) throw new OpError("BAD_INPUT", "campaignId is required for campaign-results exports.");
        await campaignFor(ctx, input.campaignId, OpError);
        const rows = await ctx.db.select({ enrollmentId: schema.enrollments.id, email: schema.contacts.email, firstName: schema.contacts.firstName, lastName: schema.contacts.lastName, company: schema.contacts.company, status: schema.enrollments.status, nextStepOrder: schema.enrollments.nextStepOrder, startedAt: schema.enrollments.startedAt, stoppedAt: schema.enrollments.stoppedAt }).from(schema.enrollments).innerJoin(schema.contacts, eq(schema.enrollments.contactId, schema.contacts.id)).where(and(eq(schema.enrollments.workspaceId, ctx.workspaceId), eq(schema.enrollments.campaignId, input.campaignId))).orderBy(asc(schema.enrollments.createdAt));
        return { kind: input.kind, campaignId: input.campaignId, csv: toCsv(["enrollmentId", "email", "firstName", "lastName", "company", "status", "nextStepOrder", "startedAt", "stoppedAt"], rows.map((row) => [row.enrollmentId, row.email, row.firstName, row.lastName, row.company, row.status, row.nextStepOrder, row.startedAt?.toISOString(), row.stoppedAt?.toISOString()])) };
      },
    },
    {
      name: "search.global", description: "Search sequences, campaigns, and contacts in the authenticated workspace.", access: "read", inputSchema: z.object({ q: z.string().trim().min(1).max(200) }), outputSchema: anyOutput,
      handler: async (ctx, input) => { const pattern = `%${input.q}%`; const [sequences, campaigns, contacts] = await Promise.all([
        ctx.db.select({ id: schema.sequences.id, name: schema.sequences.name, status: schema.sequences.status }).from(schema.sequences).where(and(eq(schema.sequences.workspaceId, ctx.workspaceId), ilike(schema.sequences.name, pattern))).limit(10),
        ctx.db.select().from(schema.campaigns).where(and(eq(schema.campaigns.workspaceId, ctx.workspaceId), ilike(schema.campaigns.name, pattern))).limit(10),
        ctx.db.select({ id: schema.contacts.id, email: schema.contacts.email, firstName: schema.contacts.firstName, lastName: schema.contacts.lastName, company: schema.contacts.company, status: schema.contacts.status }).from(schema.contacts).where(and(eq(schema.contacts.workspaceId, ctx.workspaceId), sql`(${schema.contacts.email} ilike ${pattern} or ${schema.contacts.firstName} ilike ${pattern} or ${schema.contacts.lastName} ilike ${pattern} or ${schema.contacts.company} ilike ${pattern})`)).limit(10),
      ]); const audiences = await campaignAudienceMap(ctx, campaigns); const statuses = await campaignDisplayStatuses(ctx.db, ctx.workspaceId, campaigns, ctx.env.edition); return { query: input.q, results: { sequences, campaigns: await Promise.all(campaigns.map((campaign) => campaignWithAudience(ctx, campaign, audiences, statuses))), contacts } }; },
    },
    { name: "notifications.list", description: "List recent workspace notifications.", access: "read", inputSchema: z.object({ unreadOnly: z.boolean().default(false), limit: z.number().int().min(1).max(100).default(50) }), outputSchema: anyOutput, handler: async (ctx, input) => ({ notifications: (await ctx.db.select().from(schema.notifications).where(and(eq(schema.notifications.workspaceId, ctx.workspaceId), input.unreadOnly ? sql`${schema.notifications.readAt} is null` : undefined)).orderBy(desc(schema.notifications.createdAt)).limit(input.limit)).map((row) => ({ ...row, readAt: row.readAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString() })) }) },
    { name: "notifications.markRead", description: "Mark one notification or all workspace notifications as read.", access: "write", inputSchema: z.object({ id: id.optional(), all: z.boolean().default(false) }).refine((value) => value.id || value.all, "Provide id or all=true."), outputSchema: anyOutput, handler: async (ctx, input) => { const rows = await ctx.db.update(schema.notifications).set({ readAt: new Date() }).where(and(eq(schema.notifications.workspaceId, ctx.workspaceId), input.id ? eq(schema.notifications.id, input.id) : sql`${schema.notifications.readAt} is null`)).returning({ id: schema.notifications.id }); if (input.id && !rows.length) throw new OpError("NOT_FOUND", "Notification not found."); return { markedRead: rows.length }; } },
  ];
}
