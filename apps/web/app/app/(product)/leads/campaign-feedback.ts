export type CampaignUpdate = {
  campaignId: string;
  name: string;
  enrolled: number;
  restarted: boolean;
  blockedReason: "campaign_paused" | "sequence_inactive" | "plan_limit" | "no_sender" | "sending_disabled" | "not_manager" | null;
};

export function campaignLeadFeedback(added: number, campaignUpdates: readonly CampaignUpdate[] | null | undefined, fallback: string): string {
  const campaign = campaignUpdates?.find((update) => update.restarted) ?? campaignUpdates?.find((update) => update.enrolled > 0) ?? campaignUpdates?.[0];
  if (!campaign) return fallback;
  const leadCount = `${added} lead${added === 1 ? "" : "s"} added`;
  let message = fallback;
  if (campaign.restarted) {
    message = `${leadCount}. ${campaign.name} restarted.`;
  } else if (campaign.blockedReason) {
    const reasons: Record<NonNullable<CampaignUpdate["blockedReason"]>, string> = {
      campaign_paused: `Resume ${campaign.name} to send to them.`,
      plan_limit: "Get the lifetime license to send to them.",
      no_sender: "Connect a mailbox to send to them.",
      sending_disabled: "Turn sending back on to reach them.",
      not_manager: "A workspace manager can send to them.",
      sequence_inactive: "Publish the sequence to send to them.",
    };
    message = `${leadCount}. ${reasons[campaign.blockedReason]}`;
  } else if (campaign.enrolled > 0) {
    message = `${leadCount} and enrolled in ${campaign.name}.`;
  }
  const moreCampaigns = (campaignUpdates?.length ?? 0) - 1;
  return moreCampaigns > 0 ? `${message} +${moreCampaigns} more ${moreCampaigns === 1 ? "campaign" : "campaigns"}.` : message;
}
