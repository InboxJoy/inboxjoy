import { describe, expect, it } from "vitest";

import { canSaveCampaignChanges, getMailboxSelectionState } from "./sender-mailboxes";

describe("saved campaign sender mailboxes", () => {
  it("treats a missing saved selection as all healthy mailboxes", () => {
    expect(getMailboxSelectionState(undefined, "all", [])).toEqual({ mailboxIds: [], dirty: false, valid: true });
    expect(getMailboxSelectionState([], "all", ["mailbox-a"])).toEqual({ mailboxIds: [], dirty: false, valid: true });
  });

  it("compares selections as sets without treating ordering or duplicate ids as edits", () => {
    expect(getMailboxSelectionState(["mailbox-a", "mailbox-b"], "selected", ["mailbox-b", "mailbox-a", "mailbox-a"]).dirty).toBe(false);
    expect(getMailboxSelectionState(["mailbox-a", "mailbox-a"], "selected", ["mailbox-a"]).dirty).toBe(false);
  });

  it("detects additions, removals, replacements, and a return to the saved selection", () => {
    expect(getMailboxSelectionState(["mailbox-a"], "selected", ["mailbox-a", "mailbox-b"]).dirty).toBe(true);
    expect(getMailboxSelectionState(["mailbox-a", "mailbox-b"], "selected", ["mailbox-a"]).dirty).toBe(true);
    expect(getMailboxSelectionState(["mailbox-a"], "selected", ["mailbox-b"]).dirty).toBe(true);
    expect(getMailboxSelectionState(["mailbox-a"], "selected", ["mailbox-a"]).dirty).toBe(false);
  });

  it("clears saved mailbox ids when switching to all healthy mailboxes", () => {
    expect(getMailboxSelectionState(["mailbox-a"], "all", ["mailbox-a"])).toEqual({ mailboxIds: [], dirty: true, valid: true });
    expect(getMailboxSelectionState([], "selected", ["mailbox-a"])).toEqual({ mailboxIds: ["mailbox-a"], dirty: true, valid: true });
  });

  it("keeps empty specific mode dirty and invalid so enrollment waits for a save", () => {
    expect(getMailboxSelectionState([], "selected", [])).toEqual({ mailboxIds: [], dirty: true, valid: false });
    expect(getMailboxSelectionState(["mailbox-a"], "selected", [])).toEqual({ mailboxIds: [], dirty: true, valid: false });
  });

  it.each([undefined, "draft", "paused", "completed"])("keeps content saving enabled for %s even with an invalid mailbox selection", (status) => {
    const invalidSelection = getMailboxSelectionState([], "selected", []);
    expect(canSaveCampaignChanges(status, invalidSelection, false)).toBe(true);
  });

  it.each(["active", "published"])("blocks saving while %s when the mailbox selection is dirty but invalid", (status) => {
    const invalidSelection = getMailboxSelectionState([], "selected", []);
    expect(canSaveCampaignChanges(status, invalidSelection, false)).toBe(false);
  });

  it.each(["active", "published"])("allows saving while %s when the mailbox selection is dirty and valid", (status) => {
    const validSelection = getMailboxSelectionState([], "selected", ["mailbox-a"]);
    expect(canSaveCampaignChanges(status, validSelection, false)).toBe(true);
  });

  it.each(["active", "published"])("blocks saving while %s when the mailbox selection is unchanged", (status) => {
    const unchanged = getMailboxSelectionState([], "all", []);
    expect(canSaveCampaignChanges(status, unchanged, false)).toBe(false);
  });

  it("blocks saving while busy regardless of status or selection validity", () => {
    const validSelection = getMailboxSelectionState([], "selected", ["mailbox-a"]);
    expect(canSaveCampaignChanges("draft", validSelection, true)).toBe(false);
    expect(canSaveCampaignChanges("active", validSelection, true)).toBe(false);
  });

  it.each(["archived"])("keeps saving disabled while %s", (status) => {
    expect(canSaveCampaignChanges(status, getMailboxSelectionState([], "selected", ["mailbox-a"]), false)).toBe(false);
  });
});
