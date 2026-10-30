import type { HeartbeatJob } from "@inboxjoy/queue";
import type { Pool } from "pg";

import type { HealthState } from "../health.js";
import { logger } from "../logger.js";

type Dependencies = { health: HealthState; pool: Pool };

export async function heartbeat(payload: HeartbeatJob, deps: Dependencies): Promise<void> {
  const processedAt = new Date().toISOString();
  await deps.pool.query(`
    INSERT INTO worker_heartbeats (worker_id, last_seen_at, last_job_at)
    VALUES ($1, now(), now())
    ON CONFLICT (worker_id) DO UPDATE SET
      last_seen_at = EXCLUDED.last_seen_at,
      last_job_at = EXCLUDED.last_job_at
  `, [payload.workerId]);
  deps.health.lastHeartbeatProcessedAt = processedAt;
  logger.info("Worker heartbeat received", {
    job: "heartbeat",
    workerId: payload.workerId,
    startedAt: payload.startedAt,
    beatAt: payload.beatAt,
    processedAt
  });
}
