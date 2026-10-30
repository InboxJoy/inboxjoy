import { createServer, type Server } from "node:http";

export type HealthState = {
  ready: boolean;
  startedAt: string;
  lastHeartbeatAt?: string;
  lastHeartbeatProcessedAt?: string;
  lastDbCheckAt?: string;
  lastQueueCheckAt?: string;
  deadLetteredJobs?: number;
  draining: boolean;
};

export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEALTH_FRESH_MS = 90_000;

function isFresh(value: string | undefined, now: number): boolean {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && now - timestamp <= HEALTH_FRESH_MS;
}

export function isHealthReady(state: HealthState, now = Date.now()): boolean {
  const startedAt = new Date(state.startedAt).getTime();
  const awaitingFirstProcessedHeartbeat = !state.lastHeartbeatProcessedAt
    && Number.isFinite(startedAt)
    && now - startedAt <= HEALTH_FRESH_MS + HEARTBEAT_INTERVAL_MS;

  return state.ready
    && !state.draining
    && isFresh(state.lastHeartbeatAt, now)
    && (isFresh(state.lastHeartbeatProcessedAt, now) || awaitingFirstProcessedHeartbeat)
    && isFresh(state.lastDbCheckAt, now)
    && isFresh(state.lastQueueCheckAt, now);
}

export function shouldSendDeadLetterAlert(previousCount: number, count: number, lastAlertAt: number, now = Date.now()): boolean {
  return previousCount === 0 && count > 0 && now - lastAlertAt >= 3_600_000;
}

// Combines the configured WORKER_ID with the process's hostname and pid so two
// replicas sharing one WORKER_ID env var still get distinct ids. In Docker each
// replica is its own container with its own hostname, so this is enough to give
// `worker_heartbeats` one row per live worker instead of every replica fighting
// over a single row. The configured value stays as a readable prefix for logs.
export function buildWorkerId(configuredId: string, hostname: string, pid: number): string {
  return `${configuredId}-${hostname}-${pid}`;
}

export type HeartbeatQueryable = {
  query: (text: string) => Promise<{ rows: Array<{ last_job_at: string | Date | null }> }>;
};

// Readiness must not depend on *this* replica having won the heartbeat race:
// with N replicas polling the same pg-boss queue, only one dequeues any given
// heartbeat job, so a purely in-process "did I process a heartbeat" check goes
// stale on every replica but one. Instead this asks whether ANY worker recorded
// activity recently, via a cheap bounded aggregate over the existing
// worker_heartbeats table (one row per live worker once ids are unique) — the
// same "is some worker alive" signal apps/api's own /ready check already uses.
export async function fetchLatestClusterHeartbeatAt(pool: HeartbeatQueryable): Promise<string | undefined> {
  const result = await pool.query("SELECT max(last_job_at) AS last_job_at FROM worker_heartbeats");
  const value = result.rows[0]?.last_job_at;
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

// Only ever advances lastHeartbeatProcessedAt, never regresses it — the local
// heartbeat job handler already sets it to "now" when this replica happens to
// process one, and a slightly-lagging cluster poll should not undo that.
export function applyClusterHeartbeat(state: HealthState, latestIso: string | undefined): void {
  if (!latestIso) return;
  const next = new Date(latestIso).getTime();
  if (!Number.isFinite(next)) return;
  const current = state.lastHeartbeatProcessedAt ? new Date(state.lastHeartbeatProcessedAt).getTime() : -Infinity;
  if (next > current) {
    state.lastHeartbeatProcessedAt = latestIso;
  }
}

export function createHealthServer(state: HealthState, port: number): Server {
  const server = createServer((request, response) => {
    if (request.url === "/live") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    if (request.url === "/ready") {
      const ready = isHealthReady(state);
      response.writeHead(ready ? 200 : 503, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify({ ...state, fresh: ready }));
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });

  server.listen(port);
  return server;
}
