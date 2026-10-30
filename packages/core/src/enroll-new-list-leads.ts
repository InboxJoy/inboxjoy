import { schema } from "@inboxjoy/db";
import { and, asc, eq, inArray, or } from "drizzle-orm";

import { randomUUID } from "node:crypto";

import { findEligibleEnrollmentAudience } from "./enrollment-eligibility.js";
import { enrollSequence, OpError, type OperationContext } from "./index.js";
import { readSequenceMailboxIds } from "./sequence-mailboxes.js";

export type CampaignEnrollmentBlockedReason = "campaign_paused" | "sequence_inactive" | "plan_limit" | "no_sender" | "sending_disabled" | "not_manager" | null;
export type CampaignUpdate = {
  campaignId: string;
  name: string;
  enrolled: number;
  restarted: boolean;
  blockedReason: CampaignEnrollmentBlockedReason;
};

function blockedReason(error: unknown): CampaignEnrollmentBlockedReason {
  if (error instanceof OpError) {
    if (error.code === "plan_limit") return "plan_limit";
    if (error.code === "FORBIDDEN") return "not_manager";
    const reason = (error.details as { blockedReason?: unknown } | undefined)?.blockedReason;
    if (reason === "no_sender" || reason === "sequence_inactive" || reason === "campaign_paused") return reason;
  }
  return "sending_disabled";
}

type CampaignForEnrollment = Pick<typeof schema.campaigns.$inferSelect, "id" | "name" | "status" | "sequenceId" | "emailAccountId">;

// Enrolls the given leads into one campaign through the shared enrollSequence
// path (eligibility, missing-variable gating, caps, warm-up, sender precedence
// identical to campaigns.launch). Never throws: a blocked campaign reports its
// reason on the returned update.
//
// With stageWhenPaused, a paused campaign keeps the leads it could not enroll (eligible ones
// and ones still waiting on custom variables) in the staged queue instead of dropping them;
// resuming the campaign converts the ones that are complete by then.
export async function enrollLeadsIntoCampaign(
  ctx: OperationContext,
  campaign: CampaignForEnrollment,
  leadIds: string[],
  logFailure?: (error: unknown, campaignId?: string) => void,
  options: { stageWhenPaused?: boolean } = {},
): Promise<CampaignUpdate> {
  const update: CampaignUpdate = { campaignId: campaign.id, name: campaign.name, enrolled: 0, restarted: false, blockedReason: null };
  try {
    if (campaign.status === "paused") {
      update.blockedReason = "campaign_paused";
      if (options.stageWhenPaused && leadIds.length) await stagePausedCampaignLeads(ctx, campaign, leadIds);
      return update;
    }
    const [sequence] = await ctx.db.select({ status: schema.sequences.status, currentVersionId: schema.sequences.currentVersionId }).from(schema.sequences).where(and(eq(schema.sequences.id, campaign.sequenceId), eq(schema.sequences.workspaceId, ctx.workspaceId))).limit(1);
    if (sequence?.status !== "active" || !sequence.currentVersionId) {
      update.blockedReason = "sequence_inactive";
      if (options.stageWhenPaused && sequence?.status === "paused" && leadIds.length) await stagePausedCampaignLeads(ctx, campaign, leadIds);
      return update;
    }
    const savedMailboxIds = await readSequenceMailboxIds(ctx.db, ctx.workspaceId, campaign.sequenceId);
    const enrollment = await enrollSequence(ctx, {
      id: campaign.sequenceId,
      campaignId: campaign.id,
      leadIds,
      // Same sender precedence as campaigns.launch: the campaign's own mailbox first.
      ...(campaign.emailAccountId ? { inboxId: campaign.emailAccountId } : savedMailboxIds.length ? { inboxIds: savedMailboxIds } : {}),
    });
    update.enrolled = enrollment.enrolled;
    update.restarted = enrollment.restarted === true;
  } catch (error) {
    update.blockedReason = blockedReason(error);
    try {
      logFailure?.(error, campaign.id);
    } catch {}
  }
  return update;
}

async function stagePausedCampaignLeads(ctx: OperationContext, campaign: CampaignForEnrollment, leadIds: string[]): Promise<void> {
  const [sequence] = await ctx.db.select({ currentVersionId: schema.sequences.currentVersionId }).from(schema.sequences).where(and(eq(schema.sequences.id, campaign.sequenceId), eq(schema.sequences.workspaceId, ctx.workspaceId))).limit(1);
  const audience = await findEligibleEnrollmentAudience({ db: ctx.db, workspaceId: ctx.workspaceId, sequenceId: campaign.sequenceId, campaignId: campaign.id, sequenceVersionId: sequence?.currentVersionId ?? null, leadIds });
  const waiting = [...new Set([...audience.eligible.map((lead) => lead.id), ...audience.skippedLeadIds.missing_variables])];
  const now = new Date();
  for (let offset = 0; offset < waiting.length; offset += 1000) {
    await ctx.db.insert(schema.stagedEnrollments).values(waiting.slice(offset, offset + 1000).map((leadId) => ({ id: randomUUID(), workspaceId: ctx.workspaceId, sequenceId: campaign.sequenceId, leadId, campaignId: campaign.id, inboxIds: null, createdAt: now }))).onConflictDoNothing();
  }
}

export async function enrollNewListLeads(ctx: OperationContext, input: { listId: string; leadIds: string[] }): Promise<{ campaignUpdates: CampaignUpdate[] }> {
  const campaignUpdates: CampaignUpdate[] = [];
  const logFailure = (error: unknown, campaignId?: string) => {
    try {
      ctx.logger?.warn?.({ error, campaignId, listId: input.listId, workspaceId: ctx.workspaceId }, "Automatic campaign enrollment was blocked.");
    } catch {}
  };
  try {
    const [list] = await ctx.db.select({ id: schema.contactLists.id }).from(schema.contactLists).where(and(eq(schema.contactLists.id, input.listId), eq(schema.contactLists.workspaceId, ctx.workspaceId))).limit(1);
    if (!list) return { campaignUpdates };
    const linkedCampaignIds = ctx.db.select({ id: schema.campaignContactLists.campaignId }).from(schema.campaignContactLists).where(and(eq(schema.campaignContactLists.workspaceId, ctx.workspaceId), eq(schema.campaignContactLists.contactListId, list.id)));
    const campaigns = await ctx.db.select().from(schema.campaigns).where(and(
      eq(schema.campaigns.workspaceId, ctx.workspaceId),
      inArray(schema.campaigns.status, ["active", "paused", "completed"]),
      or(eq(schema.campaigns.contactListId, list.id), inArray(schema.campaigns.id, linkedCampaignIds)),
    )).orderBy(asc(schema.campaigns.launchedAt), asc(schema.campaigns.id));
    const leadIds = [...new Set(input.leadIds)];
    for (const campaign of campaigns) {
      campaignUpdates.push(await enrollLeadsIntoCampaign(ctx, campaign, leadIds, logFailure));
    }
  } catch (error) {
    logFailure(error);
  }
  return { campaignUpdates };
}
