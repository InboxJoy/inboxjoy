import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { campaignDisplayStatus, campaignDisplayStatuses, reconcileCampaignStatus } from "../src/campaign-status.js";

const activeInput = { status: "active", sendingEnabled: true, sequenceStatus: "active", inProgress: 2, mailboxPaused: 0, failurePaused: 0 };

describe("campaign display status", () => {
  it.each(["draft", "paused", "archived", "completed"])("maps stored %s without attention reasons", (status) => {
    expect(campaignDisplayStatus({ ...activeInput, status, sendingEnabled: false })).toEqual({ displayStatus: status === "completed" ? "finished" : status, statusReason: null });
  });

  it("prioritizes sending disabled over sequence and mailbox reasons", () => {
    expect(campaignDisplayStatus({ ...activeInput, sendingEnabled: false, sequenceStatus: "draft", mailboxPaused: 2 })).toEqual({ displayStatus: "needs_attention", statusReason: "sending_disabled" });
  });

  it("prioritizes the inactive sequence over mailbox reasons", () => {
    expect(campaignDisplayStatus({ ...activeInput, sequenceStatus: "paused", failurePaused: 1 }).statusReason).toBe("sequence_paused");
  });

  it("shows a legacy sequence pause without an attention reason", () => {
    expect(campaignDisplayStatus({ ...activeInput, sequenceStatus: "paused" })).toEqual({ displayStatus: "paused", statusReason: null });
  });

  it("shows an archived sequence as archived", () => {
    expect(campaignDisplayStatus({ ...activeInput, sequenceStatus: "archived" })).toEqual({ displayStatus: "archived", statusReason: null });
  });

  it("shows mailbox reconnect when every enrollment is auth-paused", () => {
    expect(campaignDisplayStatus({ ...activeInput, mailboxPaused: 2 }).statusReason).toBe("mailbox_reconnect_required");
  });

  it.each([{ mailboxPaused: 0, failurePaused: 2 }, { mailboxPaused: 1, failurePaused: 1 }])("shows provider failure for failures or mixed system pauses", (counts) => {
    expect(campaignDisplayStatus({ ...activeInput, ...counts }).statusReason).toBe("sending_failed_repeatedly");
  });

  it.each([{ inProgress: 0, mailboxPaused: 0 }, { inProgress: 2, mailboxPaused: 1 }])("stays active with no leads or a lead still progressing", (counts) => {
    expect(campaignDisplayStatus({ ...activeInput, ...counts })).toEqual({ displayStatus: "active", statusReason: null });
  });

  it.each([
    { workspaceStatus: "paused", killSwitch: false, subscription: "active" },
    { workspaceStatus: "active", killSwitch: true, subscription: "active" },
    { workspaceStatus: "active", killSwitch: false, subscription: null },
    { workspaceStatus: "active", killSwitch: false, subscription: "cancelled" },
  ])("reuses workspace and entitlement checks in a fixed number of queries", async ({ workspaceStatus, killSwitch, subscription }) => {
    const execute = vi.fn().mockResolvedValueOnce({ rows: [{ status: workspaceStatus, kill_switch_enabled: killSwitch, subscription_status: subscription, trial_end: null, grace_ends_at: null }] })
      .mockResolvedValueOnce({ rows: [{ id: "sequence", status: "active" }] }).mockResolvedValueOnce({ rows: [] });
    const campaigns = Array.from({ length: 40 }, (_, index) => ({ id: `campaign-${index}`, sequenceId: "sequence", status: "active" }));
    const result = await campaignDisplayStatuses({ execute } as never, "workspace", campaigns, "cloud");
    expect(execute).toHaveBeenCalledTimes(3);
    expect([...result.values()].every((status) => status.statusReason === "sending_disabled")).toBe(true);
    for (const [statement] of execute.mock.calls) expect(new PgDialect().sqlToQuery(statement).params).toContain("workspace");
  });

  it("does not query for an empty list or for draft and archived campaigns", async () => {
    const execute = vi.fn();
    expect(await campaignDisplayStatuses({ execute } as never, "workspace", [], "cloud")).toEqual(new Map());
    const result = await campaignDisplayStatuses({ execute } as never, "workspace", [{ id: "new", sequenceId: "sequence", status: "draft" }, { id: "old", sequenceId: "sequence", status: "archived" }], "cloud");
    expect([result.get("new")?.displayStatus, result.get("old")?.displayStatus]).toEqual(["draft", "archived"]);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { sequenceStatus: "active", status: "completed", displayStatus: "finished" },
    { sequenceStatus: "archived", status: "completed", displayStatus: "archived" },
    { sequenceStatus: "archived", status: "paused", displayStatus: "archived" },
    { sequenceStatus: "paused", status: "completed", displayStatus: "finished" },
  ])("reads a $status campaign on a $sequenceStatus sequence as $displayStatus with one workspace-scoped query", async ({ sequenceStatus, status, displayStatus }) => {
    const execute = vi.fn().mockResolvedValueOnce({ rows: [{ id: "sequence", status: sequenceStatus }] });
    expect((await campaignDisplayStatuses({ execute } as never, "workspace", [{ id: "campaign", sequenceId: "sequence", status }], "cloud")).get("campaign")).toEqual({ displayStatus, statusReason: null });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(new PgDialect().sqlToQuery(execute.mock.calls[0]![0]).params).toContain("workspace");
  });

  it.each([
    { subscription: "active", trialEnd: null, graceEndsAt: null },
    { subscription: "trialing", trialEnd: new Date("2999-01-01T00:00:00Z"), graceEndsAt: null },
    { subscription: "on_hold", trialEnd: null, graceEndsAt: new Date("2999-01-01T00:00:00Z") },
    { subscription: "trialing", trialEnd: "2999-01-01T00:00:00Z", graceEndsAt: null },
    { subscription: "on_hold", trialEnd: null, graceEndsAt: "2999-01-01T00:00:00Z" },
  ])("recognizes sending entitlements from the shared helper", async ({ subscription, trialEnd, graceEndsAt }) => {
    const execute = vi.fn().mockResolvedValueOnce({ rows: [{ status: "active", kill_switch_enabled: false, subscription_status: subscription, trial_end: trialEnd, grace_ends_at: graceEndsAt }] })
      .mockResolvedValueOnce({ rows: [{ id: "sequence", status: "active" }] }).mockResolvedValueOnce({ rows: [] });
    expect((await campaignDisplayStatuses({ execute } as never, "workspace", [{ id: "campaign", sequenceId: "sequence", status: "active" }], "cloud")).get("campaign")).toEqual({ displayStatus: "active", statusReason: null });
  });

  const displayFor = async (edition: "cloud" | "selfhost", workspace: Record<string, unknown>) => {
    const execute = vi.fn().mockResolvedValueOnce({ rows: [{ status: "active", kill_switch_enabled: false, subscription_status: null, trial_end: null, grace_ends_at: null, legacy_free_until: null, month_sends: "0", ...workspace }] })
      .mockResolvedValueOnce({ rows: [{ id: "sequence", status: "active" }] }).mockResolvedValueOnce({ rows: [] });
    return (await campaignDisplayStatuses({ execute } as never, "workspace", [{ id: "campaign", sequenceId: "sequence", status: "active" }], edition)).get("campaign");
  };

  it("needs attention for an unlicensed cloud workspace and stays active once licensed", async () => {
    expect(await displayFor("cloud", {})).toEqual({ displayStatus: "needs_attention", statusReason: "sending_disabled" });
    expect(await displayFor("cloud", { subscription_status: "refunded" })).toEqual({ displayStatus: "needs_attention", statusReason: "sending_disabled" });
    expect(await displayFor("cloud", { subscription_status: "active" })).toEqual({ displayStatus: "active", statusReason: null });
  });

  it("keeps legacy Free active until its monthly cap or its window runs out", async () => {
    const future = "2999-01-01T00:00:00Z";
    expect(await displayFor("cloud", { legacy_free_until: future, month_sends: "9999" })).toEqual({ displayStatus: "active", statusReason: null });
    expect(await displayFor("cloud", { legacy_free_until: future, month_sends: "10000" })).toEqual({ displayStatus: "needs_attention", statusReason: "sending_disabled" });
    expect(await displayFor("cloud", { legacy_free_until: "2000-01-01T00:00:00Z", month_sends: "0" })).toEqual({ displayStatus: "needs_attention", statusReason: "sending_disabled" });
  });

  it("treats every self-hosted workspace as entitled, but keeps the workspace switches", async () => {
    expect(await displayFor("selfhost", { month_sends: "50000" })).toEqual({ displayStatus: "active", statusReason: null });
    expect(await displayFor("selfhost", { kill_switch_enabled: true })).toEqual({ displayStatus: "needs_attention", statusReason: "sending_disabled" });
  });
});

