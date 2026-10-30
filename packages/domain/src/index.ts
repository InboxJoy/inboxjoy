export const sequenceStates = ["draft", "active", "paused", "completed", "archived"] as const;
export type SequenceState = (typeof sequenceStates)[number];

export const enrollmentStates = [
  "scheduled",
  "active",
  "paused",
  "replied",
  "bounced",
  "unsubscribed",
  "completed",
  "cancelled",
] as const;
export type EnrollmentState = (typeof enrollmentStates)[number];

export const messageStates = ["scheduled", "claimed", "sending", "accepted", "retryable", "failed", "cancelled"] as const;
export type MessageState = (typeof messageStates)[number];

export const mailboxStates = ["connecting", "active", "paused", "expired", "error", "disconnected"] as const;
export type MailboxState = (typeof mailboxStates)[number];

export type StopReason = "reply" | "bounce" | "unsubscribe" | "manual" | "workspace_paused" | "mailbox_paused";

const sequenceTransitions: Record<SequenceState, readonly SequenceState[]> = {
  draft: ["active", "archived"],
  active: ["paused", "completed", "archived"],
  paused: ["active", "archived"],
  completed: ["archived"],
  archived: [],
};

const enrollmentTransitions: Record<EnrollmentState, readonly EnrollmentState[]> = {
  scheduled: ["active", "paused", "cancelled", "replied", "bounced", "unsubscribed"],
  active: ["paused", "completed", "cancelled", "replied", "bounced", "unsubscribed"],
  paused: ["active", "cancelled", "replied", "bounced", "unsubscribed"],
  replied: [],
  bounced: [],
  unsubscribed: [],
  completed: [],
  cancelled: [],
};

const messageTransitions: Record<MessageState, readonly MessageState[]> = {
  scheduled: ["claimed", "cancelled"],
  claimed: ["sending", "retryable", "failed", "cancelled"],
  sending: ["accepted", "retryable", "failed"],
  accepted: [],
  retryable: ["claimed", "failed", "cancelled"],
  failed: [],
  cancelled: [],
};

const mailboxTransitions: Record<MailboxState, readonly MailboxState[]> = {
  connecting: ["active", "error", "disconnected"],
  active: ["paused", "expired", "error", "disconnected"],
  paused: ["active", "expired", "error", "disconnected"],
  expired: ["active", "disconnected"],
  error: ["active", "paused", "disconnected"],
  disconnected: [],
};

export function canTransitionSequence(from: SequenceState, to: SequenceState): boolean {
  return sequenceTransitions[from].includes(to);
}

export function canTransitionEnrollment(from: EnrollmentState, to: EnrollmentState): boolean {
  return enrollmentTransitions[from].includes(to);
}

export function canTransitionMessage(from: MessageState, to: MessageState): boolean {
  return messageTransitions[from].includes(to);
}

export function canTransitionMailbox(from: MailboxState, to: MailboxState): boolean {
  return mailboxTransitions[from].includes(to);
}

export function nextEnrollmentStopState(reason: StopReason): EnrollmentState {
  switch (reason) {
    case "reply":
      return "replied";
    case "bounce":
      return "bounced";
    case "unsubscribe":
      return "unsubscribed";
    default:
      return "cancelled";
  }
}

export function buildMessageIdempotencyKey(input: {
  enrollmentId: string;
  sequenceStepId: string;
  attemptKind?: "sequence" | "test" | "retry";
}): string {
  return `${input.enrollmentId}:${input.sequenceStepId}:${input.attemptKind ?? "sequence"}`;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
