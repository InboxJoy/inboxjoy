import { describe, expect, it, vi } from "vitest";
import { CAMPAIGN_STATUS_SWEEP_LIMIT, reconcileCampaignStatuses } from "../src/jobs/reconcile-campaign-statuses.js";

describe("campaign status sweep", () => {
  it("uses a bounded, workspace-correlated candidate query and does nothing with no candidates", async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }), connect: vi.fn() };
    await reconcileCampaignStatuses({ pool: pool as never });
    const [text, values] = pool.query.mock.calls[0]!;
    expect(text).toContain("NOT EXISTS");
    expect(text).toContain("e.workspace_id=c.workspace_id");
    expect(text).toContain("c.launched_at IS NOT NULL");
    expect(text).toContain("c.status='active'");
    expect(text).not.toContain("c.status IN ('active','paused')");
    expect(text).not.toContain("c.status='completed'");
    expect(values).toEqual([CAMPAIGN_STATUS_SWEEP_LIMIT]);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("finishes candidates quietly in individual transactions, never restarts, and skips failed campaigns", async () => {
    const clients = ["failed", "finished", "leftover"].map((id) => ({
      query: vi.fn(async (text: string) => {
        if (text.includes("FOR UPDATE")) {
          if (id === "failed") throw new Error("campaign locked");
          return { rows: [{ id, name: id, status: id === "finished" ? "active" : "completed", launched_at: new Date(), completed_at: new Date("2026-10-01T00:00:00Z") }] };
        }
        if (text.includes("count(*)")) return { rows: [{ count: id === "finished" ? "0" : "3" }] };
        return { rows: [] };
      }), release: vi.fn(),
    }));
    const pool = { query: vi.fn().mockResolvedValue({ rows: ["failed", "finished", "leftover"].map((id) => ({ id, workspace_id: "workspace" })) }), connect: vi.fn() };
    for (const client of clients) pool.connect.mockResolvedValueOnce(client);
    await reconcileCampaignStatuses({ pool: pool as never });
    expect(clients[0]!.query).toHaveBeenCalledWith("ROLLBACK");
    for (const client of clients.slice(1)) {
      expect(client.query).toHaveBeenCalledWith("COMMIT");
      expect(client.query.mock.calls.filter(([text]) => text.includes("INSERT INTO notifications"))).toHaveLength(0);
      expect(client.query.mock.calls.find(([text]) => text.includes("FOR UPDATE"))?.[1]).toEqual(["workspace", client === clients[1] ? "finished" : "leftover"]);
    }
    expect(clients[1]!.query.mock.calls.filter(([text]) => text.includes("UPDATE campaigns"))).toHaveLength(1);
    expect(clients[2]!.query.mock.calls.filter(([text]) => text.includes("UPDATE campaigns"))).toHaveLength(0);
    for (const client of clients) expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("skips a connection failure and continues with the next campaign", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ id: "first", workspace_id: "workspace" }, { id: "second", workspace_id: "workspace" }] }), connect: vi.fn().mockRejectedValueOnce(new Error("pool unavailable")).mockResolvedValueOnce(client) };
    await reconcileCampaignStatuses({ pool: pool as never });
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(client.query).toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
