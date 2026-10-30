import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearWorkspaceId, getWorkspaceId, setWorkspaceId } from "../lib/workspaces";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const workspaceKey = "inboxjoy.workspace-id";
const reloadKey = "inboxjoy.workspace-reload";
const changedResponse = () => new Response(JSON.stringify({ error: "Your workspace changed. Reload to continue.", code: "workspace_changed" }), { status: 409 });

describe("tab-pinned API requests", () => {
  let stored: Map<string, string>;
  let storage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn>; removeItem: ReturnType<typeof vi.fn> };
  let reload: ReturnType<typeof vi.fn>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    stored = new Map();
    storage = {
      getItem: vi.fn((key: string) => stored.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => { stored.set(key, value); }),
      removeItem: vi.fn((key: string) => { stored.delete(key); }),
    };
    reload = vi.fn();
    fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("window", { sessionStorage: storage, location: { reload } });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it.each([
    { "content-type": "application/json", accept: "application/json" },
    new Headers({ "content-type": "application/json", accept: "application/json" }),
    [["content-type", "application/json"], ["accept", "application/json"]] as [string, string][],
  ])("sends the stored workspace alongside existing headers %#", async (headers) => {
    stored.set(workspaceKey, workspaceId);
    const { apiFetch, API_BASE_URL } = await import("../lib/api");
    await expect(apiFetch("/v1/workspace", { method: "PATCH", headers, body: "{}", credentials: "omit" })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(`${API_BASE_URL}/v1/workspace`, expect.objectContaining({ method: "PATCH", body: "{}", credentials: "include" }));
    const requestHeaders = fetchMock.mock.calls[0]![1].headers as Headers;
    expect(requestHeaders.get("x-workspace-id")).toBe(workspaceId);
    expect(requestHeaders.get("content-type")).toBe("application/json");
    expect(requestHeaders.get("accept")).toBe("application/json");
  });

  it("uses the server default when tab storage is empty", async () => {
    const { apiFetch } = await import("../lib/api");
    await apiFetch("/v1/workspace");
    expect((fetchMock.mock.calls[0]![1].headers as Headers).has("x-workspace-id")).toBe(false);
  });

  it("keeps caller headers while using the server default when storage access throws", async () => {
    Object.defineProperty(window, "sessionStorage", { get: () => { throw new Error("Storage unavailable"); } });
    const { apiFetch } = await import("../lib/api");
    await apiFetch("/v1/workspace", { headers: { accept: "application/json" } });
    const headers = fetchMock.mock.calls[0]![1].headers as Headers;
    expect(headers.has("x-workspace-id")).toBe(false);
    expect(headers.get("accept")).toBe("application/json");
    expect(() => setWorkspaceId(workspaceId)).not.toThrow();
    expect(() => clearWorkspaceId()).not.toThrow();
    expect(getWorkspaceId()).toBeNull();
  });

  it("supports server rendering with browser globals unavailable", async () => {
    vi.stubGlobal("window", undefined);
    const { apiFetch } = await import("../lib/api");
    await apiFetch("/v1/workspace");
    expect((fetchMock.mock.calls[0]![1].headers as Headers).has("x-workspace-id")).toBe(false);
  });

  it("clears a stale pin and reloads once across concurrent failures", async () => {
    stored.set(workspaceKey, workspaceId);
    fetchMock.mockImplementation(async () => changedResponse());
    const { apiFetch } = await import("../lib/api");
    const responses = await Promise.allSettled([apiFetch("/v1/workspace"), apiFetch("/v1/leads")]);
    expect(responses.map((response) => response.status)).toEqual(["rejected", "rejected"]);
    expect(stored.has(workspaceKey)).toBe(false);
    expect(stored.get(reloadKey)).toBe("1");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("honors the reload guard across page loads and clears it after a successful response", async () => {
    stored.set(workspaceKey, workspaceId);
    stored.set(reloadKey, "1");
    fetchMock.mockImplementation(async () => changedResponse());
    const { apiFetch } = await import("../lib/api");
    await expect(apiFetch("/v1/workspace")).rejects.toMatchObject({ status: 409, code: "workspace_changed" });
    expect(stored.has(workspaceKey)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(apiFetch("/v1/workspace")).resolves.toBeUndefined();
    expect(stored.has(reloadKey)).toBe(false);
    stored.set(workspaceKey, workspaceId);
    await expect(apiFetch("/v1/workspace")).rejects.toMatchObject({ code: "workspace_changed" });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("clears the reload guard on a successful JSON response", async () => {
    stored.set(reloadKey, "1");
    const { apiFetch } = await import("../lib/api");
    await apiFetch("/v1/workspaces");
    expect(stored.has(reloadKey)).toBe(false);
  });

  it("reloads once within the page when storage operations throw", async () => {
    for (const operation of Object.values(storage)) operation.mockImplementation(() => { throw new Error("Storage unavailable"); });
    fetchMock.mockImplementation(async () => changedResponse());
    const { apiFetch } = await import("../lib/api");
    await expect(apiFetch("/v1/workspace")).rejects.toMatchObject({ code: "workspace_changed" });
    await expect(apiFetch("/v1/leads")).rejects.toMatchObject({ code: "workspace_changed" });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("keeps the pin for ordinary conflicts", async () => {
    stored.set(workspaceKey, workspaceId);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Invitation limit reached.", code: "CONFLICT" }), { status: 409 }));
    const { apiFetch } = await import("../lib/api");
    await expect(apiFetch("/v1/team/invitations")).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    expect(stored.get(workspaceKey)).toBe(workspaceId);
    expect(reload).not.toHaveBeenCalled();
  });

  it("provides workspace headers for direct API fetches", async () => {
    stored.set(workspaceKey, workspaceId);
    const { workspaceRequestHeaders } = await import("../lib/api");
    expect(workspaceRequestHeaders({ "content-type": "application/json" }).get("x-workspace-id")).toBe(workspaceId);
    clearWorkspaceId();
    expect(workspaceRequestHeaders().has("x-workspace-id")).toBe(false);
  });
});
