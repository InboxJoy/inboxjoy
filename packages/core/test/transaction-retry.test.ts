import { describe, expect, it, vi } from "vitest";
import { retryTransaction } from "../src/transaction-retry.js";

describe("transaction contention retries", () => {
  it.each(["40P01", "40001"])("retries a wrapped %s abort as a whole transaction", async (code) => {
    const work = vi.fn().mockRejectedValueOnce(new Error("query failed", { cause: { code } })).mockResolvedValue("suppressed");
    await expect(retryTransaction(work)).resolves.toBe("suppressed");
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("does not retry unrelated errors", async () => {
    const error = new Error("invalid query");
    const work = vi.fn().mockRejectedValue(error);
    await expect(retryTransaction(work)).rejects.toBe(error);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("bounds retries on a persistently failing transaction", async () => {
    const work = vi.fn().mockRejectedValue({ code: "40P01" });
    await expect(retryTransaction(work)).rejects.toMatchObject({ code: "40P01" });
    expect(work).toHaveBeenCalledTimes(5);
  });
});
