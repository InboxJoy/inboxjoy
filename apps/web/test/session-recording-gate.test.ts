import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  pathname: "/app",
  search: "",
  effects: [] as { effect: () => void | (() => void); dependencies: unknown[] }[],
}));

vi.mock("react", () => ({
  useEffect: (effect: () => void | (() => void), dependencies: unknown[]) => { hooks.effects.push({ effect, dependencies }); },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => hooks.pathname,
  useSearchParams: () => new URLSearchParams(hooks.search),
}));
vi.mock("posthog-js", () => ({ default: { init: vi.fn(), stopSessionRecording: vi.fn(), startSessionRecording: vi.fn() } }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

import posthog from "posthog-js";
import { SessionRecordingGate } from "../components/session-recording-gate";

const origin = "https://app.example.test";
const invitePath = "/app/invite/private-invitation-token";
let location: { href: string; origin: string };
let listeners: Map<string, () => void>;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN", "project-token");
  hooks.pathname = "/app";
  hooks.search = "";
  hooks.effects = [];
  location = { href: `${origin}/app`, origin };
  listeners = new Map();
  vi.stubGlobal("window", {
    location,
    fetch: vi.fn(),
    addEventListener: vi.fn((event: string, listener: () => void) => { listeners.set(event, listener); }),
    removeEventListener: vi.fn((event: string) => { listeners.delete(event); }),
  });
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("session recording navigation wiring", () => {
  it.each([invitePath, `/app/login?next=${encodeURIComponent(invitePath)}`, `/app/signup?next=${encodeURIComponent(encodeURIComponent(invitePath))}`])("disables replay before initialization snapshots for %s", async (path) => {
    location.href = `${origin}${path}`;
    await import("../instrumentation-client");
    expect(posthog.init).toHaveBeenCalledWith("project-token", expect.objectContaining({ disable_session_recording: true }));
    expect(posthog.stopSessionRecording).toHaveBeenCalledOnce();
    expect(posthog.startSessionRecording).not.toHaveBeenCalled();
  });

  it("starts recording on a clean initial load", async () => {
    await import("../instrumentation-client");
    expect(posthog.init).toHaveBeenCalledWith("project-token", expect.objectContaining({ disable_session_recording: false }));
    expect(posthog.startSessionRecording).toHaveBeenCalledOnce();
  });

  it("stops before Next navigation and resumes after the clean route commits", async () => {
    const { onRouterTransitionStart } = await import("../instrumentation-client");
    vi.clearAllMocks();
    const login = `/app/login?next=${encodeURIComponent(invitePath)}`;
    onRouterTransitionStart(login);
    expect(posthog.stopSessionRecording).toHaveBeenCalledOnce();
    location.href = `${origin}${login}`;
    onRouterTransitionStart("/app");
    expect(posthog.stopSessionRecording).toHaveBeenCalledTimes(2);
    expect(posthog.startSessionRecording).not.toHaveBeenCalled();
    location.href = `${origin}/app`;
    SessionRecordingGate();
    hooks.effects[0]!.effect();
    expect(posthog.startSessionRecording).toHaveBeenCalledOnce();
  });

  it("tracks pathname, query, and hash changes and cleans up the hash listener", () => {
    hooks.pathname = "/app/login";
    hooks.search = `next=${encodeURIComponent(invitePath)}`;
    location.href = `${origin}${hooks.pathname}?${hooks.search}`;
    SessionRecordingGate();
    expect(hooks.effects[0]!.dependencies).toEqual([hooks.pathname, hooks.search]);
    const cleanup = hooks.effects[0]!.effect();
    expect(posthog.stopSessionRecording).toHaveBeenCalledOnce();
    location.href = `${origin}/app#${encodeURIComponent(encodeURIComponent(invitePath))}`;
    listeners.get("hashchange")!();
    expect(posthog.stopSessionRecording).toHaveBeenCalledTimes(2);
    location.href = `${origin}/app#settings`;
    listeners.get("hashchange")!();
    expect(posthog.startSessionRecording).toHaveBeenCalledOnce();
    cleanup!();
    expect(listeners.has("hashchange")).toBe(false);
  });

  it("keeps analytics inactive with an empty project token", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN", "");
    const { onRouterTransitionStart } = await import("../instrumentation-client");
    onRouterTransitionStart(invitePath);
    SessionRecordingGate();
    hooks.effects[0]!.effect();
    expect(posthog.init).not.toHaveBeenCalled();
    expect(posthog.startSessionRecording).not.toHaveBeenCalled();
    expect(posthog.stopSessionRecording).not.toHaveBeenCalled();
  });
});
