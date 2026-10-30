import PgBoss from "pg-boss";
import { createDb, createPgPool } from "@inboxjoy/db";
import { createComposioClient } from "@inboxjoy/composio";
import { buildSecretKeyMap } from "@inboxjoy/core";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import {
  createQueue,
  deadLetterQueueNames,
  enqueueJob,
  getSendMessageDeadLetterCount,
  queueNames,
  scheduleRecurringJobs,
  startQueue,
  validateJobPayload
} from "@inboxjoy/queue";

import { loadEnv, resolveWorkerEdition } from "./env.js";
import { applyClusterHeartbeat, buildWorkerId, createHealthServer, fetchLatestClusterHeartbeatAt, HEARTBEAT_INTERVAL_MS, shouldSendDeadLetterAlert, type HealthState } from "./health.js";
import { processJobBatch } from "./job-batch.js";
import { BACKFILL_REPLIES_QUEUE_NAME, backfillReplies, parseBackfillRepliesJob } from "./jobs/backfill-replies.js";
import { heartbeat } from "./jobs/heartbeat.js";
import { processImport } from "./jobs/process-import.js";
import { pollImap } from "./jobs/poll-imap.js";
import { reconcileInbox } from "./jobs/reconcile-inbox.js";
import { RECONCILE_CAMPAIGN_STATUSES_QUEUE_NAME, reconcileCampaignStatuses } from "./jobs/reconcile-campaign-statuses.js";
import { refreshHealth } from "./jobs/refresh-health.js";
import { scheduleDueMessages } from "./jobs/schedule-due-messages.js";
import { sendMessage } from "./jobs/send-message.js";
import { logger } from "./logger.js";
import { createMailClientResolver } from "./mail-client.js";
import { createPostHogServer } from "./posthog.js";
import { transactionalEmailFromEnv } from "./transactional-email.js";

const env = loadEnv();
// Cloud gates campaign sends on the lifetime license; self-host is always entitled.
const edition = resolveWorkerEdition(env);
const transactionalEmail = transactionalEmailFromEnv(env);
const posthog = createPostHogServer(env);
// Two replicas share one WORKER_ID env var, so make each process's id unique
// (hostname is the container id in Docker) — see buildWorkerId in health.ts.
const workerId = buildWorkerId(env.WORKER_ID, hostname(), process.pid);
const startedAt = new Date().toISOString();
const health: HealthState = {
  ready: false,
  startedAt,
  draining: false
};

const queue = createQueue({
  connectionString: env.DATABASE_URL,
  applicationName: workerId,
  max: env.QUEUE_POOL_MAX,
});
const pool = createPgPool(env.DATABASE_URL, {
  max: env.DATABASE_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  applicationName: `${workerId}-app`,
});
const composio = createComposioClient(env.COMPOSIO_API_KEY, undefined, env.COMPOSIO_TOOLKIT_VERSION);
const mailboxCredentialsKeys = buildSecretKeyMap({ current: env.MAILBOX_CREDENTIALS_KEY, previous: env.MAILBOX_CREDENTIALS_KEY_PREVIOUS });
const mailClientResolver = createMailClientResolver({ db: createDb(pool), keys: mailboxCredentialsKeys, composio, allowPrivateHosts: env.SMTP_ALLOW_PRIVATE_HOSTS });

const healthServer = createHealthServer(health, env.WORKER_HEALTH_PORT);
let heartbeatTimer: NodeJS.Timeout | undefined;
let deadLetterTimer: NodeJS.Timeout | undefined;
let healthCheckTimer: NodeJS.Timeout | undefined;
let lastDeadLetterAlertAt = 0;

