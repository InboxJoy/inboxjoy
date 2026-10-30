import { describe, expect, it, vi } from "vitest";

import { OpError, runStagedConversionGroups, type ConversionAttemptResult, type StagedGroup } from "../src/index.js";

function okResult(leadIds: string[]): ConversionAttemptResult {
  return { enrolled: leadIds.length, leadIds, skipped: {}, skippedLeadIds: {}, restarted: false };
}

// Queue rows are never removed up front (an enrolled lead's row goes in its enrollment
// transaction), so the only queue write this control flow makes is dropping leads that will
// never convert. Everything else stays queued by doing nothing.
describe("runStagedConversionGroups", () => {
  it("rethrows an unexpected (non-OpError) failure without touching the queue", async () => {
    const groupA: StagedGroup = { campaignId: null, inboxIds: null, leadIds: ["a1", "a2"] };
    const groupB: StagedGroup = { campaignId: null, inboxIds: null, leadIds: ["b1"] };
    const attempt = vi.fn(async (group: StagedGroup) => {
      if (group === groupA) throw new Error("unexpected boom");
      return okResult(group.leadIds);
    });
    const drop = vi.fn(async () => {});
    const activate = vi.fn(async () => {});

    await expect(runStagedConversionGroups([groupA, groupB], { attempt, drop, activate })).rejects.toThrow("unexpected boom");

    // groupB was never attempted, and neither group lost a queue row.
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(drop).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
  });

  it("leaves an OpError-blocked group queued and still attempts the rest", async () => {
    const groupA: StagedGroup = { campaignId: null, inboxIds: null, leadIds: ["a1"] };
    const groupB: StagedGroup = { campaignId: null, inboxIds: null, leadIds: ["b1"] };
    const attempt = vi.fn(async (group: StagedGroup) => {
      if (group === groupA) throw new OpError("CONFLICT", "no sendable mailbox");
      return okResult(group.leadIds);
    });
    const drop = vi.fn(async () => {});
    const activate = vi.fn(async () => {});

    const results = await runStagedConversionGroups([groupA, groupB], { attempt, drop, activate });

    expect(attempt).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ blocked: true, error: { code: "CONFLICT" } });
    expect(results[1]).toMatchObject({ enrolled: 1, leadIds: ["b1"] });
    expect(drop).not.toHaveBeenCalled();
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it("drops permanently-skipped leads but keeps enrolled and transiently-skipped ones out of the drop", async () => {
    const group: StagedGroup = { campaignId: "camp", inboxIds: null, leadIds: ["enrolled-1", "transient-1", "waiting-1", "permanent-1"] };
    const attempt = vi.fn(async (): Promise<ConversionAttemptResult> => ({
      enrolled: 1,
      leadIds: ["enrolled-1"],
      skipped: { replied: 1, missing_variables: 1, suppressed: 1 },
      skippedLeadIds: { replied: ["transient-1"], missing_variables: ["waiting-1"], suppressed: ["permanent-1"] },
      restarted: false,
    }));
    const dropped: string[][] = [];
    const drop = vi.fn(async (_group: StagedGroup, leadIds: string[]) => { dropped.push(leadIds); });
    const activate = vi.fn(async () => {});

    await runStagedConversionGroups([group], { attempt, drop, activate });

    expect(dropped).toEqual([["permanent-1"]]);
  });

  it("activates before dropping, and an activation failure leaves the rest queued for a retry", async () => {
    const group: StagedGroup = { campaignId: "camp", inboxIds: null, leadIds: ["enrolled-1", "permanent-1"] };
    const attempt = vi.fn(async (): Promise<ConversionAttemptResult> => ({
      enrolled: 1,
      leadIds: ["enrolled-1"],
      skipped: { suppressed: 1 },
      skippedLeadIds: { suppressed: ["permanent-1"] },
      restarted: false,
    }));
    const drop = vi.fn(async () => {});
    const activate = vi.fn(async () => { throw new Error("activation boom"); });

    await expect(runStagedConversionGroups([group], { attempt, drop, activate })).rejects.toThrow("activation boom");
    expect(drop).not.toHaveBeenCalled();
  });

  it("returns a result per group and never calls drop when nothing needs it", async () => {
    const group: StagedGroup = { campaignId: null, inboxIds: ["mailbox-1"], leadIds: ["x1", "x2"] };
    const attempt = vi.fn(async () => okResult(["x1", "x2"]));
    const drop = vi.fn(async () => {});
    const activate = vi.fn(async () => {});

    const results = await runStagedConversionGroups([group], { attempt, drop, activate });

    expect(results).toEqual([{ enrolled: 2, leadIds: ["x1", "x2"], skipped: {}, skippedLeadIds: {}, restarted: false }]);
    expect(drop).not.toHaveBeenCalled();
    expect(activate).toHaveBeenCalledWith(group, results[0]);
  });
});
