import { describe, expect, it } from "vitest";
import {
  campaignDisplayStatus,
  campaignStatusLabel,
  campaignStatusReasonText,
  campaignStatusTone,
  type CampaignDisplayStatus,
  type CampaignStatusReason,
} from "../../../packages/ui/src/index";
import { campaignResumePath, canPauseCampaign, canResumeCampaign, campaignTargetsBySequence, hasUnsavedContent, withCampaignStatus } from "../app/app/(product)/sequences/campaign-data";

describe("shared campaign status display", () => {
  it.each<[CampaignDisplayStatus, string, string]>([
    ["draft", "Draft", "neutral"],
    ["active", "Active", "good"],
    ["needs_attention", "Needs attention", "danger"],
    ["paused", "Paused", "warning"],
    ["finished", "Finished", "info"],
    ["archived", "Archived", "neutral"],
  ])("maps %s to its campaign label and tone", (status, label, tone) => {
    expect(campaignStatusLabel(status)).toBe(label);
    expect(campaignStatusTone(status)).toBe(tone);
    expect(campaignDisplayStatus({ status })).toBe(status);
  });

  it.each([
    ["completed", "finished"],
    ["published", "active"],
    ["draft", "draft"],
    ["paused", "paused"],
    ["archived", "archived"],
  ])("supports older responses with stored status %s", (status, expected) => {
    expect(campaignDisplayStatus({ status })).toBe(expected);
    expect(campaignDisplayStatus({ status, displayStatus: null })).toBe(expected);
  });

  it("uses the computed sending status ahead of stored status", () => {
    expect(campaignDisplayStatus({ status: "active", displayStatus: "needs_attention" })).toBe("needs_attention");
  });

  it.each<[CampaignStatusReason, string]>([
    ["sending_disabled", "Sending is off for this workspace. Check billing to continue."],
    ["sequence_paused", "Sending stopped after repeated errors. Resume to continue."],
    ["mailbox_reconnect_required", "Reconnect your mailbox to continue sending."],
    ["sending_failed_repeatedly", "Recent sends failed. Check your mailbox connection."],
  ])("provides the reason line for %s", (reason, expected) => {
    expect(campaignStatusReasonText(reason)).toBe(expected);
  });

  it("omits an empty reason line", () => {
    expect(campaignStatusReasonText(null)).toBeNull();
    expect(campaignStatusReasonText(undefined)).toBeNull();
  });
});

