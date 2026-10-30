import { describe, expect, it } from "vitest";

import {
  adjustCoverage,
  camelCaseVariableName,
  coverageLabel,
  coveragePercent,
  coverageStatus,
  extractCustomVariableNames,
  extractVariableNames,
  insertAtCursor,
  leadVariablesQuery,
  markCustomPlaceholders,
  splitMissingPlaceholders,
  stepVariables,
  truncateValue,
  validateNewVariableName,
  variableNamesForHeaders,
  variableOptions,
  variableToken,
  variableUpdateValue,
  fillSampleVariables,
  isBuiltInVariable,
  isReservedVariableName,
  resolveBuiltInVariable,
  rollbackCoverage,
  withEditedVariable,
  type LeadVariableRow,
} from "../lib/lead-variables";

describe("variable name derivation", () => {
  it("camel-cases headers into valid variable names", () => {
    expect(camelCaseVariableName("Pain Point")).toBe("painPoint");
    expect(camelCaseVariableName("icebreaker")).toBe("icebreaker");
    expect(camelCaseVariableName("Icebreaker")).toBe("icebreaker");
    expect(camelCaseVariableName("ICEBREAKER")).toBe("icebreaker");
    expect(camelCaseVariableName("LinkedIn URL")).toBe("linkedInUrl");
    expect(camelCaseVariableName("first_line")).toBe("first_line");
    expect(camelCaseVariableName("  Recent   news!! ")).toBe("recentNews");
  });

  it("strips characters that cannot start or live in a name", () => {
    expect(camelCaseVariableName("1st line")).toBe("stLine");
    expect(camelCaseVariableName("2024")).toBe("");
    expect(camelCaseVariableName("Café note")).toBe("cafNote");
    expect(camelCaseVariableName("a".repeat(100))).toHaveLength(64);
  });

  it("de-duplicates names and avoids built-ins and import fields", () => {
    expect(variableNamesForHeaders(["Pain Point", "pain point", "Pain-Point"])).toEqual({ "Pain Point": "painPoint", "pain point": "painPoint2", "Pain-Point": "painPoint3" });
    expect(variableNamesForHeaders(["First Name", "Company", "Source", "2024"])).toEqual({ "First Name": "", Company: "", Source: "", "2024": "field" });
  });

  it("gives alias headers no variable name", () => {
    expect(variableNamesForHeaders(["Company Name", "company_name", "Job Title", "first_name", "Name", "Pain Point"])).toEqual({ "Company Name": "", company_name: "", "Job Title": "", first_name: "", Name: "", "Pain Point": "painPoint" });
  });

  it("keeps a repeated header on one name", () => {
    expect(variableNamesForHeaders(["Notes", "Notes"])).toEqual({ Notes: "notes" });
  });
});

describe("new variable validation", () => {
  it("accepts bare names and braced tokens", () => {
    expect(validateNewVariableName(" icebreaker ")).toEqual({ ok: true, name: "icebreaker" });
    expect(validateNewVariableName("{{pain_point}}")).toEqual({ ok: true, name: "pain_point" });
  });

  it("explains what is wrong", () => {
    expect(validateNewVariableName("  ")).toMatchObject({ ok: false });
    expect(validateNewVariableName("1abc")).toEqual({ ok: false, error: "Start the name with a letter." });
    expect(validateNewVariableName("pain point")).toEqual({ ok: false, error: "Use letters, numbers, and underscores only." });
    expect(validateNewVariableName("a".repeat(65))).toMatchObject({ ok: false });
    expect(validateNewVariableName("a".repeat(64))).toMatchObject({ ok: true });
  });
});

describe("variable tokens in steps", () => {
  it("finds built-in and custom tokens in order, without repeats", () => {
    expect(extractVariableNames("Hi {{firstName}}, {{icebreaker}}", "{{ icebreaker }} at {{company}} {{not valid}} {{1x}}")).toEqual(["firstName", "icebreaker", "company"]);
    expect(extractCustomVariableNames("{{firstName}} {{painPoint}} {{icebreaker}}")).toEqual(["painPoint", "icebreaker"]);
    expect(stepVariables({ subject: "{{company}} idea", body: "{{icebreaker}}" })).toEqual({ builtIn: ["company"], custom: ["icebreaker"] });
    expect(stepVariables({ subject: "", body: "" })).toEqual({ builtIn: [], custom: [] });
  });

  it("builds picker options from saved and used names", () => {
    expect(variableOptions(["painPoint", "firstName", "bad name"], ["icebreaker", "painPoint"])).toEqual({
      builtIn: ["firstName", "lastName", "company", "title", "email"],
      custom: ["icebreaker", "painPoint"],
    });
    expect(variableToken("{{ x }}")).toBe("{{x}}");
  });
});

