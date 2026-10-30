import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createWorkspaceFileShapeCheck, WORKSPACE_TRANSFER_SHAPE } from "../src/workspace-transfer/shape.js";
import {
  assembleWorkspaceExport,
  normalizeCustomFields,
  normalizeSuppressionReason,
  parseWorkspaceTransferFile,
  prepareWorkspaceImport,
  workspaceExportFilename,
  WORKSPACE_TRANSFER_LIMITS,
  WorkspaceTransferError,
  type WorkspaceExportSnapshot,
} from "../src/workspace-transfer/format.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function baseFile(overrides: Record<string, unknown> = {}) {
  return {
    format: "inboxjoy-workspace",
    version: 1,
    exportedAt: "2026-10-29T10:00:00.000Z",
    workspace: { name: "Acme outbound" },
    ...overrides,
  };
}

function transferError(run: () => unknown): WorkspaceTransferError {
  try {
    run();
  } catch (error) {
    if (error instanceof WorkspaceTransferError) return error;
    throw error;
  }
  throw new Error("Expected a WorkspaceTransferError");
}

function snapshot(overrides: Partial<WorkspaceExportSnapshot> = {}): WorkspaceExportSnapshot {
  const created = new Date("2026-09-01T08:00:00.000Z");
  return {
    exportedAt: new Date("2026-10-29T10:00:00.000Z"),
    source: { edition: "cloud", appVersion: "abc123" },
    workspace: { name: "Acme outbound", defaultTimezone: "Asia/Dubai", dailySendCap: 300, killSwitchEnabled: false, openTrackingEnabled: true, postalAddress: "1 Main St" },
    contacts: [
      { id: "c1", email: "Ana@Example.com", firstName: "Ana", lastName: null, company: "Example", title: "", website: null, phone: null, location: null, linkedinUrl: null, source: "CSV import", lawfulBasisNote: null, customFields: { icebreaker: "Saw your talk", score: 7, nested: { a: 1 } }, status: "enrolled", repliedAt: null, bouncedAt: null, unsubscribedAt: null, createdAt: created },
      { id: "c2", email: "bo@example.com", firstName: "Bo", lastName: "Lee", company: null, title: null, website: null, phone: null, location: null, linkedinUrl: null, source: null, lawfulBasisNote: null, customFields: {}, status: "replied", repliedAt: new Date("2026-09-10T09:00:00.000Z"), bouncedAt: null, unsubscribedAt: null, createdAt: created },
    ],
    lists: [{ id: "l1", name: "Founders", description: null }, { id: "l2", name: "Empty", description: "Nothing yet" }],
    listMembers: [
      { contactListId: "l1", contactId: "c1" },
      { contactListId: "l1", contactId: "c2" },
      // Rows that do not belong to this snapshot must never be resolved.
      { contactListId: "l1", contactId: "foreign-contact" },
      { contactListId: "foreign-list", contactId: "c1" },
    ],
    suppressions: [
      { email: "gone@example.com", emailHash: sha("gone@example.com"), reason: "unsubscribed", source: "link", createdAt: created },
      { email: null, emailHash: sha("erased@example.com"), reason: "manual", source: "manual", createdAt: created },
    ],
    sequences: [
      { id: "s1", name: "Intro", status: "active", description: "First touch", customVariablesEnforced: true, steps: [
        { stepOrder: 2, delayDays: 3, subject: "Following up", bodyText: "Any thoughts?", bodyHtml: null },
        { stepOrder: 1, delayDays: 0, subject: "Hi {{firstName}}", bodyText: "{{icebreaker}}", bodyHtml: null },
      ] },
      { id: "s2", name: "Old", status: "archived", description: "", customVariablesEnforced: false, steps: [] },
    ],
    campaigns: [
      { sequenceId: "s1", name: "Intro - Founders", status: "active", emailAccountId: "m-removed", listIds: ["l1", "foreign-list"] },
      { sequenceId: "foreign-sequence", name: "Not ours", status: "active", emailAccountId: "m1", listIds: ["l1"] },
      { sequenceId: "s1", name: "Foreign sender", status: "draft", emailAccountId: "foreign-mailbox", listIds: [] },
    ],
    leadVariables: [
      { sequenceId: "s1", contactId: "c1", values: { icebreaker: "Loved the podcast" } },
      { sequenceId: "s1", contactId: "foreign-contact", values: { icebreaker: "leak" } },
      { sequenceId: "foreign-sequence", contactId: "c1", values: { icebreaker: "leak" } },
    ],
    mailboxes: [
      { id: "m1", email: "sales@acme.test", provider: "gmail", displayName: "Sales", timezone: "Asia/Dubai", dailyLimit: 40, hourlyLimit: 5, sendingWindows: [{ dayOfWeek: 1, startTime: "09:00:00", endTime: "17:00:00", timezone: "Asia/Dubai", isActive: true }] },
      { id: "m-removed", email: "old@acme.test", provider: "outlook", displayName: null, timezone: "UTC", dailyLimit: 20, hourlyLimit: 5, removed: true, sendingWindows: [] },
    ],
    team: [{ email: "owner@acme.test", role: "owner" }, { email: "rep@acme.test", role: "member" }],
    ...overrides,
  };
}

