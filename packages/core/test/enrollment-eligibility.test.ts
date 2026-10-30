import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { findEligibleEnrollmentAudience } from "../src/enrollment-eligibility.js";

describe("campaign enrollment deduplication", () => {
  it("excludes legacy sequence enrollments without limiting their version or status", async () => {
    const conditions: unknown[] = [];
    const results = [
      [{ id: "lead", email: "lead@example.com", normalizedEmail: "lead@example.com", status: "active" }],
      [],
      [{ contactId: "lead", campaignId: null }],
    ];
    const select = vi.fn(() => ({ from: () => ({ where: (condition: unknown) => {
      conditions.push(condition);
      return Promise.resolve(results.shift());
    } }) }));
    const result = await findEligibleEnrollmentAudience({ db: { select } as never, workspaceId: "workspace", sequenceId: "sequence", campaignId: "campaign", sequenceVersionId: "v2", leadIds: ["lead"] });
    expect(result.eligible).toEqual([]);
    expect(result.skipped.already_enrolled).toBe(1);
    expect(result.skipped.missing_variables).toBe(0);
    const query = new PgDialect().sqlToQuery(conditions[2] as never);
    expect(query.params).toContain("sequence");
    expect(query.params).not.toContain("v2");
    // Only an enrollment stopped for missing variables is exempt (it re-enrolls); no status list limits the rest.
    expect(query.sql).not.toContain('"enrollments"."status" in');
    expect(query.sql).toContain('"enrollments"."stop_reason" <> $');
    expect(query.params).toContain("missing_variables");
    expect(query.sql).not.toContain('"enrollments"."sequence_version_id"');
  });

  it("does not treat a lead's enrolled status as a duplicate (leads can be active in several sequences)", async () => {
    const results = [
      [{ id: "lead", email: "lead@example.com", normalizedEmail: "lead@example.com", status: "enrolled" }],
      [],
      [],
    ];
    const select = vi.fn(() => ({ from: () => ({ where: () => Promise.resolve(results.shift()) }) }));
    const result = await findEligibleEnrollmentAudience({ db: { select } as never, workspaceId: "workspace", leadIds: ["lead"], sequenceVersionId: null });
    expect(result.eligible.map((lead) => lead.id)).toEqual(["lead"]);
    expect(result.skipped).toEqual({ suppressed: 0, already_enrolled: 0, replied: 0, bounced: 0, unsubscribed: 0, missing_variables: 0 });
  });
});
