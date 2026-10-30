import type { CapturedNetworkRequest } from "posthog-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { containsInviteTokenPath, redactSensitiveQueryParameters, sanitizeCapturedEvent, updateSessionRecording } from "../lib/analytics-privacy";

const inviteToken = "private-invitation-token-123";
const invitePath = `/app/invite/${inviteToken}`;
const origin = "https://app.example.test";
const paths = [
  invitePath,
  `/app/login?next=${encodeURIComponent(invitePath)}`,
  `/app/signup?next=${encodeURIComponent(invitePath)}`,
  `/app/login?verified=1&next=${encodeURIComponent(invitePath)}`,
  `/app/login?next=${invitePath}`,
  `/app/login?next=${encodeURIComponent(`${invitePath}?plan=monthly`)}`,
  `/app/signup?next=${encodeURIComponent(encodeURIComponent(invitePath))}`,
  `/app/login?next=${encodeURIComponent(encodeURIComponent(invitePath))}`,
  `/app#${invitePath}`,
  `/app#next=${encodeURIComponent(encodeURIComponent(invitePath))}`,
  `/v1/auth/verify-email?token=verification-secret&callbackURL=${encodeURIComponent(`${origin}/app/login?verified=1&next=${encodeURIComponent(invitePath)}`)}`,
];

beforeEach(() => { vi.stubGlobal("window", { location: { origin } }); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("PostHog URL sanitizer", () => {
  it.each(paths)("removes invitation tokens from captured properties for %s", (path) => {
    const values = { $current_url: `${origin}${path}`, $referrer: `${origin}${path}`, $initial_current_url: path, $initial_referrer: path, $pathname: path };
    const event = { properties: { ...values, $set: { ...values }, $set_once: { ...values }, action: "invite_opened" } };
    expect(sanitizeCapturedEvent(event)).toBe(event);
    expect(JSON.stringify(event)).not.toContain(inviteToken);
    expect(JSON.stringify(event)).toContain("REDACTED");
    expect(event.properties.action).toBe("invite_opened");
  });

  it.each(paths)("removes invitation tokens from replay requests for %s", (path) => {
    const request = { name: `${origin}${path}` } as CapturedNetworkRequest;
    expect(redactSensitiveQueryParameters(request)).toBe(request);
    expect(request.name).not.toContain(inviteToken);
  });

  it("preserves safe navigation properties and sensitive query redaction", () => {
    const event = { properties: { $current_url: `${origin}/app/login?next=%2Fapp%2Fsettings&email=private%40example.test&token=secret`, $pathname: "/app/login" } };
    sanitizeCapturedEvent(event);
    const url = new URL(event.properties.$current_url);
    expect(url.searchParams.get("next")).toBe("/app/settings");
    expect(url.searchParams.get("email")).toBe("[REDACTED]");
    expect(url.searchParams.get("token")).toBe("[REDACTED]");
    expect(event.properties.$pathname).toBe("/app/login");
  });

  it("redacts encoded pathname values and every invitation in a redirect chain", () => {
    const secondToken = "another-private-invitation";
    const event = { properties: {
      $pathname: encodeURIComponent(invitePath),
      $current_url: `${origin}/app/login?next=${encodeURIComponent(`${invitePath}?next=/app/invite/${secondToken}`)}&plan=yearly`,
    } };
    sanitizeCapturedEvent(event);
    expect(JSON.stringify(event)).not.toContain(inviteToken);
    expect(JSON.stringify(event)).not.toContain(secondToken);
    expect(new URL(event.properties.$current_url).searchParams.get("plan")).toBe("yearly");
  });

  it("handles empty events and non-string URL properties", () => {
    expect(sanitizeCapturedEvent(null)).toBeNull();
    expect(sanitizeCapturedEvent({})).toEqual({});
    const event = { properties: { $current_url: null, $referrer: 1, $set: [], $set_once: null } };
    expect(sanitizeCapturedEvent(event)).toEqual(event);
  });
});

describe("invitation session recording gate", () => {
  it.each(paths)("stops recording for %s", (path) => {
    const recording = { stopSessionRecording: vi.fn(), startSessionRecording: vi.fn() };
    expect(containsInviteTokenPath(`${origin}${path}`)).toBe(true);
    updateSessionRecording(`${origin}${path}`, recording);
    expect(recording.stopSessionRecording).toHaveBeenCalledOnce();
    expect(recording.startSessionRecording).not.toHaveBeenCalled();
  });

  it.each(["/", "/app", "/app/invite/", "/app/login?next=%2Fapp%2Fsettings", "/app/signup?plan=yearly", "/app#settings"])("starts recording for %s", (path) => {
    const recording = { stopSessionRecording: vi.fn(), startSessionRecording: vi.fn() };
    expect(containsInviteTokenPath(`${origin}${path}`)).toBe(false);
    updateSessionRecording(`${origin}${path}`, recording);
    expect(recording.startSessionRecording).toHaveBeenCalledOnce();
    expect(recording.stopSessionRecording).not.toHaveBeenCalled();
  });

  it("resumes recording after invitation navigation reaches a clean URL", () => {
    const recording = { stopSessionRecording: vi.fn(), startSessionRecording: vi.fn() };
    updateSessionRecording(`${origin}/app/login?next=${encodeURIComponent(invitePath)}`, recording);
    updateSessionRecording(`${origin}${invitePath}`, recording);
    updateSessionRecording(`${origin}/app`, recording);
    expect(recording.stopSessionRecording).toHaveBeenCalledTimes(2);
    expect(recording.startSessionRecording).toHaveBeenCalledOnce();
  });
});