describe("workspace transfer file parsing", () => {
  it("rejects files that are not workspace exports", () => {
    for (const input of [null, "text", [], { format: "something-else", version: 1 }]) {
      expect(transferError(() => parseWorkspaceTransferFile(input)).code).toBe("not_workspace_export");
    }
  });

  it("explains a file from a newer InboxJoy", () => {
    const error = transferError(() => parseWorkspaceTransferFile(baseFile({ version: 2 })));
    expect(error.code).toBe("unsupported_version");
    expect(error.message).toContain("newer than this install supports");
  });

  it("refuses more leads than one import can hold before validating each lead", () => {
    const leads = Array.from({ length: WORKSPACE_TRANSFER_LIMITS.leads + 1 }, () => ({}));
    const error = transferError(() => parseWorkspaceTransferFile(baseFile({ leads })));
    expect(error.code).toBe("import_too_large");
    expect(error.message).toBe("This file has 100,001 leads. One import can hold up to 100,000 leads.");
    expect(error.details).toEqual({ field: "leads", count: 100_001, limit: 100_000 });
  });

  it("points at the first invalid field", () => {
    const error = transferError(() => parseWorkspaceTransferFile(baseFile({ leads: [{ email: "ok@example.com" }, { email: "not an email" }] })));
    expect(error.code).toBe("invalid_export");
    expect(error.message).toContain("leads.1.email");
  });

  it("requires an email or a hash on every suppression", () => {
    const error = transferError(() => parseWorkspaceTransferFile(baseFile({ suppressions: [{ reason: "manual", source: "manual" }] })));
    expect(error.code).toBe("invalid_export");
  });

  it("accepts a minimal file and fills empty collections", () => {
    const file = parseWorkspaceTransferFile(baseFile());
    expect(file).toMatchObject({ leads: [], lists: [], suppressions: [], sequences: [], mailboxes: [], team: [], source: {} });
  });

  it("ignores fields a newer minor release might add", () => {
    const file = parseWorkspaceTransferFile(baseFile({ futureThing: true, leads: [{ email: "a@example.com", futureField: 1 }] }));
    expect(file.leads[0]).toEqual({ email: "a@example.com" });
  });

  it("ignores step variables, however deeply an older or hand-made file nests them", () => {
    let nested: unknown = "leaf";
    for (let depth = 0; depth < 5_000; depth++) nested = { nested };
    const plan = prepareWorkspaceImport(parseWorkspaceTransferFile(baseFile({ sequences: [{ name: "Intro", steps: [{ delayDays: 0, subject: "Hi", bodyText: "Hello", variables: { nested } }] }] })));
    expect(plan.sequences[0]?.steps).toEqual([{ stepOrder: 1, delayDays: 0, subject: "Hi", bodyText: "Hello", bodyHtml: null }]);
  });
});

