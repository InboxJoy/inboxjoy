export type SenderMode = "all" | "selected";

export function getMailboxSelectionState(savedMailboxIds: readonly string[] | undefined, senderMode: SenderMode, selectedMailboxIds: readonly string[]) {
  const savedIds = new Set(savedMailboxIds ?? []);
  const mailboxIds = senderMode === "selected" ? [...new Set(selectedMailboxIds)] : [];
  const savedMode: SenderMode = savedIds.size > 0 ? "selected" : "all";
  return {
    mailboxIds,
    dirty: senderMode !== savedMode || mailboxIds.length !== savedIds.size || mailboxIds.some((id) => !savedIds.has(id)),
    valid: senderMode === "all" || mailboxIds.length > 0,
  };
}

export function canSaveCampaignChanges(status: string | undefined, selection: { dirty: boolean; valid: boolean }, busy: boolean) {
  const contentEditable = status === undefined || status === "draft" || status === "paused" || status === "completed";
  const mailboxesEditable = status === "active" || status === "published";
  return !busy && (contentEditable || (mailboxesEditable && selection.dirty && selection.valid));
}
