import { describe, expect, it } from "vitest";

import { buildErrorCsv, csvHeaders, customVariablesInMapping, defaultFieldMapping, detectFieldMapping, fallbackTarget, isCustomTarget, isLinesOnlyUpdate, previewRowNote, parseCsvSample, suggestedVariableNames } from "../app/app/(product)/leads/csv-import";

describe("lead CSV import helpers", () => {
  it("parses quoted CSV headers and sample rows", () => {
    expect(parseCsvSample('\uFEFFWork Email,"First, name"\r\nada@example.com,"Ada, L."')).toEqual([
      ["Work Email", "First, name"],
      ["ada@example.com", "Ada, L."],
    ]);
    expect(csvHeaders("email,company\nada@example.com,Analytical Engines")).toEqual(["email", "company"]);
  });

  it("auto-detects aliases using header-to-field mapping", () => {
    expect(detectFieldMapping(["Work Email", "Given Name", "Surname", "Organization", "Job Title", "Lead Source"])).toEqual({
      "Work Email": "email",
      "Given Name": "firstName",
      Surname: "lastName",
      Organization: "company",
      "Job Title": "title",
      "Lead Source": "source",
    });
  });

  it("escapes error exports and neutralizes spreadsheet formulas", () => {
    expect(buildErrorCsv([{ rowNumber: 2, email: " =cmd()", status: "invalid", action: "rejected", error: 'Bad, "email"', changedFields: "" }])).toBe(
      'rowNumber,email,status,action,error,changedFields\r\n2,\' =cmd(),invalid,rejected,"Bad, ""email""",',
    );
  });
});


describe("CSV compatibility", () => {
  it("strips a UTF-8 BOM before reading the first header", () => {
    expect(csvHeaders("\uFEFFWork Email,Company\r\nada@example.com,Example")).toEqual(["Work Email", "Company"]);
  });
  it("guards control characters in spreadsheet error exports", () => {
    expect(buildErrorCsv([{ email: "\tvalue" }])).toContain("'\tvalue");
    expect(buildErrorCsv([{ email: "\rvalue" }])).toContain("'\rvalue");
  });
});

describe("custom variable columns", () => {
  it("defaults unknown columns to custom variables and keeps standard detection", () => {
    expect(defaultFieldMapping(["Work Email", "First Name", "Pain Point", "icebreaker", "Recent News"])).toEqual({
      "Work Email": "email",
      "First Name": "firstName",
      "Pain Point": "custom:painPoint",
      icebreaker: "custom:icebreaker",
      "Recent News": "custom:recentNews",
    });
  });

  it("gives a second column for an already-mapped field its own variable", () => {
    expect(defaultFieldMapping(["Email", "Email Address", "Email Address"])).toEqual({ Email: "email", "Email Address": "custom:emailAddress" });
  });

  it("dedupes derived names across headers", () => {
    expect(defaultFieldMapping(["Email", "Pain Point", "pain point"])).toEqual({ Email: "email", "Pain Point": "custom:painPoint", "pain point": "custom:painPoint2" });
    expect(suggestedVariableNames(["Pain Point", "pain point"])).toEqual({ "Pain Point": "painPoint", "pain point": "painPoint2" });
  });

  it("maps every server alias header to its standard field", () => {
    expect(defaultFieldMapping(["Email", "First Name", "Last_Name", "Company Name", "Job Title"])).toEqual({ Email: "email", "First Name": "firstName", Last_Name: "lastName", "Company Name": "company", "Job Title": "title" });
    expect(defaultFieldMapping(["email", "first_name", "company_name", "job_title", "name2"])).toEqual({ email: "email", first_name: "firstName", company_name: "company", job_title: "title", name2: "custom:name2" });
    expect(defaultFieldMapping(["Email", "Name", "Company"])).toMatchObject({ Name: "firstName", Company: "company" });
  });

  it("does not import a full name by default", () => {
    expect(defaultFieldMapping(["Email", "Full Name", "full_name"])).toEqual({ Email: "email" });
  });

  it("never maps a reserved or alias name to a custom variable", () => {
    const mapping = defaultFieldMapping(["Email", "First Name", "firstName", "first_name", "Company", "Company Name", "Title", "Job Title", "Source", "Name"]);
    expect(mapping).toEqual({ Email: "email", "First Name": "firstName", Company: "company", Title: "title", Source: "source" });
    expect(customVariablesInMapping(mapping)).toEqual([]);
    expect(suggestedVariableNames(["Company Name", "Pain Point"])).toEqual({ "Company Name": "", "Pain Point": "painPoint" });
    expect(fallbackTarget("")).toBeUndefined();
    expect(fallbackTarget("companyName")).toBeUndefined();
    expect(fallbackTarget("painPoint")).toBe("custom:painPoint");
  });

  it("describes preview rows, including existing leads that only get new lines", () => {
    expect(isLinesOnlyUpdate({ action: "update", error: null })).toBe(true);
    expect(isLinesOnlyUpdate({ action: "update", error: null, changedFields: { company: { before: "", after: "X" } } })).toBe(false);
    expect(isLinesOnlyUpdate({ action: "unchanged", error: "Lead already exists" })).toBe(false);
    expect(previewRowNote({ action: "update", error: null })).toBe("New lines added to this lead");
    expect(previewRowNote({ action: "update", error: null, changedFields: { title: {} } })).toBe("Ready");
    expect(previewRowNote({ action: "unchanged", error: null })).toBe("No mapped changes");
    expect(previewRowNote({ action: "unchanged", error: "Lead already exists" })).toBe("Lead already exists");
    expect(previewRowNote({ action: "create", error: null })).toBe("Ready");
  });

  it("lists the custom variables a mapping imports", () => {
    expect(customVariablesInMapping({ Email: "email", A: "custom:one", B: "custom:two", C: "custom:one" })).toEqual(["one", "two"]);
    expect(customVariablesInMapping({ Email: "email" })).toEqual([]);
    expect(isCustomTarget("custom:one")).toBe(true);
    expect(isCustomTarget("custom:")).toBe(false);
    expect(isCustomTarget("company")).toBe(false);
  });
});