describe("workspace file shape check", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  it("passes a real export, even fed one byte at a time", () => {
    const text = JSON.stringify(assembleWorkspaceExport(snapshot()));
    expect(() => createWorkspaceFileShapeCheck()(bytes(text))).not.toThrow();
    const check = createWorkspaceFileShapeCheck();
    for (const byte of bytes(text)) check(Uint8Array.of(byte));
  });

  it("stops a body with more objects and arrays than a file at its limits holds", () => {
    const check = createWorkspaceFileShapeCheck({ maxDepth: 10, maxContainers: 4 });
    check(bytes('{"leads":[{},{},'));
    expect(transferError(() => check(bytes("{},"))).code).toBe("import_too_large");
    expect(WORKSPACE_TRANSFER_SHAPE.maxContainers).toBeGreaterThan(WORKSPACE_TRANSFER_LIMITS.leads * 2 + WORKSPACE_TRANSFER_LIMITS.leadVariableRows * 2);
  });

  it("stops a body nested deeper than any workspace file", () => {
    const { maxDepth } = WORKSPACE_TRANSFER_SHAPE;
    expect(transferError(() => createWorkspaceFileShapeCheck()(bytes(`{"a":${"[".repeat(maxDepth)}`))).code).toBe("invalid_export");
    expect(() => createWorkspaceFileShapeCheck()(bytes(`${"[".repeat(maxDepth)}${"]".repeat(maxDepth)}`))).not.toThrow();
  });

  it("does not count brackets inside strings, escaped quotes included", () => {
    const check = createWorkspaceFileShapeCheck({ maxDepth: 2, maxContainers: 2 });
    check(bytes('{"note":"[[[{{{ \\"quoted [[[ \\" ]]]", "emoji":"é😀[",'));
    // An escape split across two chunks.
    check(bytes('"split":"\\'));
    check(bytes('"[[[["}'));
    expect(() => check(bytes('{"a":[]}'))).toThrow(WorkspaceTransferError);
  });
});

