import { describe, expect, it, vi } from "vitest";

import {
  applyClusterHeartbeat,
  buildWorkerId,
  fetchLatestClusterHeartbeatAt,
  HEALTH_FRESH_MS,
  HEARTBEAT_INTERVAL_MS,
  isHealthReady,
  shouldSendDeadLetterAlert,
  type HealthState
} from "../src/health.js";

describe("worker health", () => {
  it("requires fresh heartbeat, database, and queue checks for readiness", () => {
    const now = Date.now();
    const fresh = new Date(now).toISOString();
    const state: HealthState = {
      ready: true,
      draining: false,
      startedAt: fresh,
      lastHeartbeatAt: fresh,
      lastHeartbeatProcessedAt: fresh,
      lastDbCheckAt: fresh,
      lastQueueCheckAt: fresh,
    };

    expect(isHealthReady(state, now)).toBe(true);
    expect(isHealthReady({ ...state, lastQueueCheckAt: new Date(now - 120_000).toISOString() }, now)).toBe(false);
    expect(isHealthReady({ ...state, lastDbCheckAt: undefined }, now)).toBe(false);
  });

  it("allows startup grace, then rejects an enqueued heartbeat that was never processed", () => {
    const now = Date.now();
    const state: HealthState = {
      ready: true,
      draining: false,
      startedAt: new Date(now).toISOString(),
      lastHeartbeatAt: new Date(now).toISOString(),
      lastDbCheckAt: new Date(now).toISOString(),
      lastQueueCheckAt: new Date(now).toISOString(),
    };
    const afterGrace = now + HEALTH_FRESH_MS + HEARTBEAT_INTERVAL_MS + 1;

    expect(isHealthReady(state, now)).toBe(true);
    expect(isHealthReady({
      ...state,
      lastHeartbeatAt: new Date(afterGrace).toISOString(),
      lastDbCheckAt: new Date(afterGrace).toISOString(),
      lastQueueCheckAt: new Date(afterGrace).toISOString(),
    }, afterGrace)).toBe(false);
  });

  it("alerts only when dead letters rise from zero and the hourly cooldown has elapsed", () => {
    const now = Date.now();
    expect(shouldSendDeadLetterAlert(0, 3, 0, now)).toBe(true);
    expect(shouldSendDeadLetterAlert(3, 4, 0, now)).toBe(false);
    expect(shouldSendDeadLetterAlert(0, 2, now - 59 * 60_000, now)).toBe(false);
    expect(shouldSendDeadLetterAlert(0, 2, now - 60 * 60_000, now)).toBe(true);
  });

  it("combines the configured id with hostname and pid so two replicas sharing WORKER_ID stay distinct", () => {
    expect(buildWorkerId("worker-21", "docker-worker-1", 42)).toBe("worker-21-docker-worker-1-42");
    expect(buildWorkerId("worker-21", "docker-worker-2", 42)).not.toBe(buildWorkerId("worker-21", "docker-worker-1", 42));
  });

  it("stays ready when this replica lost the heartbeat race but another replica did not", () => {
    // Reproduces the production incident: two replicas share one queue, only one
    // of them dequeues a given heartbeat job, so worker-1's own
    // lastHeartbeatProcessedAt goes stale even though the fleet is healthy.
    const now = Date.now();
    const fresh = new Date(now).toISOString();
    const worker1: HealthState = {
      ready: true,
      draining: false,
      startedAt: new Date(now - 40 * 60_000).toISOString(),
      lastHeartbeatAt: fresh,
      lastHeartbeatProcessedAt: new Date(now - 38 * 60_000).toISOString(), // stale: this replica never wins the race
      lastDbCheckAt: fresh,
      lastQueueCheckAt: fresh,
    };

    expect(isHealthReady(worker1, now)).toBe(false);

    // worker-2 processed a heartbeat 10s ago — the cluster-wide check picks that up.
    applyClusterHeartbeat(worker1, new Date(now - 10_000).toISOString());

    expect(isHealthReady(worker1, now)).toBe(true);
  });

  it("never regresses lastHeartbeatProcessedAt when the cluster poll is stale or missing", () => {
    const now = Date.now();
    const state: HealthState = {
      ready: true,
      draining: false,
      startedAt: new Date(now).toISOString(),
      lastHeartbeatProcessedAt: new Date(now).toISOString(),
    };
    const before = state.lastHeartbeatProcessedAt;

    applyClusterHeartbeat(state, undefined);
    expect(state.lastHeartbeatProcessedAt).toBe(before);

    applyClusterHeartbeat(state, new Date(now - 60_000).toISOString());
    expect(state.lastHeartbeatProcessedAt).toBe(before);

    applyClusterHeartbeat(state, "not-a-date");
    expect(state.lastHeartbeatProcessedAt).toBe(before);
  });

  it("fetches the freshest heartbeat processed by any worker in the cluster", async () => {
    const iso = "2026-09-22T08:10:22.000Z";
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ last_job_at: iso }] }) };

    const result = await fetchLatestClusterHeartbeatAt(pool);

    expect(result).toBe(iso);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("FROM worker_heartbeats"));
  });

  it("returns undefined when the worker_heartbeats table has no rows yet", async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ last_job_at: null }] }) };

    expect(await fetchLatestClusterHeartbeatAt(pool)).toBeUndefined();
  });
});
