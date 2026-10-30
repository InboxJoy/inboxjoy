export type WizardStepContent = {
  delayDays: number;
  subject: string;
  body: string;
};

export type WizardDraftTone = "direct" | "friendly";

export type AudienceList = {
  id: string;
  name: string;
  count?: number;
  contactCount?: number;
};

export const MAX_AUDIENCE_LISTS = 20;

export function audienceListCount(list?: Pick<AudienceList, "count" | "contactCount">) {
  return list?.count ?? list?.contactCount ?? 0;
}

export function hasMatchingStepSnapshot(
  steps: Array<{ id: string; subject: string; body: string }>,
  stepId: string,
  source: { subject: string; body: string },
) {
  const step = steps.find((candidate) => candidate.id === stepId);
  return Boolean(step && step.subject === source.subject && step.body === source.body);
}

// Keeps "same thread" follow-ups (subject === `Re: <first step subject>`) in sync when the
// first step's subject changes. `steps` is the array with the first step's subject already
// updated; `previousFirstSubject` is what it was before. Custom subjects and steps whose id is
// in `editingNewSubjectIds` are left alone. A change to any step other than the first is a no-op.
export function syncThreadedFollowUpSubjects<T extends { id: string; subject: string }>(
  steps: T[],
  changedIndex: number,
  previousFirstSubject: string,
  editingNewSubjectIds: ReadonlySet<string>,
): T[] {
  if (changedIndex !== 0) return steps;
  const nextFirstSubject = steps[0]?.subject ?? "";
  if (nextFirstSubject === previousFirstSubject) return steps;
  return steps.map((step, stepIndex) => {
    if (stepIndex === 0 || editingNewSubjectIds.has(step.id)) return step;
    if (step.subject === `Re: ${previousFirstSubject}`) return { ...step, subject: `Re: ${nextFirstSubject}` };
    return step;
  });
}

export function normalizeAudienceListIds(value: unknown, legacyAudience?: unknown, availableIds?: Set<string>) {
  const source = Array.isArray(value)
    ? value
    : typeof legacyAudience === "string" && legacyAudience !== "all"
      ? [legacyAudience]
      : [];
  return [...new Set(source.filter((id): id is string => typeof id === "string" && (!availableIds || availableIds.has(id))))].slice(0, MAX_AUDIENCE_LISTS);
}

export function toggleAudienceListId(listIds: string[], listId: string) {
  if (listIds.includes(listId)) return listIds.filter((id) => id !== listId);
  if (listIds.length >= MAX_AUDIENCE_LISTS) return listIds;
  return [...listIds, listId];
}

export function audienceNames(listIds: string[], lists: AudienceList[]) {
  if (listIds.length === 0) return "All ready leads";
  const namesById = new Map(lists.map((list) => [list.id, list.name]));
  return listIds.map((id) => namesById.get(id) ?? "Unavailable list").join(", ");
}

export function audienceTotalLabel(listIds: string[], lists: AudienceList[], readyCount: number) {
  if (listIds.length === 0) return `${readyCount.toLocaleString()} ready contacts`;
  const selectedIds = new Set(listIds);
  const total = lists.reduce((sum, list) => sum + (selectedIds.has(list.id) ? audienceListCount(list) : 0), 0);
  return `${listIds.length > 1 ? "Up to " : ""}${total.toLocaleString()} contacts across ${listIds.length.toLocaleString()} ${listIds.length === 1 ? "list" : "lists"}`;
}

export function wizardStepsFingerprint(steps: WizardStepContent[]) {
  return JSON.stringify(steps.map(({ delayDays, subject, body }) => ({ delayDays, subject, body })));
}

export function hasEditedWizardSteps(steps: WizardStepContent[], sourceFingerprint: string) {
  return wizardStepsFingerprint(steps) !== sourceFingerprint;
}

export function localizeWizardSteps(
  steps: WizardStepContent[],
  createId: (index: number) => string = (index) => `local-${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`,
) {
  return steps.map((step, index) => ({ ...step, id: createId(index) }));
}

export function buildWizardDraftRequest(description: string, tone: WizardDraftTone, stepCount: number) {
  return { description: description.trim(), tone, stepCount };
}

export function restoreWizardMailboxIds(value: unknown, legacySenderId?: unknown): string[] {
  const source = Array.isArray(value) ? value : typeof legacySenderId === "string" && legacySenderId ? [legacySenderId] : [];
  return [...new Set(source.filter((id): id is string => typeof id === "string" && id.length > 0))];
}

export function buildWizardLaunchRequest(mailboxIds: readonly string[]) {
  return { mailboxIds: [...new Set(mailboxIds)] };
}

export function getLaunchBlocker(audienceCount: number, senderReady: boolean, sequenceReady: boolean) {
  if (audienceCount <= 0) return "No eligible contacts — pick an audience";
  if (!senderReady) return "Choose a mailbox";
  if (!sequenceReady) return "Complete every campaign step";
  return "";
}
