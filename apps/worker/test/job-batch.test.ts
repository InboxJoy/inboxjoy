import { describe, expect, it, vi } from "vitest";

import { processJobBatch } from "../src/job-batch.js";

describe("processJobBatch", () => {
  it("honors the concurrency bound and isolates job failures", async () => {
    let active = 0;
    let maxActive = 0;
    const completed: string[] = [];
    const failed: string[] = [];
    const jobs = ["one", "bad", "three", "four"].map((id) => ({ id }));

    const run = vi.fn(async (job: { id: string }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      if (job.id === "bad") throw new Error("boom");
    });

    await processJobBatch(jobs, {
      concurrency: 2,
      run,
      complete: async (job) => { completed.push(job.id); },
      fail: async (job) => { failed.push(job.id); },
    });

    expect(maxActive).toBe(2);
    expect(completed.sort()).toEqual(["four", "one", "three"]);
    expect(failed).toEqual(["bad"]);
    expect(run).toHaveBeenCalledTimes(4);
  });
});
