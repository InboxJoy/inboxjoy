import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeScript = { id: string; defer: boolean; src: string; dataset: Record<string, string>; addEventListener: (type: string, listener: () => void) => void };

const origin = "https://inboxjoy.online";
let location: { hostname: string; href: string; origin: string };
let appended: FakeScript[];
let onLoad: (() => void) | undefined;
let beacon: ReturnType<typeof vi.fn>;
let fakeWindow: { location: typeof location; piqo?: ReturnType<typeof vi.fn> };
let fakeDocument: { referrer: string; getElementById: () => FakeScript | null; createElement: () => FakeScript; head: { appendChild: (script: FakeScript) => void } };

beforeEach(() => {
  vi.resetModules();
  location = { hostname: "inboxjoy.online", href: `${origin}/pricing`, origin };
  appended = [];
  onLoad = undefined;
  beacon = vi.fn(() => true);
  fakeWindow = { location };
  fakeDocument = {
    referrer: "",
    getElementById: () => appended[0] ?? null,
    createElement: () => ({ id: "", defer: false, src: "", dataset: {}, addEventListener: (_type, listener) => { onLoad = listener; } }),
    head: { appendChild: (script) => { appended.push(script); } },
  };
  vi.stubGlobal("window", fakeWindow);
  vi.stubGlobal("document", fakeDocument);
  vi.stubGlobal("navigator", { sendBeacon: beacon });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Piqo analytics", () => {
  it("tracks the production site only", async () => {
    const { isPiqoHost } = await import("../lib/piqo");
    expect(isPiqoHost("inboxjoy.online")).toBe(true);
    expect(isPiqoHost("www.inboxjoy.online")).toBe(true);
    expect(isPiqoHost("dev.inboxjoy.online")).toBe(false);
    expect(isPiqoHost("localhost")).toBe(false);
  });

  it("flags URLs that carry credentials", async () => {
    const { isSensitiveUrl } = await import("../lib/piqo");
    for (const path of [
      "/app/invite/private-invitation-token",
      "/app/login?next=%2Fapp%2Finvite%2Fprivate-invitation-token",
      "/app/reset-password?token=reset-token",
      "/app/mcp/authorize?client_id=abc&state=xyz",
      "/app/login?next=%2Fapp%2Fmcp%2Fauthorize%3Fstate%3Dxyz",
      "/app/login?email=lead%40example.com",
    ]) expect(isSensitiveUrl(`${origin}${path}`), path).toBe(true);
    for (const path of [
      "/",
      "/pricing?keyword=cold+email&utm_source=google",
      "/app/signup?plan=monthly&ref=partner",
      "/app/login?verified=1",
      "/app?billing=success",
      "/app/inboxes?connect=success",
      "/app/sequences/123",
    ]) expect(isSensitiveUrl(`${origin}${path}`), path).toBe(false);
  });

  it("injects the tracker once with the site and domain attributes", async () => {
    const { loadPiqo } = await import("../lib/piqo");
    loadPiqo();
    loadPiqo();
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ defer: true, src: "https://piqo.app/piqo.js", dataset: { site: "psznewsy", domain: "inboxjoy.online" } });
  });

  it("stays off outside production", async () => {
    location.hostname = "dev.inboxjoy.online";
    const { loadPiqo } = await import("../lib/piqo");
    loadPiqo();
    expect(appended).toHaveLength(0);
  });

  it("queues events fired before the tracker loads and sends props in Piqo's shape", async () => {
    const { loadPiqo, sendPiqoEvent } = await import("../lib/piqo");
    sendPiqoEvent("checkout_completed");
    loadPiqo();
    fakeWindow.piqo = vi.fn();
    onLoad?.();
    expect(fakeWindow.piqo).toHaveBeenCalledWith("checkout_completed", undefined);

    sendPiqoEvent("checkout_started", { plan: "lifetime" });
    expect(fakeWindow.piqo).toHaveBeenLastCalledWith("checkout_started", { props: { plan: "lifetime" } });
  });

  it("holds Piqo events back on credential-bearing pages and after leaving one by hard navigation", async () => {
    const { loadPiqo } = await import("../lib/piqo");
    loadPiqo();
    const piqoEndpoint = "https://piqo.app/api/event";

    expect(navigator.sendBeacon(piqoEndpoint, "{}")).toBe(true);
    expect(beacon).toHaveBeenCalledTimes(1);

    location.href = `${origin}/app/invite/private-invitation-token`;
    expect(navigator.sendBeacon(piqoEndpoint, "{}")).toBe(true);
    expect(beacon).toHaveBeenCalledTimes(1);

    location.href = `${origin}/app`;
    fakeDocument.referrer = `${origin}/app/reset-password?token=reset-token`;
    expect(navigator.sendBeacon(piqoEndpoint, "{}")).toBe(true);
    expect(beacon).toHaveBeenCalledTimes(1);

    navigator.sendBeacon("https://analytics.example.com/e/", "{}");
    expect(beacon).toHaveBeenCalledTimes(2);
  });
});
