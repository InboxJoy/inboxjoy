// Pure response-mapping and formatting helpers for the delivery advisor card.
// Kept dependency-free (no React) so they get real Vitest coverage without
// React Testing Library, per the existing convention in this directory
// (campaign-data.ts, sender-mailboxes.ts).

export type DeliveryAdvisorFindingSeverity = "info" | "warning" | "danger";
export type DeliveryAdvisorFindingSource = "observed" | "recorded";
export type DeliveryAdvisorNavigationTarget = "mailboxes" | "billing" | "sequence";

export type DeliveryAdvisorFinding = {
  code: string;
  severity: DeliveryAdvisorFindingSeverity;
  source: DeliveryAdvisorFindingSource;
  observedAt: string;
  message: string;
  navigationTarget: DeliveryAdvisorNavigationTarget | null;
};

export type DeliveryAdvisorSenderCapacity = {
  dailyLimit: number;
  hourlyLimit: number;
  effectiveDailyLimit: number | null;
  warmupDailyLimit: number | null;
  sentToday: number | null;
  sentLastHour: number | null;
  remainingToday: number | null;
  remainingThisHour: number | null;
};

export type DeliveryAdvisorSender = {
  emailAccountId: string;
  email: string | null;
  status: string;
  healthState: string | null;
  throttledUntil: string | null;
  providerCircuitState: string | null;
  pendingEnrollments: number;
  capacity: DeliveryAdvisorSenderCapacity | null;
};

export type DeliveryAdvisorWorkspaceCapacity = {
  dailySendCap: number;
  sentToday: number | null;
  remainingToday: number | null;
};

export type DeliveryAdvisorSnapshot = {
  campaignId: string;
  asOf: string;
  completeness: "complete" | "partial";
  campaign: { name: string; status: string; displayStatus: string; statusReason: string | null };
  findings: DeliveryAdvisorFinding[];
  senders: DeliveryAdvisorSender[];
  workspaceCapacity: DeliveryAdvisorWorkspaceCapacity | null;
  nextScheduledAt: string | null;
  nextScheduledNote: "campaign_paused" | "sequence_paused" | null;
};

export type DeliveryAdvisorResponse =
  | { enabled: false }
  | { enabled: true; status: "ready" | "partial" | "unavailable"; asOf: string; snapshot: DeliveryAdvisorSnapshot | null };

export type DeliveryAdvisorFetchOutcome = DeliveryAdvisorResponse | { transportError: true };

export type DeliveryAdvisorContentState =
  | { kind: "hidden" }
  | { kind: "ready"; snapshot: DeliveryAdvisorSnapshot; partial: boolean }
  | { kind: "unavailable"; staleSnapshot: DeliveryAdvisorSnapshot | null; lastCheckedAt: string | null };

// The single state transition the card runs on every fetch/refresh outcome.
// An initial transport failure (never having confirmed enabled:true) must not
// expose a card in a disabled workspace, so it stays hidden rather than
// guessing. Once a workspace is confirmed enabled, a later failure degrades
// to "unavailable" and keeps whatever snapshot was last fetched, labelled
// stale by the caller rather than discarded.
export function mapDeliveryAdvisorResponse(outcome: DeliveryAdvisorFetchOutcome, previous: DeliveryAdvisorContentState): DeliveryAdvisorContentState {
  if ("transportError" in outcome) {
    if (previous.kind === "hidden") return { kind: "hidden" };
    return {
      kind: "unavailable",
      staleSnapshot: previous.kind === "ready" ? previous.snapshot : previous.staleSnapshot,
      lastCheckedAt: previous.kind === "ready" ? previous.snapshot.asOf : previous.lastCheckedAt,
    };
  }
  if (!outcome.enabled) return { kind: "hidden" };
  if (outcome.status === "unavailable" || !outcome.snapshot) {
    return {
      kind: "unavailable",
      staleSnapshot: previous.kind === "ready" ? previous.snapshot : previous.kind === "unavailable" ? previous.staleSnapshot : null,
      lastCheckedAt: previous.kind === "ready" ? previous.snapshot.asOf : previous.kind === "unavailable" ? previous.lastCheckedAt : null,
    };
  }
  return { kind: "ready", snapshot: outcome.snapshot, partial: outcome.status === "partial" };
}

export function isStaleRequest(requestId: number, currentRequestId: number): boolean {
  return requestId !== currentRequestId;
}

export function findingTone(severity: DeliveryAdvisorFindingSeverity): "neutral" | "good" | "warning" | "danger" | "info" {
  if (severity === "danger") return "danger";
  if (severity === "warning") return "warning";
  return "info";
}

// "No known blockers" (never "Ready to send") is earned only when there is no
// currently observed warning/danger condition. Historical/recorded entries
// and informational notes (draft, finished, archived) don't count as blockers.
export function blockingFindings(findings: readonly DeliveryAdvisorFinding[]): DeliveryAdvisorFinding[] {
  return findings.filter((finding) => finding.source === "observed" && finding.severity !== "info");
}

// Historical blocked reasons are shown separately from live attention items,
// each with its own recorded timestamp, never presented as a freshly
// evaluated condition. Newest first.
export function recordedFindings(findings: readonly DeliveryAdvisorFinding[]): DeliveryAdvisorFinding[] {
  return findings
    .filter((finding) => finding.source === "recorded")
    .slice()
    .sort((left, right) => new Date(right.observedAt).getTime() - new Date(left.observedAt).getTime());
}

export function navigationHref(target: DeliveryAdvisorNavigationTarget | null): string | null {
  if (target === "mailboxes") return "/app/inboxes";
  if (target === "billing") return "/app/settings/billing";
  return null;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export function formatLastChecked(asOf: string | null, now: Date = new Date()): string {
  if (!asOf) return "Not checked yet";
  const then = new Date(asOf).getTime();
  if (!Number.isFinite(then)) return "Not checked yet";
  const diffMs = Math.max(0, now.getTime() - then);
  if (diffMs < MINUTE_MS) return "Checked just now";
  if (diffMs < HOUR_MS) {
    const minutes = Math.round(diffMs / MINUTE_MS);
    return `Checked ${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  }
  if (diffMs < DAY_MS) {
    const hours = Math.round(diffMs / HOUR_MS);
    return `Checked ${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  }
  return `Checked ${new Date(asOf).toLocaleString()}`;
}

export function formatCapacity(remaining: number | null, limit: number): string {
  if (remaining === null) return "Unknown";
  return `${remaining.toLocaleString()} of ${limit.toLocaleString()} left`;
}
