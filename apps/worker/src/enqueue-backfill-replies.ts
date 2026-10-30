import { createQueue, startQueue } from "@inboxjoy/queue";

import { loadEnv } from "./env.js";
import { BACKFILL_REPLIES_QUEUE_NAME, parseBackfillRepliesJob } from "./jobs/backfill-replies.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const payload = parseBackfillRepliesJob({
    ...(process.argv[2] ? { workspaceId: process.argv[2] } : {}),
    ...(process.argv[3] ? { limit: Number(process.argv[3]) } : {}),
  });
  const queue = createQueue({
    connectionString: env.DATABASE_URL,
    applicationName: `${env.WORKER_ID}-backfill-enqueue`,
    max: 2,
  });

  try {
    await startQueue(queue);
    await queue.createQueue(BACKFILL_REPLIES_QUEUE_NAME, {
      name: BACKFILL_REPLIES_QUEUE_NAME,
      retryLimit: 5,
      retryDelay: 30,
      retryBackoff: true,
    });
    const jobId = await queue.send(BACKFILL_REPLIES_QUEUE_NAME, payload);
    if (!jobId) throw new Error("pg-boss did not enqueue the reply backfill job");
    console.log(jobId);
  } finally {
    await queue.stop({ graceful: true, timeout: 10_000 });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
