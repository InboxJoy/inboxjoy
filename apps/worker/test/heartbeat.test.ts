import { describe, expect, it, vi } from "vitest";

import type { HealthState } from "../src/health.js";
import { heartbeat } from "../src/jobs/heartbeat.js";

describe("heartbeat job", () => {
  it("records the consumed heartbeat in worker state and the database", async () => {
    const health: HealthState = {
      ready: true,
      draining: false,
      startedAt: "2026-09-17T00:00:00.000Z",
    };
    const pool = { query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [] }) };

    await heartbeat({
      workerId: "worker-test",
      startedAt: "2026-09-17T00:00:00.000Z",
      beatAt: "2026-09-17T00:00:30.000Z",
    }, { health, pool: pool as never });

    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO worker_heartbeats"), ["worker-test"]);
    expect(health.lastHeartbeatProcessedAt).toEqual(expect.any(String));
  });
});
