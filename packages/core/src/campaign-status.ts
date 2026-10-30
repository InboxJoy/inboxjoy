import type { InboxJoyDb } from "@inboxjoy/db";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import { freePlanMonthlySendsSql, planAllowsCampaignSends, sendingPlan } from "./delivery/can-send.js";
import type { Edition } from "./edition.js";

export type CampaignStatusChange = "finished" | "restarted" | null;
export type CampaignDisplayStatus = "draft" | "active" | "needs_attention" | "paused" | "finished" | "archived";
export type CampaignStatusReason = "sequence_paused" | "mailbox_reconnect_required" | "sending_failed_repeatedly" | "sending_disabled" | null;
export type CampaignStatusExecutor = Pick<InboxJoyDb, "execute"> | {
  query: (text: string, values: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};
export type CampaignStatusResult = {
  id: string;
  name: string;
  status: string;
  change: CampaignStatusChange;
  previousCompletedAt: Date | null;
};
// allowRestart is passed only by the enrollment path: a finished campaign restarts
// because new leads were just enrolled, never because a late terminal event or the
// sweep found leftover in-progress rows under it. notify: false keeps housekeeping quiet.
export type CampaignStatusInput = { workspaceId: string; campaignId: string; now?: Date; allowRestart?: boolean; notify?: boolean };
export type DisplayStatus = { displayStatus: CampaignDisplayStatus; statusReason: CampaignStatusReason };

function dateValue(value: Date | string | null): Date | null {
  return typeof value === "string" ? new Date(value) : value;
}

async function rows<Row>(executor: CampaignStatusExecutor, statement: SQL): Promise<Row[]> {
  if (!("execute" in executor)) {
    const query = new PgDialect().sqlToQuery(statement);
    return (await executor.query(query.sql, query.params)).rows as Row[];
  }
  return (await executor.execute(statement)).rows as Row[];
}

async function reconcileLocked(executor: CampaignStatusExecutor, input: CampaignStatusInput): Promise<CampaignStatusResult | null> {
  const [campaign] = await rows<{ id: string; name: string; status: string; launched_at: Date | string | null; completed_at: Date | string | null }>(executor, sql`
    SELECT id, name, status, launched_at, completed_at FROM campaigns
    WHERE workspace_id = ${input.workspaceId} AND id = ${input.campaignId} FOR UPDATE
  `);
  if (!campaign) return null;
  const result: CampaignStatusResult = { id: campaign.id, name: campaign.name, status: campaign.status, change: null, previousCompletedAt: dateValue(campaign.completed_at) };
  if (campaign.status === "draft" || campaign.status === "paused" || campaign.status === "archived") return result;
  const [counts] = await rows<{ count: string }>(executor, sql`
    SELECT count(*)::text AS count FROM enrollments
    WHERE workspace_id = ${input.workspaceId} AND campaign_id = ${input.campaignId}
      AND status IN ('scheduled', 'active', 'paused')
  `);
  const remaining = Number(counts?.count ?? 0);
  const now = input.now ?? new Date();
  if (campaign.status === "active" && campaign.launched_at && remaining === 0) {
    await rows(executor, sql`UPDATE campaigns SET status = 'completed', completed_at = ${now}, updated_at = ${now}
      WHERE workspace_id = ${input.workspaceId} AND id = ${input.campaignId}`);
    result.status = "completed";
    result.change = "finished";
  } else if (input.allowRestart && campaign.status === "completed" && remaining > 0) {
    await rows(executor, sql`UPDATE campaigns SET status = 'active', updated_at = ${now}
      WHERE workspace_id = ${input.workspaceId} AND id = ${input.campaignId}`);
    result.status = "active";
    result.change = "restarted";
  }
  if (result.change && input.notify !== false) {
    const type = result.change === "finished" ? "campaign_completed" : "campaign_restarted";
    const title = result.change === "finished" ? `Campaign completed: ${campaign.name}` : `Campaign restarted: ${campaign.name}`;
    const body = result.change === "finished" ? `Campaign ${campaign.id} has finished all eligible enrollments.` : `${remaining} ${remaining === 1 ? "lead is" : "leads are"} in progress in this campaign.`;
    await rows(executor, sql`INSERT INTO notifications (id, workspace_id, type, title, body)
      VALUES (${randomUUID()}, ${input.workspaceId}, ${type}, ${title}, ${body})`);
  }
  return result;
}

export async function reconcileCampaignStatus(executor: CampaignStatusExecutor, input: CampaignStatusInput): Promise<CampaignStatusResult | null> {
  if ("$client" in executor) {
    return (executor as InboxJoyDb).transaction((tx) => reconcileLocked(tx, input));
  }
  return reconcileLocked(executor, input);
}

export function campaignDisplayStatus(input: {
  status: string;
  sendingEnabled: boolean;
  sequenceStatus: string | null;
  inProgress: number;
  mailboxPaused: number;
  failurePaused: number;
}): DisplayStatus {
  // An archived sequence can never send again, whatever its campaign last recorded.
  if (input.sequenceStatus === "archived" && input.status !== "draft") return { displayStatus: "archived", statusReason: null };
  if (input.status !== "active") {
    return { displayStatus: input.status === "completed" ? "finished" : input.status as CampaignDisplayStatus, statusReason: null };
  }
  if (input.sequenceStatus === "paused") {
    return input.failurePaused > 0
      ? { displayStatus: "needs_attention", statusReason: "sequence_paused" }
      : { displayStatus: "paused", statusReason: null };
  }
  let statusReason: CampaignStatusReason = null;
  if (!input.sendingEnabled) statusReason = "sending_disabled";
  else if (input.sequenceStatus !== "active") statusReason = "sequence_paused";
  else if (input.inProgress > 0 && input.mailboxPaused + input.failurePaused === input.inProgress) {
    statusReason = input.failurePaused > 0 ? "sending_failed_repeatedly" : "mailbox_reconnect_required";
  }
  return { displayStatus: statusReason ? "needs_attention" : "active", statusReason };
}

// Leads enrolled straight into a published sequence belong to no launched campaign, so
// no campaign row ever finishes for them. That run reads from the sequence's own
// enrollments instead: sending while any are in progress, finished once all have ended.
// Shared by sequences.list (readSequences, bulk) and sequences.get (single sequence) so
// both report the exact same displayStatus/statusReason/completedAt for the same sequence.
export function deriveSequenceDisplay(input: {
  sequenceStatus: string;
  campaign?: { status: string; completedAt: Date | null };
  enrolledCount: number;
  inProgressCount: number;
  lastStoppedAt: Date | null;
  // campaignDisplayStatus() computed from the sequence's own id/status, used for a
  // direct sequence-level run and as the fallback when no campaign exists at all.
  sequenceOwnDisplay: DisplayStatus;
  // campaignDisplayStatus() computed from the real campaign, when one exists.
  campaignDisplay?: DisplayStatus;
}): DisplayStatus & { completedAt: string | null } {
  const sequenceRun = (!input.campaign || input.campaign.status === "draft") && input.enrolledCount > 0;
  const sequenceRunFinished = sequenceRun && input.sequenceStatus === "active" && input.inProgressCount === 0;
  const display = sequenceRunFinished
    ? { displayStatus: "finished" as const, statusReason: null }
    : sequenceRun ? input.sequenceOwnDisplay : (input.campaignDisplay ?? input.sequenceOwnDisplay);
  const completedAt = (sequenceRunFinished ? input.lastStoppedAt : input.campaign?.completedAt ?? null)?.toISOString() ?? null;
  return { ...display, completedAt };
}

export async function campaignDisplayStatuses(db: Pick<InboxJoyDb, "execute">, workspaceId: string, campaigns: Array<{ id: string; status: string; sequenceId: string }>, edition: Edition): Promise<Map<string, DisplayStatus>> {
  const statuses = new Map<string, DisplayStatus>();
  if (!campaigns.length) return statuses;
  const active = campaigns.filter((campaign) => campaign.status === "active");
  let sendingEnabled = false;
  const sequenceStatuses = new Map<string, string>();
  const enrollmentCounts = new Map<string, { in_progress: string; mailbox_paused: string; failure_paused: string }>();
  // Draft and archived campaigns read the same whatever their sequence is doing.
  const sequenceBound = campaigns.filter((campaign) => campaign.status !== "draft" && campaign.status !== "archived");
  if (active.length) {
    const [workspace] = await rows<{ status: string; kill_switch_enabled: boolean; legacy_free_until: Date | string | null; subscription_status: string | null; trial_end: Date | string | null; grace_ends_at: Date | string | null; month_sends: string }>(db, sql`
      SELECT w.status, w.kill_switch_enabled, w.legacy_free_until, s.status AS subscription_status, s.trial_end,
        s.updated_at + interval '7 days' AS grace_ends_at,
        ${sql.raw(freePlanMonthlySendsSql({ workspaceIdSql: "w.id" }))}::text AS month_sends
      FROM workspaces w LEFT JOIN subscriptions s ON s.workspace_id = w.id WHERE w.id = ${workspaceId}
    `);
    // canSend's plan gate: entitled (self-host, license, comp), or legacy Free
    // with sends left this month. An unlicensed cloud workspace needs attention.
    const plan = workspace ? sendingPlan({
      edition,
      subscription: workspace.subscription_status ? { status: workspace.subscription_status, trialEnd: dateValue(workspace.trial_end), onHoldGraceEndsAt: dateValue(workspace.grace_ends_at) } : null,
      legacyFreeUntil: dateValue(workspace.legacy_free_until),
    }, new Date()) : "unlicensed";
    sendingEnabled = Boolean(workspace && workspace.status === "active" && !workspace.kill_switch_enabled && planAllowsCampaignSends(plan, Number(workspace.month_sends)));
  }
  if (sequenceBound.length) {
    const sequenceIds = sql.join([...new Set(sequenceBound.map((campaign) => campaign.sequenceId))].map((sequenceId) => sql`${sequenceId}`), sql`, `);
    for (const sequence of await rows<{ id: string; status: string }>(db, sql`SELECT id, status FROM sequences WHERE workspace_id = ${workspaceId} AND id IN (${sequenceIds})`)) {
      sequenceStatuses.set(sequence.id, sequence.status);
    }
  }
  if (active.length) {
    const campaignIds = sql.join(active.map((campaign) => sql`${campaign.id}`), sql`, `);
    for (const count of await rows<{ campaign_id: string; in_progress: string; mailbox_paused: string; failure_paused: string }>(db, sql`
      SELECT campaign_id, count(*)::text AS in_progress,
        count(*) FILTER (WHERE status = 'paused' AND stop_reason = 'mailbox_auth_expired')::text AS mailbox_paused,
        count(*) FILTER (WHERE status = 'paused' AND stop_reason = 'repeated_provider_failure')::text AS failure_paused
      FROM enrollments WHERE workspace_id = ${workspaceId} AND campaign_id IN (${campaignIds})
        AND status IN ('scheduled', 'active', 'paused') GROUP BY campaign_id
    `)) enrollmentCounts.set(count.campaign_id, count);
  }
  for (const campaign of campaigns) {
    const counts = enrollmentCounts.get(campaign.id);
    statuses.set(campaign.id, campaignDisplayStatus({ status: campaign.status, sendingEnabled,
      sequenceStatus: sequenceStatuses.get(campaign.sequenceId) ?? null, inProgress: Number(counts?.in_progress ?? 0),
      mailboxPaused: Number(counts?.mailbox_paused ?? 0), failurePaused: Number(counts?.failure_paused ?? 0) }));
  }
  return statuses;
}
