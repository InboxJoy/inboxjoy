import { schema } from "@inboxjoy/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/index.js", () => {
  class OpError extends Error {
    constructor(public code: string, message: string, public details?: unknown) {
      super(message);
    }
  }
  return { OpError, enrollSequence: vi.fn() };
});
vi.mock("../src/sequence-mailboxes.js", () => ({ readSequenceMailboxIds: vi.fn() }));

import { enrollNewListLeads } from "../src/enroll-new-list-leads.js";
import { enrollSequence, OpError, type OperationContext } from "../src/index.js";
import { readSequenceMailboxIds } from "../src/sequence-mailboxes.js";

describe("automatic list enrollment failure boundaries", () => {
  let campaigns: Array<{ id: string; name: string; status: string; sequenceId: string; emailAccountId: string | null }>;
  let sequenceStatus: string;
  let listExists: boolean;
  let context: OperationContext;
  const leadIds = ["new-lead"];

  beforeEach(() => {
    vi.resetAllMocks();
    campaigns = [{ id: "campaign", name: "Outreach", status: "completed", sequenceId: "sequence", emailAccountId: "legacy-mailbox" }];
    sequenceStatus = "active";
    listExists = true;
    const select = vi.fn(() => {
      let table: unknown;
      const query = {
        from: (value: unknown) => { table = value; return query; },
        where: () => query,
        limit: () => query,
        orderBy: () => query,
        then: (resolve: (rows: unknown[]) => unknown, reject?: (error: unknown) => unknown) => {
          const rows = table === schema.contactLists ? listExists ? [{ id: "list" }] : []
            : table === schema.campaigns ? campaigns
              : table === schema.sequences ? [{ status: sequenceStatus, currentVersionId: "version" }] : [];
          return Promise.resolve(rows).then(resolve, reject);
        },
      };
      return query;
    });
    context = { db: { select }, workspaceId: "workspace", userId: "owner", env: { edition: "selfhost", authSecret: "secret", apiBaseUrl: "https://example.test" }, logger: { info: vi.fn(), warn: vi.fn() } } as unknown as OperationContext;
    vi.mocked(readSequenceMailboxIds).mockResolvedValue(["saved-a", "saved-b"]);
    vi.mocked(enrollSequence).mockResolvedValue({ enrolled: 1, restarted: true } as Awaited<ReturnType<typeof enrollSequence>>);
  });

  it("passes only supplied leads and the campaign sender to shared enrollment, matching launch precedence", async () => {
    expect(await enrollNewListLeads(context, { listId: "list", leadIds: [...leadIds, ...leadIds] })).toEqual({ campaignUpdates: [{ campaignId: "campaign", name: "Outreach", enrolled: 1, restarted: true, blockedReason: null }] });
    expect(enrollSequence).toHaveBeenCalledWith(context, { id: "sequence", campaignId: "campaign", leadIds, inboxId: "legacy-mailbox" });
  });

  it("uses saved sequence senders when the campaign has no sender of its own", async () => {
    campaigns[0]!.emailAccountId = null;
    await enrollNewListLeads(context, { listId: "list", leadIds });
    expect(enrollSequence).toHaveBeenCalledWith(context, { id: "sequence", campaignId: "campaign", leadIds, inboxIds: ["saved-a", "saved-b"] });
  });

  it("prioritizes a paused campaign without attempting enrollment", async () => {
    campaigns[0]!.status = "paused";
    sequenceStatus = "archived";
    const result = await enrollNewListLeads(context, { listId: "list", leadIds });
    expect(result.campaignUpdates[0]).toMatchObject({ enrolled: 0, restarted: false, blockedReason: "campaign_paused" });
    expect(enrollSequence).not.toHaveBeenCalled();
  });

  it.each(["draft", "paused", "archived"])("blocks a %s sequence", async (status) => {
    sequenceStatus = status;
    expect((await enrollNewListLeads(context, { listId: "list", leadIds })).campaignUpdates[0]?.blockedReason).toBe("sequence_inactive");
    expect(enrollSequence).not.toHaveBeenCalled();
  });

  it.each([
    { code: "plan_limit", details: undefined, reason: "plan_limit" },
    { code: "FORBIDDEN", details: undefined, reason: "not_manager" },
    { code: "CONFLICT", details: { blockedReason: "no_sender" }, reason: "no_sender" },
    { code: "CONFLICT", details: { blockedReason: "sequence_inactive" }, reason: "sequence_inactive" },
    { code: "CONFLICT", details: { blockedReason: "campaign_paused" }, reason: "campaign_paused" },
    { code: "UNAVAILABLE", details: undefined, reason: "sending_disabled" },
    { code: "CONFLICT", details: undefined, reason: "sending_disabled" },
  ] as const)("returns $reason for an enrollment failure", async ({ code, details, reason }) => {
    vi.mocked(enrollSequence).mockRejectedValue(new OpError(code, "Blocked", details));
    expect((await enrollNewListLeads(context, { listId: "list", leadIds })).campaignUpdates[0]).toMatchObject({ enrolled: 0, restarted: false, blockedReason: reason });
  });

  it("logs unexpected errors and continues with the next campaign", async () => {
    campaigns.push({ ...campaigns[0]!, id: "next-campaign" });
    vi.mocked(enrollSequence).mockRejectedValueOnce(new Error("Unexpected database failure"));
    const result = await enrollNewListLeads(context, { listId: "list", leadIds });
    expect(result.campaignUpdates).toEqual([
      expect.objectContaining({ campaignId: "campaign", enrolled: 0, blockedReason: "sending_disabled" }),
      expect.objectContaining({ campaignId: "next-campaign", enrolled: 1, restarted: true, blockedReason: null }),
    ]);
    expect(context.logger?.warn).toHaveBeenCalled();
  });

  it("never propagates campaign lookup or logger failures", async () => {
    vi.mocked(context.db.select).mockImplementation(() => { throw new Error("Database unavailable"); });
    vi.mocked(context.logger!.warn!).mockImplementation(() => { throw new Error("Logger unavailable"); });
    await expect(enrollNewListLeads(context, { listId: "list", leadIds })).resolves.toEqual({ campaignUpdates: [] });
  });

  it("does nothing for a missing or foreign workspace list", async () => {
    listExists = false;
    expect(await enrollNewListLeads(context, { listId: "list", leadIds })).toEqual({ campaignUpdates: [] });
    expect(enrollSequence).not.toHaveBeenCalled();
  });
});
