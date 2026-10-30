import { describe, expect, it } from "vitest";

import {
  audienceNames,
  audienceTotalLabel,
  buildWizardDraftRequest,
  buildWizardLaunchRequest,
  getLaunchBlocker,
  hasMatchingStepSnapshot,
  hasEditedWizardSteps,
  localizeWizardSteps,
  normalizeAudienceListIds,
  restoreWizardMailboxIds,
  syncThreadedFollowUpSubjects,
  toggleAudienceListId,
  wizardStepsFingerprint,
} from "./wizard-state";

const step = (subject: string) => ({ delayDays: 0, subject, body: `${subject} body` });

describe("campaign wizard draft and template state", () => {
  it("builds a redraft request with the current step count", () => {
    expect(buildWizardDraftRequest("  Reach finance leaders  ", "friendly", 5)).toEqual({
      description: "Reach finance leaders",
      tone: "friendly",
      stepCount: 5,
    });
  });

  it("returns only the new draft steps when the requested count changes", () => {
    const previous = localizeWizardSteps([step("One"), step("Two"), step("Three")], (index) => `old-${index}`);
    const replacement = localizeWizardSteps(
      [step("Fresh 1"), step("Fresh 2"), step("Fresh 3"), step("Fresh 4"), step("Fresh 5")],
      (index) => `new-${index}`,
    );

    expect(previous).toHaveLength(3);
    expect(replacement).toHaveLength(5);
    expect(replacement.map(({ subject }) => subject)).toEqual(["Fresh 1", "Fresh 2", "Fresh 3", "Fresh 4", "Fresh 5"]);
  });

  it("detects manual edits without treating regenerated local ids as edits", () => {
    const sourceSteps = localizeWizardSteps([step("First"), step("Second")], (index) => `source-${index}`);
    const sourceFingerprint = wizardStepsFingerprint(sourceSteps);
    const regeneratedIds = localizeWizardSteps([step("First"), step("Second")], (index) => `restored-${index}`);

    expect(hasEditedWizardSteps(regeneratedIds, sourceFingerprint)).toBe(false);
    expect(hasEditedWizardSteps([{ ...regeneratedIds[0]!, subject: "Edited" }, regeneratedIds[1]!], sourceFingerprint)).toBe(true);
  });

  it("names the first launch blocker in review order", () => {
    expect(getLaunchBlocker(0, false, false)).toBe("No eligible contacts — pick an audience");
    expect(getLaunchBlocker(12, false, false)).toBe("Choose a mailbox");
    expect(getLaunchBlocker(12, true, false)).toBe("Complete every campaign step");
    expect(getLaunchBlocker(12, true, true)).toBe("");
  });

  it("restores current list arrays and legacy single-list audiences", () => {
    const availableIds = new Set(["list-a", "list-b"]);

    expect(normalizeAudienceListIds(["list-a", "list-a", "missing"], undefined, availableIds)).toEqual(["list-a"]);
    expect(normalizeAudienceListIds(undefined, "list-b", availableIds)).toEqual(["list-b"]);
    expect(normalizeAudienceListIds(undefined, "all", availableIds)).toEqual([]);
    expect(normalizeAudienceListIds(Array.from({ length: 24 }, (_, index) => `list-${index}`))).toHaveLength(20);
  });

  it("describes all-ready, single-list, and overlapping multi-list totals", () => {
    const lists = [
      { id: "list-a", name: "Founders", count: 12 },
      { id: "list-b", name: "Operators", contactCount: 8 },
    ];

    expect(audienceNames([], lists)).toBe("All ready leads");
    expect(audienceNames(["list-a", "list-b"], lists)).toBe("Founders, Operators");
    expect(audienceTotalLabel([], lists, 30)).toBe("30 ready contacts");
    expect(audienceTotalLabel(["list-a"], lists, 30)).toBe("12 contacts across 1 list");
    expect(audienceTotalLabel(["list-a", "list-b"], lists, 30)).toBe("Up to 20 contacts across 2 lists");
  });

  it("adds and removes list selections without exceeding the API limit", () => {
    expect(toggleAudienceListId(["list-a"], "list-b")).toEqual(["list-a", "list-b"]);
    expect(toggleAudienceListId(["list-a", "list-b"], "list-a")).toEqual(["list-b"]);
    const twentyLists = Array.from({ length: 20 }, (_, index) => `list-${index}`);
    expect(toggleAudienceListId(twentyLists, "list-20")).toEqual(twentyLists);
  });

  it("restores saved mailbox selections and legacy single-sender drafts", () => {
    expect(restoreWizardMailboxIds(["mailbox-b", "mailbox-a", "mailbox-b"])).toEqual(["mailbox-b", "mailbox-a"]);
    expect(restoreWizardMailboxIds(undefined, "mailbox-a")).toEqual(["mailbox-a"]);
    expect(restoreWizardMailboxIds(undefined)).toEqual([]);
    expect(restoreWizardMailboxIds([], "mailbox-a")).toEqual([]);
    expect(restoreWizardMailboxIds(["mailbox-a", null, 12, ""])).toEqual(["mailbox-a"]);
  });

  it("includes the full mailbox selection on launch and clears it for all-mailbox rotation", () => {
    expect(buildWizardLaunchRequest(["mailbox-a", "mailbox-b", "mailbox-a"])).toEqual({ mailboxIds: ["mailbox-a", "mailbox-b"] });
    expect(buildWizardLaunchRequest(restoreWizardMailboxIds(undefined, "mailbox-a"))).toEqual({ mailboxIds: ["mailbox-a"] });
    expect(buildWizardLaunchRequest([])).toEqual({ mailboxIds: [] });
  });
});