describe("insert at cursor", () => {
  it("inserts at the caret and reports the new caret", () => {
    expect(insertAtCursor("Hi , welcome", "{{firstName}}", 3)).toEqual({ value: "Hi {{firstName}}, welcome", cursor: 16 });
  });

  it("replaces a selection", () => {
    expect(insertAtCursor("Hi NAME!", "{{firstName}}", 3, 7)).toEqual({ value: "Hi {{firstName}}!", cursor: 16 });
    expect(insertAtCursor("Hi NAME!", "{{x}}", 7, 3)).toEqual({ value: "Hi {{x}}!", cursor: 8 });
  });

  it("appends when there is no caret and clamps out-of-range positions", () => {
    expect(insertAtCursor("Hello", " {{x}}", null)).toEqual({ value: "Hello {{x}}", cursor: 11 });
    expect(insertAtCursor("Hello", "!", 99, 120)).toEqual({ value: "Hello!", cursor: 6 });
    expect(insertAtCursor("", "{{x}}", 0)).toEqual({ value: "{{x}}", cursor: 5 });
  });
});

describe("coverage formatting", () => {
  it("formats ready counts and percentages", () => {
    expect(coverageLabel(142, 150)).toBe("142 / 150 leads ready");
    expect(coverageLabel(1, 1)).toBe("1 / 1 lead ready");
    expect(coverageLabel(1200, 3000)).toBe("1,200 / 3,000 leads ready");
    expect(coveragePercent(142, 150)).toBe(95);
    expect(coveragePercent(0, 0)).toBe(0);
    expect(coveragePercent(5, 3)).toBe(100);
  });

  it("reports ready or the missing count", () => {
    expect(coverageStatus(0)).toEqual({ label: "Ready", tone: "good" });
    expect(coverageStatus(8)).toEqual({ label: "8 missing", tone: "warning" });
  });

  it("truncates long values", () => {
    expect(truncateValue("short", 10)).toBe("short");
    expect(truncateValue("a very long icebreaker line", 12)).toBe("a very long…");
  });
});

describe("lead variables API helpers", () => {
  it("builds the query string", () => {
    expect(leadVariablesQuery({})).toBe("filter=all&page=1&pageSize=50");
    expect(leadVariablesQuery({ filter: "missing", variable: "icebreaker", page: 3, pageSize: 25, search: " ada " })).toBe("filter=missing&variable=icebreaker&page=3&pageSize=25&search=ada");
  });

  it("maps an empty edit to a removal", () => {
    expect(variableUpdateValue("  ")).toBeNull();
    expect(variableUpdateValue("  Loved your talk  ")).toBe("Loved your talk");
  });

  const row: LeadVariableRow = { contactId: "c1", email: "ada@example.com", firstName: "Ada", lastName: null, values: { icebreaker: null, painPoint: { value: "slow sends", source: "lead" } }, missing: ["icebreaker"] };

  it("applies an optimistic edit and recomputes what is missing", () => {
    const filled = withEditedVariable(row, "icebreaker", "Loved your talk", ["icebreaker", "painPoint"]);
    expect(filled.values.icebreaker).toEqual({ value: "Loved your talk", source: "campaign" });
    expect(filled.missing).toEqual([]);
    const cleared = withEditedVariable(row, "painPoint", "", ["icebreaker", "painPoint"]);
    expect(cleared.values.painPoint).toBeNull();
    expect(cleared.missing).toEqual(["icebreaker", "painPoint"]);
  });

  it("moves coverage counts when a lead becomes ready or missing again", () => {
    const coverage = [{ name: "icebreaker", ready: 10, missing: 2 }, { name: "painPoint", ready: 12, missing: 0 }];
    const filled = withEditedVariable(row, "icebreaker", "Hi", ["icebreaker", "painPoint"]);
    expect(adjustCoverage(coverage, row, filled)).toEqual([{ name: "icebreaker", ready: 11, missing: 1 }, { name: "painPoint", ready: 12, missing: 0 }]);
    expect(adjustCoverage(adjustCoverage(coverage, row, filled), filled, row)).toEqual(coverage);
  });
});

