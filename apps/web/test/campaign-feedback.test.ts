import { describe, expect, it } from "vitest";
import { campaignLeadFeedback, type CampaignUpdate } from "../app/app/(product)/leads/campaign-feedback";

const campaign: CampaignUpdate = { campaignId: "campaign-id", name: "Spring Outreach", enrolled: 42, restarted: false, blockedReason: null };

describe("add-leads campaign feedback", () => {
  it("confirms a finished campaign restart", () => {
    expect(campaignLeadFeedback(42, [{ ...campaign, restarted: true }], "Lead import complete.")).toBe("42 leads added. Spring Outreach restarted.");
  });

  it("confirms enrollment into an active campaign", () => {
    expect(campaignLeadFeedback(42, [campaign], "Lead import complete.")).toBe("42 leads added and enrolled in Spring Outreach.");
  });

  it.each<[NonNullable<CampaignUpdate["blockedReason"]>, string]>([
    ["campaign_paused", "Resume Spring Outreach to send to them."],
    ["plan_limit", "Get the lifetime license to send to them."],
    ["no_sender", "Connect a mailbox to send to them."],
    ["sending_disabled", "Turn sending back on to reach them."],
    ["not_manager", "A workspace manager can send to them."],
    ["sequence_inactive", "Publish the sequence to send to them."],
  ])("explains %s while confirming the leads were added", (blockedReason, expected) => {
    expect(campaignLeadFeedback(42, [{ ...campaign, enrolled: 0, blockedReason }], "Lead import complete.")).toBe(`42 leads added. ${expected}`);
  });

  it("summarizes additional campaigns after the first", () => {
    expect(campaignLeadFeedback(42, [campaign, campaign, campaign], "Lead import complete.")).toBe("42 leads added and enrolled in Spring Outreach. +2 more campaigns.");
  });

  it("headlines a restart ahead of blocked or enrolled campaigns", () => {
    expect(campaignLeadFeedback(42, [{ ...campaign, name: "Paused campaign", enrolled: 0, blockedReason: "campaign_paused" }, campaign, { ...campaign, name: "Restarted campaign", restarted: true }], "Lead import complete.")).toBe("42 leads added. Restarted campaign restarted. +2 more campaigns.");
  });

  it("headlines enrollment ahead of a blocked campaign", () => {
    expect(campaignLeadFeedback(42, [{ ...campaign, name: "Paused campaign", enrolled: 0, blockedReason: "campaign_paused" }, campaign], "Lead import complete.")).toBe("42 leads added and enrolled in Spring Outreach. +1 more campaign.");
  });

  it.each([undefined, null, []])("keeps the existing message when campaign updates are empty", (campaignUpdates) => {
    expect(campaignLeadFeedback(42, campaignUpdates, "Lead import complete.")).toBe("Lead import complete.");
  });

  it("keeps import skip feedback when every lead was already enrolled", () => {
    expect(campaignLeadFeedback(0, [{ ...campaign, enrolled: 0 }], "Lead import complete.")).toBe("Lead import complete.");
  });

  it("uses singular copy for an individual lead", () => {
    expect(campaignLeadFeedback(1, [{ ...campaign, enrolled: 1 }], "Lead added.")).toBe("1 lead added and enrolled in Spring Outreach.");
  });
});