describe("step refinement snapshots", () => {
  const source = { subject: "Hello", body: "Original" };

  it("matches the same step after it moves", () => {
    expect(hasMatchingStepSnapshot([
      { id: "other", subject: "Other", body: "Email" },
      { id: "target", ...source },
    ], "target", source)).toBe(true);
  });

  it("ignores a removed step or one edited while refinement is running", () => {
    expect(hasMatchingStepSnapshot([], "target", source)).toBe(false);
    expect(hasMatchingStepSnapshot([
      { id: "target", subject: "Changed", body: source.body },
    ], "target", source)).toBe(false);
  });
});

describe("syncThreadedFollowUpSubjects", () => {
  it("updates linked Re: follow-ups when the first step's subject changes", () => {
    const steps = [
      { id: "first", subject: "New idea for {{company}}" },
      { id: "second", subject: "Re: Old idea for {{company}}" },
      { id: "third", subject: "Re: Old idea for {{company}}" },
    ];

    expect(syncThreadedFollowUpSubjects(steps, 0, "Old idea for {{company}}", new Set())).toEqual([
      { id: "first", subject: "New idea for {{company}}" },
      { id: "second", subject: "Re: New idea for {{company}}" },
      { id: "third", subject: "Re: New idea for {{company}}" },
    ]);
  });

  it("leaves custom-subject follow-ups and ids in the editing set alone", () => {
    const steps = [
      { id: "first", subject: "New idea" },
      { id: "custom", subject: "A totally different subject" },
      { id: "editing", subject: "Re: Old idea" },
    ];

    expect(syncThreadedFollowUpSubjects(steps, 0, "Old idea", new Set(["editing"]))).toEqual([
      { id: "first", subject: "New idea" },
      { id: "custom", subject: "A totally different subject" },
      { id: "editing", subject: "Re: Old idea" },
    ]);
  });

  it("does nothing when the changed step is not the first step", () => {
    const steps = [
      { id: "first", subject: "Old idea" },
      { id: "second", subject: "Re: Old idea" },
    ];

    expect(syncThreadedFollowUpSubjects(steps, 1, "Old idea", new Set())).toBe(steps);
  });
});