describe("campaign reconciliation executors", () => {
  it("uses a database transaction and execute, not Drizzle's relational query property", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const transaction = vi.fn(async (work) => work({ execute, query: {} }));
    expect(await reconcileCampaignStatus({ $client: {}, execute, query: {}, transaction } as never, { workspaceId: "workspace", campaignId: "campaign" })).toBeNull();
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("keeps an existing transaction instead of opening a savepoint", async () => {
    const transaction = vi.fn();
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    await reconcileCampaignStatus({ execute, query: {}, transaction } as never, { workspaceId: "workspace", campaignId: "campaign" });
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each(["draft", "paused", "archived"])("never finishes a %s campaign on a late terminal event", async (status) => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "campaign", name: "Campaign", status, launched_at: new Date(), completed_at: null }] });
    expect(await reconcileCampaignStatus({ query }, { workspaceId: "workspace", campaignId: "campaign" })).toMatchObject({ status, change: null });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("normalizes Drizzle's raw timestamp strings on restart and does not clear completed_at", async () => {
    const completedAt = "2026-10-01T10:00:00.000Z";
    const execute = vi.fn().mockResolvedValueOnce({ rows: [{ id: "campaign", name: "Campaign", status: "completed", launched_at: completedAt, completed_at: completedAt }] })
      .mockResolvedValueOnce({ rows: [{ count: "2" }] }).mockResolvedValue({ rows: [] });
    const result = await reconcileCampaignStatus({ execute } as never, { workspaceId: "workspace", campaignId: "campaign", allowRestart: true });
    expect(result).toMatchObject({ change: "restarted", previousCompletedAt: new Date(completedAt) });
    const statements = execute.mock.calls.map(([statement]) => new PgDialect().sqlToQuery(statement).sql);
    expect(statements.find((statement) => statement.includes("UPDATE campaigns"))).not.toContain("completed_at");
  });

  it("leaves a finished campaign with leftover in-progress leads finished unless an enrollment asks for the restart", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: "campaign", name: "Campaign", status: "completed", launched_at: new Date(), completed_at: new Date() }] })
      .mockResolvedValueOnce({ rows: [{ count: "3" }] }).mockResolvedValue({ rows: [] });
    expect(await reconcileCampaignStatus({ query }, { workspaceId: "workspace", campaignId: "campaign" })).toMatchObject({ status: "completed", change: null });
    expect(query.mock.calls.some(([text]) => String(text).includes("UPDATE campaigns") || String(text).includes("INSERT INTO notifications"))).toBe(false);
  });

  it("changes status without a notification when asked to stay quiet", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: "campaign", name: "Campaign", status: "active", launched_at: new Date(), completed_at: null }] })
      .mockResolvedValueOnce({ rows: [{ count: "0" }] }).mockResolvedValue({ rows: [] });
    expect(await reconcileCampaignStatus({ query }, { workspaceId: "workspace", campaignId: "campaign", notify: false })).toMatchObject({ status: "completed", change: "finished" });
    expect(query.mock.calls.some(([text]) => String(text).includes("UPDATE campaigns"))).toBe(true);
    expect(query.mock.calls.some(([text]) => String(text).includes("INSERT INTO notifications"))).toBe(false);
  });
});