describe("preview placeholders", () => {
  it("shows custom variables as [name]", () => {
    expect(markCustomPlaceholders("Hi {{firstName}}, {{icebreaker}}")).toBe("Hi {{firstName}}, [icebreaker]");
  });

  it("splits text around the placeholders for known variables", () => {
    expect(splitMissingPlaceholders("Hi Ada, [icebreaker] and [other] [x]", ["icebreaker", "x"])).toEqual([
      { text: "Hi Ada, ", missing: false },
      { text: "[icebreaker]", missing: true },
      { text: " and [other] ", missing: false },
      { text: "[x]", missing: true },
    ]);
    expect(splitMissingPlaceholders("No names", [])).toEqual([{ text: "No names", missing: false }]);
    expect(splitMissingPlaceholders("", ["a"])).toEqual([{ text: "", missing: false }]);
  });
});

describe("built-in aliases", () => {
  it("resolves aliases like the server: lowercase, underscores ignored", () => {
    expect(resolveBuiltInVariable("first_name")).toBe("firstName");
    expect(resolveBuiltInVariable("FirstName")).toBe("firstName");
    expect(resolveBuiltInVariable("name")).toBe("firstName");
    expect(resolveBuiltInVariable("Last_Name")).toBe("lastName");
    expect(resolveBuiltInVariable("company_name")).toBe("company");
    expect(resolveBuiltInVariable("companyName")).toBe("company");
    expect(resolveBuiltInVariable("job_title")).toBe("title");
    expect(resolveBuiltInVariable("jobTitle")).toBe("title");
    expect(resolveBuiltInVariable("Title")).toBe("title");
    expect(resolveBuiltInVariable("Email")).toBe("email");
    expect(resolveBuiltInVariable("icebreaker")).toBeUndefined();
    expect(isBuiltInVariable("first_name")).toBe(true);
    expect(isReservedVariableName("Source")).toBe(true);
    expect(isReservedVariableName("painPoint")).toBe(false);
  });

  it("never reports an alias as a custom variable", () => {
    expect(extractCustomVariableNames("{{first_name}} {{company_name}} {{name}} {{Title}} {{icebreaker}}")).toEqual(["icebreaker"]);
    expect(stepVariables({ subject: "{{job_title}}", body: "{{lastName}} {{pain}}" })).toEqual({ builtIn: ["job_title", "lastName"], custom: ["pain"] });
    expect(variableOptions(["first_name", "icebreaker"], ["company_name"])).toEqual({ builtIn: ["firstName", "lastName", "company", "title", "email"], custom: ["icebreaker"] });
    expect(markCustomPlaceholders("Hi {{first_name}} at {{companyName}}: {{hook}}")).toBe("Hi {{first_name}} at {{companyName}}: [hook]");
  });

  it("rejects alias names in New variable", () => {
    expect(validateNewVariableName("first_name")).toMatchObject({ ok: false });
    expect(validateNewVariableName("{{Name}}")).toMatchObject({ ok: false });
    expect(validateNewVariableName("firstName")).toMatchObject({ ok: false });
    expect(validateNewVariableName("jobTitle")).toMatchObject({ ok: false });
    expect(validateNewVariableName("first_line")).toEqual({ ok: true, name: "first_line" });
  });

  it("fills sample data for aliases and leaves custom tokens alone", () => {
    expect(fillSampleVariables("Hi {{first_name}} at {{ company_name }}, {{name}}! {{icebreaker}}")).toBe("Hi Ada at Example Co, Ada! {{icebreaker}}");
    expect(markCustomPlaceholders(fillSampleVariables("{{Title}} {{icebreaker}}"))).toBe("Founder [icebreaker]");
  });
});

describe("save rollback", () => {
  it("restores coverage counts after a failed save", () => {
    const row: LeadVariableRow = { contactId: "c1", email: "a@x.com", firstName: null, lastName: null, values: { icebreaker: null }, missing: ["icebreaker"] };
    const coverage = [{ name: "icebreaker", ready: 10, missing: 2 }];
    const edited = withEditedVariable(row, "icebreaker", "Hi", ["icebreaker"]);
    const optimistic = adjustCoverage(coverage, row, edited);
    expect(optimistic).toEqual([{ name: "icebreaker", ready: 11, missing: 1 }]);
    expect(rollbackCoverage(optimistic, row, edited)).toEqual(coverage);
  });
});
