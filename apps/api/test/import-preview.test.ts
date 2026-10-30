import { describe, expect, it } from "vitest";

import { buildImportPreview } from "../src/app.js";

describe("CSV import preview", () => {
  it("classifies updates, creates, duplicates, suppressions, and rejected rows", () => {
    const updatedAt = new Date("2026-09-10T12:00:00.000Z");
    const preview = buildImportPreview({
      mode: "add_and_update",
      csv: "email,firstName,company,source\nexisting@example.com,New Name,,\nexisting@example.com,Duplicate,Changed,Changed\nnew@example.com,New,New Co,Partner\nsuppressed@example.com,Nope,Nope,Nope\ninvalid,Nope,Nope,Nope",
      existingContacts: new Map([["existing@example.com", { id: "lead-1", email: "existing@example.com", normalizedEmail: "existing@example.com", firstName: "Old Name", lastName: null, company: "Keep Co", title: null, source: "Keep source", status: "active", updatedAt }]]),
      suppressed: new Set(["suppressed@example.com"]),
    });

    expect(preview.rows.map((row) => row.action)).toEqual(["update", "duplicate", "create", "suppressed", "rejected"]);
    expect(preview.rows[0]?.changedFields).toEqual({ firstName: { before: "Old Name", after: "New Name" } });
    expect(preview.rows[0]?.normalizedData).toMatchObject({ company: "Keep Co", source: "Keep source" });
    expect(preview.stats).toMatchObject({ totalRows: 5, readyRows: 2, createRows: 1, updateRows: 1, duplicateRows: 1, suppressedRows: 1, rejectedRows: 1, skippedRows: 3 });
  });

  it("add-only turns a row with new custom cells into a custom-only update and keeps the rest unchanged", () => {
    const existing = { id: "lead-1", email: "existing@example.com", normalizedEmail: "existing@example.com", firstName: "Old", lastName: null, company: "Keep Co", title: null, source: "Keep source", status: "active", updatedAt: new Date("2026-09-10T12:00:00.000Z"), customFields: { icebreaker: "Same line" } };
    const preview = buildImportPreview({
      mode: "add_only",
      csv: "email,firstName,icebreaker\nexisting@example.com,Changed,New line\nexisting@example.com,Dup,New line\nother@example.com,Other,",
      fieldMapping: { email: "email", firstName: "firstName", "custom:icebreaker": "icebreaker" },
      existingContacts: new Map([["existing@example.com", existing], ["other@example.com", { ...existing, id: "lead-2", email: "other@example.com", normalizedEmail: "other@example.com" }]]),
      suppressed: new Set(),
    });
    expect(preview.rows.map((row) => row.action)).toEqual(["update", "duplicate", "unchanged"]);
    expect(preview.rows[0]).toMatchObject({ status: "ready", error: null });
    // Standard fields are never rewritten in add-only mode.
    expect(preview.rows[0]?.changedFields).toBeUndefined();
    expect(preview.rows[0]?.normalizedData).toMatchObject({ firstName: "Old", company: "Keep Co" });
    expect(preview.rows[2]).toMatchObject({ status: "unchanged", error: "Lead already exists" });
    // An identical stored value is not a change.
    const same = buildImportPreview({ mode: "add_only", csv: "email,icebreaker\nexisting@example.com,Same line", fieldMapping: { email: "email", "custom:icebreaker": "icebreaker" }, existingContacts: new Map([["existing@example.com", existing]]), suppressed: new Set() });
    expect(same.rows[0]).toMatchObject({ action: "unchanged", error: "Lead already exists" });
    // Campaign-scoped values are always rewritten.
    const campaignScoped = buildImportPreview({ mode: "add_only", variablesSequenceId: "seq", csv: "email,icebreaker\nexisting@example.com,Same line", fieldMapping: { email: "email", "custom:icebreaker": "icebreaker" }, existingContacts: new Map([["existing@example.com", existing]]), suppressed: new Set() });
    expect(campaignScoped.rows[0]).toMatchObject({ action: "update", status: "ready" });
  });

  it("marks unknown update-only rows not found and validates the complete CSV", () => {
    const preview = buildImportPreview({ mode: "update_only", csv: "email,firstName\nmissing@example.com,Missing", existingContacts: new Map(), suppressed: new Set() });
    expect(preview.rows[0]).toMatchObject({ action: "not_found", status: "skipped", error: "Lead not found" });
    expect(preview.stats).toMatchObject({ readyRows: 0, skippedRows: 1 });
    expect(() => buildImportPreview({ csv: "email,name\n\"broken@example.com,Broken" })).toThrow("unterminated quoted field");
    expect(() => buildImportPreview({ csv: "email,email\none@example.com,two@example.com" })).toThrow("column names must be unique");
  });

  it("supports both legacy field-to-header and UI header-to-field mappings", () => {
    const legacy = buildImportPreview({ csv: "Contact Address,Given\nlegacy@example.com,Legacy", fieldMapping: { email: "Contact Address", firstName: "Given" }, existingContacts: new Map(), suppressed: new Set() });
    const ui = buildImportPreview({ csv: "Contact Address,Given\nui@example.com,Ui", fieldMapping: { "Contact Address": "email", Given: "firstName" }, existingContacts: new Map(), suppressed: new Set() });
    expect(legacy.rows[0]?.normalizedData).toMatchObject({ email: "legacy@example.com", firstName: "Legacy" });
    expect(ui.rows[0]?.normalizedData).toMatchObject({ email: "ui@example.com", firstName: "Ui" });
  });
});