describe("workspace import plan", () => {
  it("refuses duplicate lead emails and duplicate list names before touching the database", () => {
    expect(transferError(() => prepareWorkspaceImport(parseWorkspaceTransferFile(baseFile({ leads: [{ email: "A@example.com" }, { email: "a@example.com " }] })))).message)
      .toContain("a@example.com appears more than once");
    expect(transferError(() => prepareWorkspaceImport(parseWorkspaceTransferFile(baseFile({ lists: [{ name: "Leads" }, { name: "Leads" }] })))).message)
      .toContain('Two lists are named "Leads"');
  });

  it("keeps blocking lead states and drops the meaningless enrolled state", () => {
    const plan = prepareWorkspaceImport(parseWorkspaceTransferFile(baseFile({ leads: [
      { email: "a@example.com", status: "enrolled" },
      { email: "b@example.com", status: "replied", repliedAt: "2026-09-10T09:00:00.000Z" },
      { email: "c@example.com", status: "bounced" },
      { email: "d@example.com", status: "unsubscribed" },
      { email: "e@example.com" },
    ] })));
    expect(plan.leads.map((lead) => lead.status)).toEqual(["active", "replied", "bounced", "unsubscribed", "active"]);
    expect(plan.leads[1]?.repliedAt?.toISOString()).toBe("2026-09-10T09:00:00.000Z");
  });

  it("skips list entries and lead variables that name leads outside the file", () => {
    const plan = prepareWorkspaceImport(parseWorkspaceTransferFile(baseFile({
      leads: [{ email: "a@example.com" }],
      lists: [{ name: "Founders", leadEmails: ["A@example.com", "a@example.com", "ghost@example.com"] }],
      sequences: [{ name: "Intro", leadVariables: [{ email: "ghost@example.com", values: { icebreaker: "x" } }, { email: "a@example.com", values: { icebreaker: " hi ", firstName: "Not allowed", "bad name": "x" } }] }],
    })));
    expect(plan.lists[0]?.memberEmails).toEqual(["a@example.com"]);
    expect(plan.skipped).toMatchObject({ listMemberships: 1, leadVariables: 1 });
    expect(plan.sequences[0]?.leadVariables).toEqual([{ normalizedEmail: "a@example.com", values: { icebreaker: "hi" } }]);
    expect(plan.warnings.join(" ")).toContain("1 list entries");
    expect(plan.warnings.join(" ")).toContain("2 campaign variable values");
  });

  it("recomputes suppression hashes from the address and keeps hash-only rows", () => {
    const plan = prepareWorkspaceImport(parseWorkspaceTransferFile(baseFile({ suppressions: [
      { email: "Gone@Example.com", emailHash: sha("someone-else@example.com"), reason: "Unsubscribed via link", source: "link" },
      { emailHash: sha("erased@example.com"), reason: "spam complaint", source: "webhook" },
      { email: "gone@example.com", reason: "manual", source: "manual" },
    ] })));
    expect(plan.suppressions).toEqual([
      expect.objectContaining({ email: "Gone@Example.com", normalizedEmail: "gone@example.com", emailHash: sha("gone@example.com"), reason: "unsubscribed" }),
      expect.objectContaining({ email: null, normalizedEmail: null, emailHash: sha("erased@example.com"), reason: "complained" }),
    ]);
    expect(plan.skipped.suppressions).toBe(1);
  });

  it("brings every campaign in as a draft, keeps archived ones archived and renumbers steps", () => {
    const plan = prepareWorkspaceImport(parseWorkspaceTransferFile(baseFile({
      lists: [{ name: "Founders" }],
      sequences: [
        { name: "Live", status: "active", steps: [{ delayDays: 0, subject: "Hi", bodyText: "Hello" }, { delayDays: 2, subject: "Re", bodyText: "Again" }], campaigns: [{ name: "Live - Founders", status: "active", listNames: ["Founders", "Missing"], senderEmail: "Sales@Acme.test" }] },
        { name: "Paused", status: "paused" },
        { name: "Finished", status: "completed" },
        { name: "Gone", status: "archived" },
      ],
    })));
    expect(plan.sequences.map((sequence) => [sequence.sourceStatus, sequence.status])).toEqual([["active", "draft"], ["paused", "draft"], ["completed", "draft"], ["archived", "archived"]]);
    expect(plan.sequences[0]?.steps.map((step) => step.stepOrder)).toEqual([1, 2]);
    expect(plan.sequences[0]?.campaigns).toEqual([{ name: "Live - Founders", sourceStatus: "active", listNames: ["Founders"], senderEmail: "sales@acme.test" }]);
  });

  it("invites a previous owner as an admin and never turns the sending pause off", () => {
    const plan = prepareWorkspaceImport(parseWorkspaceTransferFile(baseFile({ team: [{ email: "Boss@Acme.test", role: "owner" }, { email: "rep@acme.test", role: "member" }, { email: "REP@acme.test", role: "admin" }] })));
    expect(plan.team).toEqual([{ email: "Boss@Acme.test", normalizedEmail: "boss@acme.test", role: "admin" }, { email: "rep@acme.test", normalizedEmail: "rep@acme.test", role: "member" }]);
    expect(plan.workspace.killSwitchEnabled).toBe(false);
    expect(plan.warnings.join(" ")).toContain("invited as an admin");
    const paused = prepareWorkspaceImport(parseWorkspaceTransferFile(baseFile({ workspace: { name: "Paused", killSwitchEnabled: true } })));
    expect(paused.workspace.killSwitchEnabled).toBe(true);
  });

  it("keeps the current timezone when the file names one this runtime does not know", () => {
    const plan = prepareWorkspaceImport(parseWorkspaceTransferFile(baseFile({ workspace: { name: "Acme", defaultTimezone: "Mars/Olympus_Mons" } })));
    expect(plan.workspace.defaultTimezone).toBeNull();
    expect(plan.warnings.join(" ")).toContain("Mars/Olympus_Mons");
  });
});

