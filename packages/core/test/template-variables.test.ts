import { describe, expect, it } from "vitest";

import { extractCustomVariables, renderTemplate, renderTemplateWithPlaceholders, validateRefinedStep } from "../src/index.js";

describe("renderTemplate", () => {
  it("renders built-ins and leaves missing built-ins blank without reporting them", () => {
    expect(renderTemplate("Hi {{firstName}} at {{ company }} ({{title}})", { firstName: "Ada", company: "Engine Co", title: null })).toEqual({ text: "Hi Ada at Engine Co ()", missing: [] });
  });

  it("resolves custom variables from campaign values before lead custom fields", () => {
    const lead = { customFields: { icebreaker: "from lead", only_lead: "lead only" }, campaignVariables: { icebreaker: "from campaign" } };
    expect(renderTemplate("{{icebreaker}} / {{only_lead}}", lead)).toEqual({ text: "from campaign / lead only", missing: [] });
  });

  it("reports unresolved custom variables once, sorted, and renders them blank", () => {
    expect(renderTemplate("{{b}} {{a}} {{b}}", { customFields: { a: "" } })).toEqual({ text: "  ", missing: ["a", "b"] });
  });

  it("treats built-in names as columns even when a custom value shares the name", () => {
    expect(renderTemplate("{{firstName}}", { firstName: "Ada", campaignVariables: { firstName: "Override" } }).text).toBe("Ada");
  });

  it("keeps text that is not an exact variable token literal", () => {
    expect(renderTemplate("{{ foo bar }} {{}} {{1abc}} {foo}", {})).toEqual({ text: "{{ foo bar }} {{}} {{1abc}} {foo}", missing: [] });
  });

  it("strips line breaks and NUL from values so they cannot inject headers", () => {
    const rendered = renderTemplate("{{firstName}}|{{note}}", { firstName: "Ada\r\nBcc: x@y.z", campaignVariables: { note: "one\ntwo\0three" } });
    expect(rendered.text).not.toMatch(/[\r\n\0]/);
    expect(rendered.text).toBe("AdaBcc: x@y.z|one two three");
  });

  it("shows [name] placeholders for preview rendering while still reporting missing", () => {
    expect(renderTemplateWithPlaceholders("Hi {{firstName}}, {{icebreaker}}", { firstName: "Ada" })).toEqual({ text: "Hi Ada, [icebreaker]", missing: ["icebreaker"] });
  });

  it("renders legacy built-in aliases like built-ins and never reports them missing", () => {
    const lead = { firstName: "Ada", lastName: "Lovelace", company: "Engine Co", title: "CTO", email: "ada@example.com" };
    expect(renderTemplate("{{first_name}} {{FirstName}} {{firstname}} {{last_name}} {{LastName}} {{company_name}} {{companyName}} {{company}} {{job_title}} {{jobTitle}} {{Title}} {{Email}}", lead))
      .toEqual({ text: "Ada Ada Ada Lovelace Lovelace Engine Co Engine Co Engine Co CTO CTO CTO ada@example.com", missing: [] });
    expect(renderTemplate("Hi {{first_name}}|{{company_name}}", {})).toEqual({ text: "Hi |", missing: [] });
  });

  it("resolves {{name}} (any case) to the lead's first name and never treats it as custom", () => {
    expect(renderTemplate("Hi {{name}}, {{Name}} {{ NAME }}", { firstName: "Ada" })).toEqual({ text: "Hi Ada, Ada Ada", missing: [] });
    expect(renderTemplate("Hi {{name}}|", {})).toEqual({ text: "Hi |", missing: [] });
    expect(extractCustomVariables("Hi {{name}} {{icebreaker}}")).toEqual(["icebreaker"]);
    expect(renderTemplate("Hi {{name}}", { firstName: "Ada" }, { enforceCustom: false }).text).toBe("Hi Ada");
  });

  it("renders grandfathered sequences like before: custom tokens stay literal and are never missing", () => {
    const lead = { firstName: "Ada", customFields: { icebreaker: "from lead" }, campaignVariables: { icebreaker: "from campaign" } };
    expect(renderTemplate("Hi {{first_name}} {{icebreaker}} {{ topic }}", lead, { enforceCustom: false })).toEqual({ text: "Hi Ada {{icebreaker}} {{ topic }}", missing: [] });
    // enforced stays the default
    expect(renderTemplate("{{icebreaker}} {{topic}}", lead)).toEqual({ text: "from campaign ", missing: ["topic"] });
    expect(renderTemplateWithPlaceholders("{{topic}}", lead, { enforceCustom: false })).toEqual({ text: "{{topic}}", missing: [] });
  });

  it("does not treat aliases as custom variables", () => {
    expect(extractCustomVariables("{{first_name}} {{FirstName}} {{company_name}} {{job_title}} {{icebreaker}}")).toEqual(["icebreaker"]);
  });

  it("extracts only custom variable names", () => {
    expect(extractCustomVariables("Hi {{firstName}} {{icebreaker}}", "{{ topic }} {{icebreaker}}")).toEqual(["icebreaker", "topic"]);
  });
});

describe("validateRefinedStep with custom variables", () => {
  const body = (line: string) => `Hi {{firstName}},\n\n${line} I noticed your team is hiring analysts which usually means reporting work is growing fast.\n\nWe automate repetitive handoffs so analysts can spend time on decisions.\n\nWorth comparing notes next week?`;

  it("accepts a refinement that keeps a custom variable from the input step", () => {
    const input = { subject: "Reporting", body: body("{{icebreaker}}"), action: "warmer" as const };
    expect(validateRefinedStep(input, { subject: "Reporting help", body: body("{{icebreaker}}") }).body).toContain("{{icebreaker}}");
  });

  it("rejects a refinement that introduces a custom variable the step never used", () => {
    const input = { subject: "Reporting", body: body("Plain line."), action: "warmer" as const };
    expect(() => validateRefinedStep(input, { subject: "Reporting help", body: body("{{icebreaker}}") })).toThrow(/introduced variables/);
  });
});