describe("campaign-backed sequence rows", () => {
  it.each(["draft", "completed"])("shows active sends ahead of a %s campaign badge", (status) => {
    const row = withCampaignStatus({ id: "sequence", status: "published", activeCount: 1 }, { id: "campaign", sequenceId: "sequence", name: "Campaign", status });
    expect(campaignDisplayStatus(row)).toBe("active");
    expect(canPauseCampaign(row)).toBe(true);
  });

  it("pauses attention rows only while their sequence is active", () => {
    expect(canPauseCampaign({ id: "sequence", status: "active", displayStatus: "needs_attention", sequenceStatus: "published" })).toBe(true);
    expect(canPauseCampaign({ id: "sequence", status: "active", displayStatus: "needs_attention", sequenceStatus: "paused", activeCount: 1 })).toBe(false);
  });

  it("resumes legacy and provider-failure sequence pauses through the sequence", () => {
    const row = { id: "sequence", campaignId: "campaign", status: "active", sequenceStatus: "paused", displayStatus: "paused" as const };
    expect(canResumeCampaign(row)).toBe(true);
    expect(campaignResumePath(row)).toBe("/v1/sequences/sequence/resume");
    expect(canResumeCampaign({ ...row, displayStatus: "needs_attention", statusReason: "sequence_paused" })).toBe(true);
    expect(campaignResumePath({ ...row, displayStatus: "needs_attention", statusReason: "sequence_paused" })).toBe("/v1/sequences/sequence/resume");
    expect(campaignResumePath({ ...row, status: "paused" })).toBe("/v1/campaigns/campaign/resume");
    expect(canResumeCampaign({ ...row, status: "completed", displayStatus: "finished" })).toBe(true);
  });
  it("uses the first campaign for a sequence consistently with its detail page", () => {
    const latest = { id: "latest-campaign", sequenceId: "sequence-id", name: "Spring Outreach", status: "completed" };
    const older = { ...latest, id: "older-campaign", status: "archived" };
    expect(campaignTargetsBySequence([latest, older]).get("sequence-id")).toBe(latest);
  });

  it("keeps the sequence id for editing and the campaign id for launching", () => {
    const sequence = { id: "sequence-id", status: "published", steps: [] };
    const campaign = {
      id: "campaign-id", sequenceId: sequence.id, name: "Spring Outreach", status: "completed",
      displayStatus: "finished" as const, statusReason: null, completedAt: "2026-10-02T10:00:00.000Z", newLeadsReady: 42,
    };
    expect(withCampaignStatus(sequence, campaign)).toEqual({
      ...sequence, sequenceStatus: "published", campaignId: "campaign-id", status: "completed", displayStatus: "finished", statusReason: null,
      completedAt: campaign.completedAt, newLeadsReady: 42,
    });
  });

  it("uses the campaign stored status fallback with older campaign responses", () => {
    const sequence = { id: "sequence-id", status: "published", displayStatus: "active" as const };
    const row = withCampaignStatus(sequence, { id: "campaign-id", sequenceId: sequence.id, name: "Spring Outreach", status: "completed" });
    expect(campaignDisplayStatus(row)).toBe("finished");
  });

  it.each(["finished", "active", "needs_attention", "paused"] as const)("lets a draft campaign defer to its sequence's own %s run", (displayStatus) => {
    const sequence = { id: "sequence-id", status: "published", displayStatus, statusReason: displayStatus === "needs_attention" ? "sending_disabled" as const : null, completedAt: displayStatus === "finished" ? "2026-10-05T09:00:00.000Z" : null, activeCount: 0 };
    const row = withCampaignStatus(sequence, { id: "campaign-id", sequenceId: sequence.id, name: "Never launched", status: "draft", displayStatus: "draft", statusReason: null, completedAt: null });
    expect(row).toMatchObject({ campaignId: "campaign-id", status: "draft", displayStatus, statusReason: sequence.statusReason, completedAt: sequence.completedAt });
    expect(campaignDisplayStatus(row)).toBe(displayStatus);
  });

  it("keeps a draft campaign reading as draft when its sequence has no run of its own", () => {
    const row = withCampaignStatus({ id: "sequence-id", status: "published", displayStatus: "draft" as const, activeCount: 0 }, { id: "campaign-id", sequenceId: "sequence-id", name: "Never launched", status: "draft", displayStatus: "draft" });
    expect(campaignDisplayStatus(row)).toBe("draft");
  });

  it("preserves a sequence-only campaign's status", () => {
    expect(withCampaignStatus({ id: "sequence-id", status: "paused" })).toEqual({ id: "sequence-id", status: "paused", campaignId: undefined, newLeadsReady: 0 });
  });
});

// The action bar's Resume/Pause/Publish remount the editor; this decides whether they save first.
describe("unsaved campaign edits", () => {
  const saved = { name: "Batch 1", description: "UAE", steps: [{ id: "s1", delayDays: 0, subject: "Hi", body: "One" }, { id: "s3", delayDays: 5, subject: "Re: Hi", body: "Last" }] };

  it("reads unchanged copy as saved, including a missing description", () => {
    expect(hasUnsavedContent(saved, { ...saved, steps: saved.steps.map((step) => ({ ...step })) })).toBe(false);
    expect(hasUnsavedContent({ ...saved, description: undefined }, { ...saved, description: "" })).toBe(false);
    expect(hasUnsavedContent(null, saved)).toBe(false);
  });

  it.each([
    ["a reworded body", { steps: [saved.steps[0]!, { ...saved.steps[1]!, body: "New last" }] }],
    ["a new wait", { steps: [saved.steps[0]!, { ...saved.steps[1]!, delayDays: 4 }] }],
    ["an added step", { steps: [...saved.steps, { id: "local-1", delayDays: 3, subject: "Re: Hi", body: "Extra" }] }],
    ["a renamed campaign", { name: "Batch 1b" }],
  ])("flags %s", (_label, change) => {
    expect(hasUnsavedContent(saved, { ...saved, ...change })).toBe(true);
  });
});