describe("workspace export assembly", () => {
  it("never resolves rows outside the snapshot", () => {
    const file = assembleWorkspaceExport(snapshot());
    const text = JSON.stringify(file);
    expect(text).not.toContain("leak");
    expect(text).not.toContain("Not ours");
    expect(file.lists.find((list) => list.name === "Founders")?.leadEmails).toEqual(["Ana@Example.com", "bo@example.com"]);
    const intro = file.sequences.find((sequence) => sequence.name === "Intro")!;
    expect(intro.campaigns).toEqual([
      { name: "Intro - Founders", status: "active", listNames: ["Founders"], senderEmail: "old@acme.test" },
      { name: "Foreign sender", status: "draft", listNames: [] },
    ]);
    expect(intro.leadVariables).toEqual([{ email: "Ana@Example.com", values: { icebreaker: "Loved the podcast" } }]);
  });

  it("lists removed mailboxes as senders only, never as mailboxes to reconnect", () => {
    const file = assembleWorkspaceExport(snapshot());
    expect(file.mailboxes.map((mailbox) => mailbox.email)).toEqual(["sales@acme.test"]);
    expect(file.mailboxes[0]).toMatchObject({ provider: "gmail", dailyLimit: 40, sendingWindows: [{ dayOfWeek: 1, startTime: "09:00:00", endTime: "17:00:00" }] });
  });

  it("orders steps, keeps hash-only suppressions without an address and omits empty fields", () => {
    const file = assembleWorkspaceExport(snapshot());
    expect(file.sequences[0]?.steps.map((step) => step.subject)).toEqual(["Hi {{firstName}}", "Following up"]);
    expect(file.suppressions).toEqual([
      { email: "gone@example.com", reason: "unsubscribed", source: "link", createdAt: "2026-09-01T08:00:00.000Z" },
      { emailHash: sha("erased@example.com"), reason: "manual", source: "manual", createdAt: "2026-09-01T08:00:00.000Z" },
    ]);
    expect(file.leads[0]).not.toHaveProperty("lastName");
    expect(file.leads[0]).not.toHaveProperty("title");
    expect(file.leads[0]).not.toHaveProperty("status");
    expect(file.leads[1]).toMatchObject({ status: "replied", repliedAt: "2026-09-10T09:00:00.000Z" });
  });

  it("round-trips through JSON into an import plan with the same content", () => {
    const file = assembleWorkspaceExport(snapshot());
    const plan = prepareWorkspaceImport(parseWorkspaceTransferFile(JSON.parse(JSON.stringify(file))));
    expect(plan.workspace).toEqual({ name: "Acme outbound", defaultTimezone: "Asia/Dubai", dailySendCap: 300, killSwitchEnabled: false, openTrackingEnabled: true, postalAddress: "1 Main St" });
    expect(plan.leads.map((lead) => [lead.normalizedEmail, lead.status])).toEqual([["ana@example.com", "active"], ["bo@example.com", "replied"]]);
    expect(plan.leads[0]?.customFields).toEqual({ icebreaker: "Saw your talk", score: 7, nested: '{"a":1}' });
    expect(plan.lists).toEqual([{ name: "Founders", description: null, memberEmails: ["ana@example.com", "bo@example.com"] }, { name: "Empty", description: "Nothing yet", memberEmails: [] }]);
    expect(plan.sequences.map((sequence) => [sequence.name, sequence.status, sequence.customVariablesEnforced, sequence.steps.length])).toEqual([["Intro", "draft", true, 2], ["Old", "archived", false, 0]]);
    expect(plan.sequences[0]?.description).toBe("First touch");
    expect(plan.suppressions.map((row) => row.emailHash)).toEqual([sha("gone@example.com"), sha("erased@example.com")]);
    expect(plan.team.map((member) => member.role)).toEqual(["admin", "member"]);
    expect(plan.source).toEqual({ edition: "cloud", appVersion: "abc123" });
    expect(plan.skipped).toEqual({ listMemberships: 0, leadVariables: 0, suppressions: 0, teamMembers: 0 });
  });

  it("produces a file that passes its own validation even for odd stored custom fields", () => {
    const odd = snapshot({ contacts: [{ ...snapshot().contacts[0]!, customFields: { long: "x".repeat(9_000), nan: Number.NaN, list: [1, 2], "": "empty key", nothing: null } }] });
    const file = assembleWorkspaceExport(odd);
    expect(() => parseWorkspaceTransferFile(JSON.parse(JSON.stringify(file)))).not.toThrow();
    expect(normalizeCustomFields({ long: "x".repeat(9_000) }).long).toHaveLength(5_000);
  });
});

describe("workspace transfer helpers", () => {
  it("normalizes suppression reasons the way the database trigger does", () => {
    expect(["Unsubscribed", "hard bounce", "Spam report", "blocked domain", "customer", "manual_suppression", "anything"].map(normalizeSuppressionReason))
      .toEqual(["unsubscribed", "bounced", "complained", "blocked", "customer", "manual", "manual"]);
  });

  it("names the download after the workspace and date", () => {
    const at = new Date("2026-10-29T23:30:00.000Z");
    expect(workspaceExportFilename("Acme Outbound / EU", at)).toBe("inboxjoy-acme-outbound-eu-2026-10-29.json");
    expect(workspaceExportFilename("نشاط", at)).toBe("inboxjoy-workspace-2026-10-29.json");
  });
});
