import { dailySeries } from "@inboxjoy/core";
import { describe, expect, it } from "vitest";

describe("analytics daily series", () => {
  it("creates inclusive UTC buckets ending on the fixed current date", () => {
    expect(dailySeries(7, new Date("2026-08-30T18:45:00.000Z"))).toEqual([
      "2026-08-24", "2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28", "2026-08-29", "2026-08-30",
    ].map((date) => ({ date, sent: 0, replied: 0, opened: 0, humanOpened: 0, bounced: 0 })));
  });
});
