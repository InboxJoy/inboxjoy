import { describe, expect, it } from "vitest";

import {
  blockingFindings,
  findingTone,
  formatLastChecked,
  mapDeliveryAdvisorResponse,
  navigationHref,
  recordedFindings,
  type DeliveryAdvisorContentState,
  type DeliveryAdvisorFinding,
  type DeliveryAdvisorSnapshot,
} from "./delivery-advisor-state";

function snapshot(overrides: Partial<DeliveryAdvisorSnapshot> = {}): DeliveryAdvisorSnapshot {
  return {
    campaignId: "campaign-1",
    asOf: "2026-10-11T12:00:00.000Z",
    completeness: "complete",
    campaign: { name: "Test campaign", status: "active", displayStatus: "active", statusReason: null },
    findings: [],
    senders: [],
    workspaceCapacity: null,
    nextScheduledAt: null,
    nextScheduledNote: null,
    ...overrides,
  };
}

describe("mapDeliveryAdvisorResponse", () => {
  it("never exposes a card from an initial transport failure, since the workspace might be disabled", () => {
    const hidden: DeliveryAdvisorContentState = { kind: "hidden" };
    expect(mapDeliveryAdvisorResponse({ transportError: true }, hidden)).toEqual({ kind: "hidden" });
  });

  it("hides immediately on an explicit enabled:false response, discarding any prior snapshot", () => {
    const ready: DeliveryAdvisorContentState = { kind: "ready", snapshot: snapshot(), partial: false };
    expect(mapDeliveryAdvisorResponse({ enabled: false }, ready)).toEqual({ kind: "hidden" });
  });

  it("surfaces a ready snapshot as ready, tracking partial separately from hard failure", () => {
    const hidden: DeliveryAdvisorContentState = { kind: "hidden" };
    const result = mapDeliveryAdvisorResponse({ enabled: true, status: "ready", asOf: snapshot().asOf, snapshot: snapshot() }, hidden);
    expect(result).toEqual({ kind: "ready", snapshot: snapshot(), partial: false });

    const partialResult = mapDeliveryAdvisorResponse({ enabled: true, status: "partial", asOf: snapshot().asOf, snapshot: snapshot() }, hidden);
    expect(partialResult).toEqual({ kind: "ready", snapshot: snapshot(), partial: true });
  });

  it("degrades a confirmed-enabled workspace to unavailable on a server-reported failure, keeping the last snapshot as stale", () => {
    const ready: DeliveryAdvisorContentState = { kind: "ready", snapshot: snapshot(), partial: false };
    const result = mapDeliveryAdvisorResponse({ enabled: true, status: "unavailable", asOf: "2026-10-11T12:05:00.000Z", snapshot: null }, ready);
    expect(result).toEqual({ kind: "unavailable", staleSnapshot: snapshot(), lastCheckedAt: snapshot().asOf });
  });

  it("degrades a confirmed-enabled workspace to unavailable on a later transport failure, keeping the last snapshot as stale", () => {
    const ready: DeliveryAdvisorContentState = { kind: "ready", snapshot: snapshot(), partial: false };
    const result = mapDeliveryAdvisorResponse({ transportError: true }, ready);
    expect(result).toEqual({ kind: "unavailable", staleSnapshot: snapshot(), lastCheckedAt: snapshot().asOf });
  });

  it("keeps the original stale snapshot across repeated unavailable responses instead of losing it", () => {
    const unavailable: DeliveryAdvisorContentState = { kind: "unavailable", staleSnapshot: snapshot(), lastCheckedAt: snapshot().asOf };
    const result = mapDeliveryAdvisorResponse({ transportError: true }, unavailable);
    expect(result).toEqual({ kind: "unavailable", staleSnapshot: snapshot(), lastCheckedAt: snapshot().asOf });
  });

  it("recovers from unavailable back to ready once a good response arrives", () => {
    const unavailable: DeliveryAdvisorContentState = { kind: "unavailable", staleSnapshot: snapshot(), lastCheckedAt: snapshot().asOf };
    const fresh = snapshot({ asOf: "2026-10-11T13:00:00.000Z" });
    const result = mapDeliveryAdvisorResponse({ enabled: true, status: "ready", asOf: fresh.asOf, snapshot: fresh }, unavailable);
    expect(result).toEqual({ kind: "ready", snapshot: fresh, partial: false });
  });
});

describe("blockingFindings", () => {
  const base: DeliveryAdvisorFinding = { code: "x", severity: "info", source: "observed", observedAt: "now", message: "m", navigationTarget: null };

  it("excludes informational and recorded/historical findings from the blocker count", () => {
    const findings: DeliveryAdvisorFinding[] = [
      { ...base, code: "info-one", severity: "info" },
      { ...base, code: "recorded-danger", severity: "danger", source: "recorded" },
    ];
    expect(blockingFindings(findings)).toEqual([]);
  });

  it("counts observed warning and danger findings as blockers", () => {
    const findings: DeliveryAdvisorFinding[] = [
      { ...base, code: "warn", severity: "warning" },
      { ...base, code: "danger", severity: "danger" },
    ];
    expect(blockingFindings(findings).map((finding) => finding.code)).toEqual(["warn", "danger"]);
  });
});

describe("recordedFindings", () => {
  const base: DeliveryAdvisorFinding = { code: "x", severity: "info", source: "observed", observedAt: "now", message: "m", navigationTarget: null };

  it("excludes observed findings, including blocking ones", () => {
    const findings: DeliveryAdvisorFinding[] = [
      { ...base, code: "observed-danger", severity: "danger", source: "observed" },
      { ...base, code: "observed-info", severity: "info", source: "observed" },
    ];
    expect(recordedFindings(findings)).toEqual([]);
  });

  it("returns recorded findings newest first, without mutating the input array", () => {
    const findings: DeliveryAdvisorFinding[] = [
      { ...base, code: "older", source: "recorded", observedAt: "2026-01-01T00:00:00.000Z" },
      { ...base, code: "newer", source: "recorded", observedAt: "2026-06-01T00:00:00.000Z" },
    ];
    const original = [...findings];
    expect(recordedFindings(findings).map((finding) => finding.code)).toEqual(["newer", "older"]);
    expect(findings).toEqual(original);
  });
});

describe("findingTone", () => {
  it("maps each severity to its status badge tone", () => {
    expect(findingTone("danger")).toBe("danger");
    expect(findingTone("warning")).toBe("warning");
    expect(findingTone("info")).toBe("info");
  });
});

describe("navigationHref", () => {
  it("resolves allowlisted targets to existing app routes and nothing else", () => {
    expect(navigationHref("mailboxes")).toBe("/app/inboxes");
    expect(navigationHref("billing")).toBe("/app/settings/billing");
    expect(navigationHref("sequence")).toBeNull();
    expect(navigationHref(null)).toBeNull();
  });
});

describe("formatLastChecked", () => {
  const now = new Date("2026-10-11T12:30:00.000Z");

  it("handles never-checked and just-now cases", () => {
    expect(formatLastChecked(null, now)).toBe("Not checked yet");
    expect(formatLastChecked("2026-10-11T12:29:45.000Z", now)).toBe("Checked just now");
  });

  it("formats minutes and hours ago", () => {
    expect(formatLastChecked("2026-10-11T12:25:00.000Z", now)).toBe("Checked 5 minutes ago");
    expect(formatLastChecked("2026-10-11T11:30:00.000Z", now)).toBe("Checked 1 hour ago");
    expect(formatLastChecked("2026-10-11T09:30:00.000Z", now)).toBe("Checked 3 hours ago");
  });
});
