export type BatchJob = { id: string };

type BatchOptions<Job extends BatchJob> = {
  concurrency: number;
  run: (job: Job) => Promise<void>;
  complete: (job: Job) => Promise<void>;
  fail: (job: Job, error: unknown) => Promise<void>;
};

export async function processJobBatch<Job extends BatchJob>(jobs: Job[], options: BatchOptions<Job>): Promise<void> {
  let nextIndex = 0;
  const acknowledgementErrors: unknown[] = [];

  async function worker(): Promise<void> {
    while (nextIndex < jobs.length) {
      const job = jobs[nextIndex++];
      if (!job) return;

      try {
        await options.run(job);
        await options.complete(job);
      } catch (error) {
        try {
          await options.fail(job, error);
        } catch (acknowledgementError) {
          acknowledgementErrors.push(acknowledgementError);
        }
      }
    }
  }

  const workerCount = Math.min(Math.max(1, options.concurrency), jobs.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (acknowledgementErrors.length) {
    throw new AggregateError(acknowledgementErrors, "Failed to acknowledge one or more jobs");
  }
}
