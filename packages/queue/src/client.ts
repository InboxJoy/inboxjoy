import PgBoss from "pg-boss";

import { queueNames, type JobPayloads, type QueueName } from "./jobs.js";

export const deadLetterQueueNames = {
  sendMessage: `${queueNames.sendMessage}.dead-letter`,
} as const;

export type QueueOptions = {
  connectionString: string;
  applicationName?: string;
  max?: number;
};

export type InboxJoyQueue = PgBoss;

export function createQueue(options: QueueOptions): PgBoss {
  return new PgBoss({
    connectionString: options.connectionString,
    application_name: options.applicationName ?? "inboxjoy-worker",
    // Per-replica budget: pg-boss polling connections are effectively permanent,
    // so keep this at 5 by default (10 across two production replicas).
    max: options.max ?? 5,
    retryLimit: 5,
    retryDelay: 30,
    retryBackoff: true
  });
}

export async function startQueue(queue: PgBoss): Promise<PgBoss> {
  await queue.start();
  await ensureQueues(queue);
  return queue;
}

export async function ensureQueues(queue: PgBoss): Promise<void> {
  // pg-boss queue creation takes schema locks. Creating the queues one at a
  // time avoids startup deadlocks on a fresh PostgreSQL database.
  await queue.createQueue(deadLetterQueueNames.sendMessage, {
    name: deadLetterQueueNames.sendMessage,
  });

  for (const name of Object.values(queueNames)) {
    const options: PgBoss.Queue = {
      name,
      retryLimit: 5,
      retryDelay: 30,
      retryBackoff: true,
      ...(name === queueNames.sendMessage ? { deadLetter: deadLetterQueueNames.sendMessage } : {}),
    };
    await queue.createQueue(name, options);
    await queue.updateQueue(name, options);
  }
}

export async function getSendMessageDeadLetterCount(queue: PgBoss): Promise<number> {
  return queue.getQueueSize(deadLetterQueueNames.sendMessage);
}

export async function enqueueJob<Name extends QueueName>(
  queue: PgBoss,
  name: Name,
  payload: JobPayloads[Name],
  options?: PgBoss.SendOptions
): Promise<string | null> {
  if (options) {
    return queue.send(name, payload, options);
  }

  return queue.send(name, payload);
}

export async function scheduleRecurringJobs(queue: PgBoss): Promise<void> {
  await queue.schedule(queueNames.scheduleDueMessages, "*/2 * * * *", {});
  await queue.schedule(queueNames.reconcileInbox, "*/5 * * * *", {});
  await queue.schedule(queueNames.refreshHealth, "*/15 * * * *", {});
  await queue.schedule(queueNames.pollImap, "*/2 * * * *", {});
}
