import { campaignDisplayStatus, type CampaignStatusFields } from "@inboxjoy/ui";

export type SequenceCampaignStatus = CampaignStatusFields & { id: string; campaignId?: string; sequenceStatus?: string; activeCount?: number };

export function canPauseCampaign(row: SequenceCampaignStatus): boolean {
  return ["active", "published"].includes(row.sequenceStatus ?? row.status)
    && (["active", "needs_attention"].includes(campaignDisplayStatus(row)) || (row.activeCount ?? 0) > 0);
}

export function canResumeCampaign(row: SequenceCampaignStatus): boolean {
  return campaignDisplayStatus(row) === "paused" || row.sequenceStatus === "paused" || row.statusReason === "sequence_paused";
}

export function campaignResumePath(row: SequenceCampaignStatus): string {
  return row.campaignId && row.status === "paused"
    ? `/v1/campaigns/${row.campaignId}/resume`
    : `/v1/sequences/${row.id}/resume`;
}

type ContentSnapshot = { name: string; description?: string; steps: ReadonlyArray<{ id: string; delayDays: number; subject: string; body: string }> };

// True when the editor holds copy that differs from what was last loaded or saved.
export function hasUnsavedContent(saved: ContentSnapshot | null, draft: ContentSnapshot): boolean {
  if (!saved) return false;
  const shape = (value: ContentSnapshot) => JSON.stringify([value.name, value.description ?? "", value.steps.map((step) => [step.id, Math.max(0, Number(step.delayDays) || 0), step.subject, step.body])]);
  return shape(saved) !== shape(draft);
}

export function newLeadsNotice(enrolled: number): string {
  return enrolled > 0
    ? `${enrolled} new ${enrolled === 1 ? "lead" : "leads"} enrolled.`
    : "Every lead on this campaign's lists has already been contacted or is busy in another campaign.";
}

export type QueuedEnrollmentOutcome = { enrolled?: number; blocked?: boolean; errors?: Array<{ message?: string }> };

// Publishing a draft converts anything queued on it. Surface that outcome
// instead of a bare "published" when there was something to convert, since
// a blocked conversion means the campaign is published but nothing is
// sending yet.
export function publishNotice(queuedEnrollment?: QueuedEnrollmentOutcome | null): string {
  if (!queuedEnrollment) return "Campaign published.";
  if (queuedEnrollment.blocked) {
    const reason = queuedEnrollment.errors?.find((item) => item.message)?.message;
    return `Campaign published, but queued contacts have not started sending yet${reason ? `: ${reason}` : "."} Publish again once that is resolved.`;
  }
  const enrolled = queuedEnrollment.enrolled ?? 0;
  return enrolled > 0 ? `Campaign published. ${enrolled} queued ${enrolled === 1 ? "contact" : "contacts"} started sending.` : "Campaign published.";
}

export type CampaignTarget = CampaignStatusFields & {
  id: string;
  sequenceId: string;
  name: string;
  listIds?: string[];
  listId?: string | null;
  newLeadsReady?: number;
};

export function campaignTargetsBySequence(campaigns: readonly CampaignTarget[]): Map<string, CampaignTarget> {
  const targets = new Map<string, CampaignTarget>();
  for (const campaign of campaigns) {
    if (!targets.has(campaign.sequenceId)) targets.set(campaign.sequenceId, campaign);
  }
  return targets;
}

export function withCampaignStatus<Sequence extends CampaignStatusFields & { activeCount?: number }>(sequence: Sequence, campaign?: CampaignTarget) {
  if (!campaign) return { ...sequence, campaignId: undefined, newLeadsReady: 0 };
  const displayStatus = campaignDisplayStatus(campaign);
  // Leads enrolled straight into the sequence never touch a draft campaign, so the
  // sequence row carries the real state of that run (sending, needs attention, finished).
  const sequenceLed = campaign.status === "draft" && Boolean(sequence.displayStatus) && sequence.displayStatus !== "draft";
  return {
    ...sequence,
    campaignId: campaign.id,
    status: campaign.status,
    sequenceStatus: sequence.status,
    displayStatus: sequenceLed
      ? sequence.displayStatus
      : ["draft", "finished"].includes(displayStatus) && ["active", "published"].includes(sequence.status) && (sequence.activeCount ?? 0) > 0 ? "active" as const : campaign.displayStatus,
    statusReason: sequenceLed ? sequence.statusReason : campaign.statusReason,
    completedAt: sequenceLed ? sequence.completedAt : campaign.completedAt,
    newLeadsReady: campaign.newLeadsReady ?? 0,
  };
}