describe("explicit CSV mapping", () => {
  it("does not auto-import columns the user left unmapped", () => {
    const preview = buildImportPreview({ csv: "email,company,source\nnew@example.com,Do not copy,Do not copy", fieldMapping: { email: "email" }, existingContacts: new Map(), suppressed: new Set() });
    expect(preview.rows[0]?.normalizedData).toMatchObject({ company: "", source: "CSV import" });
  });
  it("maps canonical headers to different fields without reversing their meaning", () => {
    const preview = buildImportPreview({ csv: "email,company,title\nnew@example.com,Founder,Ignored", fieldMapping: { email: "email", company: "title" }, existingContacts: new Map(), suppressed: new Set() });
    expect(preview.rows[0]?.normalizedData).toMatchObject({ company: "", title: "Founder" });
  });
  it("requires an email mapping when an explicit map is supplied", () => {
    expect(() => buildImportPreview({ csv: "email,company\nnew@example.com,Example", fieldMapping: {} })).toThrow("Map an email column");
  });
});

describe("custom CSV columns", () => {
  const csv = "Email,Ice breaker,Hook\nnew@example.com,Loved your talk,\nold@example.com,,Fresh hook";
  const existing = new Map([["old@example.com", { id: "lead-1", email: "old@example.com", normalizedEmail: "old@example.com", firstName: "Old", lastName: null, company: null, title: null, source: null, status: "active", updatedAt: new Date("2026-09-10T12:00:00.000Z"), customFields: { hook: "Stale hook" } }]]);

  it("maps custom:<name> targets in either orientation and lists the target names", () => {
    const ui = buildImportPreview({ csv, fieldMapping: { Email: "email", "Ice breaker": "custom:icebreaker", Hook: "custom:hook" }, existingContacts: new Map(), suppressed: new Set() });
    expect(ui.customFields).toEqual(["hook", "icebreaker"]);
    expect(ui.fieldMapping).toMatchObject({ email: "Email", "custom:icebreaker": "Ice breaker", "custom:hook": "Hook" });
    const legacy = buildImportPreview({ csv, fieldMapping: { email: "Email", "custom:icebreaker": "Ice breaker" }, existingContacts: new Map(), suppressed: new Set() });
    expect(legacy.customFields).toEqual(["icebreaker"]);
  });

  it("keeps cleaned non-empty values per row for commit and never auto-maps unknown columns", () => {
    const preview = buildImportPreview({ mode: "add_and_update", csv, fieldMapping: { Email: "email", "Ice breaker": "custom:icebreaker", Hook: "custom:hook" }, existingContacts: existing, suppressed: new Set() });
    expect(preview.rows[0]).toMatchObject({ action: "create", customValues: { icebreaker: "Loved your talk" } });
    expect(preview.rows[1]).toMatchObject({ action: "update", customValues: { hook: "Fresh hook" } });
    expect(preview.rows[1]?.changedFields).toBeUndefined();
    const auto = buildImportPreview({ csv, existingContacts: new Map(), suppressed: new Set() });
    expect(auto.customFields).toEqual([]);
    expect(auto.rows[0]?.customValues).toBeUndefined();
  });

  it("treats an unchanged custom value on an existing lead as unchanged, but always rewrites campaign variables", () => {
    const same = "Email,Hook\nold@example.com,Stale hook";
    const lead = buildImportPreview({ mode: "add_and_update", csv: same, fieldMapping: { Email: "email", Hook: "custom:hook" }, existingContacts: existing, suppressed: new Set() });
    expect(lead.rows[0]?.action).toBe("unchanged");
    const campaign = buildImportPreview({ mode: "add_and_update", csv: same, fieldMapping: { Email: "email", Hook: "custom:hook" }, variablesSequenceId: "30000000-0000-4000-8000-000000000001", existingContacts: existing, suppressed: new Set() });
    expect(campaign.rows[0]?.action).toBe("update");
    expect(campaign.variablesSequenceId).toBe("30000000-0000-4000-8000-000000000001");
  });

  it("rejects built-in names, aliases, bad names and duplicate targets", () => {
    const build = (fieldMapping: Record<string, string>) => buildImportPreview({ csv, fieldMapping, existingContacts: new Map(), suppressed: new Set() });
    expect(() => build({ Email: "email", Hook: "custom:firstName" })).toThrow(/built-in/);
    expect(() => build({ Email: "email", Hook: "custom:company_name" })).toThrow(/built-in/);
    expect(() => build({ Email: "email", Hook: "custom:bad name" })).toThrow(/not a valid custom field name/);
    expect(() => build({ Email: "email", Hook: "custom:" })).toThrow(/not a valid custom field name/);
    expect(() => build({ Email: "email", Hook: "custom:x", "Ice breaker": "custom:x" })).toThrow(/Map only one column/);
    expect(() => build({ Email: "email", Hook: "custom:1abc" })).toThrow(/not a valid custom field name/);
  });

  it("rejects rows whose custom cell is too long", () => {
    const long = `Email,Hook\nnew@example.com,${"x".repeat(1001)}`;
    const preview = buildImportPreview({ csv: long, fieldMapping: { Email: "email", Hook: "custom:hook" }, existingContacts: new Map(), suppressed: new Set() });
    expect(preview.rows[0]).toMatchObject({ action: "rejected", error: "One or more fields exceed the allowed length" });
  });
});
