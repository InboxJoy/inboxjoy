import type { MailboxHealthState } from "./can-send.js";

export const PROVIDER_CIRCUIT_FAILURE_THRESHOLD = 5;

export type MailboxHealthSnapshot = {
  state: MailboxHealthState | string;
  effectiveDailyLimit: number | null;
  consecutiveFailures: number;
  tempFailures24h: number;
  permFailures24h: number;
  throttledUntil: Date | null;
};

export type MailboxFailureKind = "temporary" | "permanent" | "auth" | "unknown";

export function mailboxHealthAfterFailure(
  current: MailboxHealthSnapshot,
  baseDailyLimit: number,
  kind: MailboxFailureKind,
  now: Date,
  retryAfter?: Date,
): MailboxHealthSnapshot {
  const effective = Math.max(1, current.effectiveDailyLimit ?? baseDailyLimit);
  const consecutiveFailures = current.consecutiveFailures + 1;

  if (kind === "auth") {
    return {
      ...current,
      state: "auth_error",
      consecutiveFailures,
      permFailures24h: current.permFailures24h + 1,
      throttledUntil: null,
    };
  }

  if (kind === "temporary" || kind === "unknown") {
    const repeated = consecutiveFailures >= 2;
    const continued = current.state === "throttled" || consecutiveFailures >= 3;
    const throttleUntil = retryAfter && retryAfter > now
      ? retryAfter
      : new Date(now.getTime() + (continued ? 2 * 60 * 60_000 : 30 * 60_000));
    return {
      ...current,
      state: repeated ? "throttled" : current.state,
      effectiveDailyLimit: repeated ? Math.max(1, Math.floor(effective / 2)) : effective,
      consecutiveFailures,
      tempFailures24h: current.tempFailures24h + 1,
      throttledUntil: repeated ? throttleUntil : current.throttledUntil,
    };
  }

  return {
    ...current,
    consecutiveFailures,
    permFailures24h: current.permFailures24h + 1,
  };
}

export function mailboxHealthAfterSuccess(current: MailboxHealthSnapshot, baseDailyLimit: number): MailboxHealthSnapshot {
  const effective = Math.max(1, current.effectiveDailyLimit ?? baseDailyLimit);
  const restored = Math.min(baseDailyLimit, effective + Math.max(1, Math.ceil(baseDailyLimit / 4)));
  const consecutiveFailures = Math.max(0, current.consecutiveFailures - 1);
  return {
    ...current,
    state: restored >= baseDailyLimit && consecutiveFailures === 0 ? "healthy" : "throttled",
    effectiveDailyLimit: restored,
    consecutiveFailures,
    throttledUntil: null,
  };
}