async function work<Name extends keyof typeof handlers>(
  name: Name,
  jobs: PgBoss.Job<unknown>[]
): Promise<void> {
  await processJobBatch(jobs, {
    concurrency: env.WORKER_CONCURRENCY,
    run: async (job) => {
      const payload = validateJobPayload(name, job.data);
      await handlers[name](payload as never);
    },
    complete: (job) => queue.complete(name, job.id),
    fail: async (job, error) => {
      logger.error("Job failed", {
        queue: name,
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
      posthog.captureException(error, { job: name, jobId: job.id, workerId });
      await queue.fail(name, job.id, {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    },
  });
}

async function workBackfillReplies(jobs: PgBoss.Job<unknown>[]): Promise<void> {
  await processJobBatch(jobs, {
    concurrency: 1,
    run: async (job) => {
      const payload = parseBackfillRepliesJob(job.data);
      await backfillReplies(payload, {
        pool,
        composioApiKey: env.COMPOSIO_API_KEY,
        toolkitVersion: env.COMPOSIO_TOOLKIT_VERSION,
        mailClientFor: mailClientResolver.getMailClientFor,
      });
    },
    complete: (job) => queue.complete(BACKFILL_REPLIES_QUEUE_NAME, job.id),
    fail: async (job, error) => {
      logger.error("Job failed", {
        queue: BACKFILL_REPLIES_QUEUE_NAME,
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
      posthog.captureException(error, { job: BACKFILL_REPLIES_QUEUE_NAME, jobId: job.id, workerId });
      await queue.fail(BACKFILL_REPLIES_QUEUE_NAME, job.id, {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    },
  });
}

const handlers = {
  [queueNames.scheduleDueMessages]: (payload: any) => scheduleDueMessages(payload, { pool, queue, edition, transactionalEmail }),
  [queueNames.sendMessage]: (payload: any) => sendMessage(payload, { pool, composio, mailClientFor: mailClientResolver.getMailClientFor, composioApiKey: env.COMPOSIO_API_KEY, toolkitVersion: env.COMPOSIO_TOOLKIT_VERSION, apiBaseUrl: env.API_BASE_URL, authSecret: env.AUTH_SECRET, edition, transactionalEmail }),
  [queueNames.reconcileInbox]: (payload: any) => reconcileInbox(payload, { pool, composio, mailClientFor: mailClientResolver.getMailClientFor, composioApiKey: env.COMPOSIO_API_KEY, toolkitVersion: env.COMPOSIO_TOOLKIT_VERSION, apiBaseUrl: env.API_BASE_URL, authSecret: env.AUTH_SECRET }),
  [queueNames.processImport]: processImport,
  [queueNames.refreshHealth]: (payload: any) => refreshHealth(payload, { pool, transactionalEmail }),
  [queueNames.pollImap]: (payload: Parameters<typeof pollImap>[0]) => pollImap(payload, { pool, smtpMailboxesEnabled: env.SMTP_MAILBOXES_ENABLED, allowPrivateHosts: env.SMTP_ALLOW_PRIVATE_HOSTS, keys: mailboxCredentialsKeys }),
  [queueNames.heartbeat]: (payload: any) => heartbeat(payload, { health, pool })
};

async function registerWorkers(): Promise<void> {
  await Promise.all(
    [...Object.keys(handlers).map((name) =>
      queue.work(
        name,
        { batchSize: env.WORKER_CONCURRENCY, includeMetadata: true },
        (jobs) => work(name as keyof typeof handlers, jobs)
      )
    ), queue.work(
      BACKFILL_REPLIES_QUEUE_NAME,
      { batchSize: 1, includeMetadata: true },
      workBackfillReplies,
    ), queue.work(
      RECONCILE_CAMPAIGN_STATUSES_QUEUE_NAME,
      { batchSize: 1, includeMetadata: true },
      async (jobs) => processJobBatch(jobs, {
        concurrency: 1,
        run: () => reconcileCampaignStatuses({ pool }),
        complete: (job) => queue.complete(RECONCILE_CAMPAIGN_STATUSES_QUEUE_NAME, job.id),
        fail: (job, error) => queue.fail(RECONCILE_CAMPAIGN_STATUSES_QUEUE_NAME, job.id, { message: error instanceof Error ? error.message : String(error) }),
      }),
    )]
  );
}

function startHeartbeat(): void {
  heartbeatTimer = setInterval(() => {
    const beatAt = new Date().toISOString();

    void enqueueJob(queue, queueNames.heartbeat, {
      workerId,
      startedAt,
      beatAt
    }).then(() => {
      health.lastHeartbeatAt = beatAt;
      health.lastQueueCheckAt = beatAt;
    }).catch((error: unknown) => {
      logger.warn("Failed to enqueue heartbeat", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }, HEARTBEAT_INTERVAL_MS);
}

async function refreshDeadLetterCount(): Promise<void> {
  const count = await getSendMessageDeadLetterCount(queue);
  const previousCount = health.deadLetteredJobs ?? 0;
  health.lastQueueCheckAt = new Date().toISOString();
  health.deadLetteredJobs = count;
  if (count > 0) {
    logger.error("Send-message dead-letter queue is not empty", { count });
    await notifyDeadLetteredSends();
  }
  if (shouldSendDeadLetterAlert(previousCount, count, lastDeadLetterAlertAt)) {
    await alertFounderAboutDeadLetters(count);
  }
}

async function alertFounderAboutDeadLetters(count: number): Promise<void> {
  const now = Date.now();
  if (!env.FOUNDER_ALERT_EMAIL || !transactionalEmail.enabled) return;
  lastDeadLetterAlertAt = now;
  try {
    await transactionalEmail.sendSequenceTest({
      recipient: { email: env.FOUNDER_ALERT_EMAIL },
      subject: `InboxJoy: ${count} send jobs dead-lettered`,
      plainText: `${count} send job${count === 1 ? " has" : "s have"} entered the dead-letter queue. Review the worker logs.`,
    });
  } catch (error) {
    logger.error("Failed to send founder dead-letter alert", {
      count,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function notifyDeadLetteredSends(): Promise<void> {
  try {
    const affected = await pool.query<{ workspace_id: string; count: string }>(`
      SELECT (j.data->>'workspaceId')::uuid AS workspace_id,count(*)::text AS count
      FROM pgboss.job j
      WHERE j.name=$1 AND j.state::text IN ('created','retry','active')
        AND (j.data->>'workspaceId') ~* '^[0-9a-f-]{36}$'
      GROUP BY (j.data->>'workspaceId')::uuid
    `, [deadLetterQueueNames.sendMessage]);
    for (const row of affected.rows) {
      await pool.query(`INSERT INTO notifications (id,workspace_id,type,title,body)
        SELECT $1,$2,'send_dead_letter','Sending needs attention',$3
        WHERE NOT EXISTS (
          SELECT 1 FROM notifications WHERE workspace_id=$2 AND type='send_dead_letter' AND read_at IS NULL
        )`, [randomUUID(), row.workspace_id, `${row.count} send-message job${row.count === "1" ? " is" : "s are"} in the dead-letter queue. Review worker logs before resuming sends.`]);
    }
  } catch (error) {
    logger.warn("Failed to create dead-letter notifications", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function refreshDbCheck(): Promise<void> {
  await pool.query("SELECT 1");
  health.lastDbCheckAt = new Date().toISOString();
}

// Cluster-wide readiness signal: rather than requiring this replica to have
// personally dequeued and processed a heartbeat job (which starves whichever
// replica loses the pg-boss race), ask whether ANY worker recorded one
// recently. That is a genuine "the queue is actually draining" check and it
// makes every replica's /ready reflect the fleet, not a coin flip.
async function refreshClusterHeartbeat(): Promise<void> {
  const latest = await fetchLatestClusterHeartbeatAt(pool);
  applyClusterHeartbeat(health, latest);
}

function startHealthChecks(): void {
  healthCheckTimer = setInterval(() => {
    void refreshDbCheck().catch((error: unknown) => {
      logger.warn("Worker database health check failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    void refreshClusterHeartbeat().catch((error: unknown) => {
      logger.warn("Failed to refresh cluster heartbeat freshness", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, 30_000);
}

function startDeadLetterMonitor(): void {
  deadLetterTimer = setInterval(() => {
    void refreshDeadLetterCount().catch((error: unknown) => {
      logger.warn("Failed to read dead-letter count", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, 30_000);
}

async function shutdown(signal: string): Promise<void> {
  if (health.draining) {
    return;
  }

  health.draining = true;
  health.ready = false;
  logger.info("Worker is draining", { signal });

  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }
  if (deadLetterTimer) {
    clearInterval(deadLetterTimer);
  }
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
  }

  await queue.stop({ graceful: true, timeout: 30_000 });
  mailClientResolver.close();
  await pool.end();
  await posthog.shutdown();

  await new Promise<void>((resolve) => {
    healthServer.close(() => resolve());
  });

  logger.info("Worker stopped", { signal });
}

async function main(): Promise<void> {
  queue.on("error", (error) => {
    logger.error("Queue error", {
      error: error instanceof Error ? error.message : String(error)
    });
  });

  await startQueue(queue);
  await queue.createQueue(BACKFILL_REPLIES_QUEUE_NAME, {
    name: BACKFILL_REPLIES_QUEUE_NAME,
    retryLimit: 5,
    retryDelay: 30,
    retryBackoff: true,
  });
  await scheduleRecurringJobs(queue);
  await queue.createQueue(RECONCILE_CAMPAIGN_STATUSES_QUEUE_NAME, { name: RECONCILE_CAMPAIGN_STATUSES_QUEUE_NAME, retryLimit: 3, retryDelay: 30, retryBackoff: true });
  await queue.schedule(RECONCILE_CAMPAIGN_STATUSES_QUEUE_NAME, "*/5 * * * *", {}, { tz: "UTC" });
  await registerWorkers();
  await refreshDbCheck();
  await refreshDeadLetterCount();
  await refreshClusterHeartbeat().catch((error: unknown) => {
    logger.warn("Failed to refresh cluster heartbeat freshness", {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  health.ready = true;
  health.lastHeartbeatAt = new Date().toISOString();
  startHeartbeat();
  startDeadLetterMonitor();
  startHealthChecks();

  logger.info("Worker started", {
    workerId,
    healthPort: env.WORKER_HEALTH_PORT,
    concurrency: env.WORKER_CONCURRENCY
  });
}

function handleFatalError(error: unknown, type: "uncaughtException" | "unhandledRejection"): void {
  const normalized = error instanceof Error ? error : new Error(String(error));
  logger.error(`Worker ${type}`, {
    workerId,
    error: normalized.message,
    stack: normalized.stack,
  });
  posthog.captureException(normalized, { workerId, type });
  // Node's own default behaviour for an unhandled uncaughtException is to
  // crash; installing a handler here must not accidentally keep a corrupted
  // process alive, so flush telemetry (best-effort, bounded) and exit.
  void Promise.race([
    posthog.shutdown(),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]).finally(() => process.exit(1));
}

process.on("uncaughtException", (error) => handleFatalError(error, "uncaughtException"));
process.on("unhandledRejection", (reason) => handleFatalError(reason, "unhandledRejection"));

process.once("SIGINT", () => {
  void shutdown("SIGINT").then(() => process.exit(0));
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM").then(() => process.exit(0));
});

main().catch((error: unknown) => {
  logger.error("Worker failed to start", {
    error: error instanceof Error ? error.message : String(error)
  });
  posthog.captureException(error, { workerId, type: "startup" });
  void Promise.race([
    posthog.shutdown(),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]).finally(() => process.exit(1));
});
