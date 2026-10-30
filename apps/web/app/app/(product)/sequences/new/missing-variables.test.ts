import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import {
  missingVariablesBreakdown,
  missingVariablesFromError,
  missingVariablesHeadline,
  missingVariablesSamples,
  readMissingVariables,
  fillMissingValuesAccess,
  SAVE_AUDIENCE_HINT,
  variableTag,
} from "./missing-variables";

const details = { code: "missing_variables", total: 12, variables: ["icebreaker"], byVariable: { icebreaker: 12 }, sampleEmails: ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com", "f@x.com"] };

describe("missing variables helper", () => {
  it("reads the API summary and treats absent or empty data as complete", () => {
    expect(readMissingVariables(details)).toMatchObject({ total: 12, variables: ["icebreaker"] });
    expect(readMissingVariables(undefined)).toBeNull();
    expect(readMissingVariables({ total: 0, variables: [], byVariable: {}, sampleEmails: [] })).toBeNull();
    expect(readMissingVariables({ total: 3 })).toBeNull();
    expect(readMissingVariables("nope")).toBeNull();
  });

  it("extracts details from a missing_variables API error only", () => {
    const error = new ApiError("12 leads are missing {{icebreaker}}.", 409, "missing_variables", undefined, details);
    expect(missingVariablesFromError(error)?.total).toBe(12);
    expect(missingVariablesFromError(new ApiError("Nope", 409, "workspace_changed", undefined, { ...details, code: "other" }))).toBeNull();
    expect(missingVariablesFromError(new ApiError("No details", 409, "missing_variables"))).toBeNull();
    expect(missingVariablesFromError(new Error("boom"))).toBeNull();
    expect(missingVariablesFromError(null)).toBeNull();
  });

  it("formats the headline with pluralization", () => {
    expect(missingVariablesHeadline(readMissingVariables(details)!)).toBe("12 leads are missing {{icebreaker}}");
    expect(missingVariablesHeadline(readMissingVariables({ ...details, total: 1, byVariable: { icebreaker: 1 } })!)).toBe("1 lead is missing {{icebreaker}}");
    const several = readMissingVariables({ total: 5, variables: ["icebreaker", "hook"], byVariable: { icebreaker: 5, hook: 1 }, sampleEmails: [] })!;
    expect(missingVariablesHeadline(several)).toBe("5 leads are missing custom variables");
  });

  it("lists per-variable counts only when several variables are missing", () => {
    expect(missingVariablesBreakdown(readMissingVariables(details)!)).toEqual([]);
    const several = readMissingVariables({ total: 5, variables: ["icebreaker", "{{hook}}"], byVariable: { icebreaker: 5, "{{hook}}": 1 }, sampleEmails: [] })!;
    expect(missingVariablesBreakdown(several)).toEqual(["{{icebreaker}} · 5 leads", "{{hook}} · 1 lead"]);
  });

  it("shows up to five sample emails with a +N more label", () => {
    const samples = missingVariablesSamples(readMissingVariables(details)!);
    expect(samples.emails).toEqual(["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com"]);
    expect(samples.moreLabel).toBe("+7 more");
    const all = missingVariablesSamples({ total: 2, variables: ["x"], byVariable: { x: 2 }, sampleEmails: ["a@x.com", "b@x.com"] });
    expect(all.moreLabel).toBe("");
  });

  it("normalizes variable names to merge tags", () => {
    expect(variableTag("icebreaker")).toBe("{{icebreaker}}");
    expect(variableTag("{{icebreaker}}")).toBe("{{icebreaker}}");
  });

  it("offers the values editor only once the campaign audience is saved", () => {
    expect(fillMissingValuesAccess({ sequenceId: "seq_1", campaignId: "cmp_1" })).toEqual({ canFill: true, hint: "" });
    expect(fillMissingValuesAccess({ sequenceId: "seq_1", campaignId: "" })).toEqual({ canFill: false, hint: SAVE_AUDIENCE_HINT });
    expect(fillMissingValuesAccess({ sequenceId: "", campaignId: "cmp_1" }).canFill).toBe(false);
    expect(fillMissingValuesAccess({}).canFill).toBe(false);
  });
});
