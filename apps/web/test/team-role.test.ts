import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_BASE_URL } from "../lib/api";
import { canChangeTeamMemberRole, changeTeamMemberRole } from "../lib/team";
import TeamSettingsPage from "../app/app/(product)/settings/team/page";

const hooks = vi.hoisted(() => ({ states: [] as unknown[], stateIndex: 0, effects: [] as (() => void)[] }));

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: (effect: () => void) => { hooks.effects.push(effect); },
  useState: <State>(initial: State) => {
    const index = hooks.stateIndex++;
    if (index >= hooks.states.length) hooks.states.push(initial);
    return [hooks.states[index], (value: State | ((current: State) => State)) => {
      hooks.states[index] = typeof value === "function" ? (value as (current: State) => State)(hooks.states[index] as State) : value;
    }];
  },
}));
vi.mock("@/lib/auth-client", () => ({ authClient: { useSession: () => ({ data: { user: { id: "owner-user" } } }) } }));

type ElementProps = {
  children?: React.ReactNode;
  className?: string;
  value?: string;
  disabled?: boolean;
  role?: string;
  "aria-label"?: string;
  "aria-busy"?: boolean;
  onChange?: (event: { target: { value: string } }) => void;
  onSubmit?: (event: { preventDefault: () => void }) => void;
};

function findElement(children: React.ReactNode, matches: (element: React.ReactElement<ElementProps>) => boolean): React.ReactElement<ElementProps> | undefined {
  for (const child of React.Children.toArray(children)) {
    if (!React.isValidElement<ElementProps>(child)) continue;
    if (matches(child)) return child;
    const nested = findElement(child.props.children, matches);
    if (nested) return nested;
  }
  return undefined;
}

function renderPage(): React.ReactNode {
  hooks.stateIndex = 0;
  hooks.effects = [];
  return TeamSettingsPage();
}

function roleSelect(page = renderPage()): React.ReactElement<ElementProps> | undefined {
  return findElement(page, (element) => element.type === "select" && element.props["aria-label"] === "Role for Teammate");
}

const viewerUserId = "owner-user";
const member = { userId: "teammate-user", role: "member" as const };

afterEach(() => { vi.unstubAllGlobals(); });

describe("team role control visibility", () => {
  it.each(["admin", "member"] as const)("lets the owner edit another %s", (role) => {
    expect(canChangeTeamMemberRole("owner", viewerUserId, { ...member, role })).toBe(true);
  });

  it.each(["admin", "member", undefined] as const)("keeps plain labels for a %s viewer", (role) => {
    expect(canChangeTeamMemberRole(role, viewerUserId, member)).toBe(false);
  });

  it("keeps owner and self rows plain", () => {
    expect(canChangeTeamMemberRole("owner", viewerUserId, { ...member, role: "owner" })).toBe(false);
    expect(canChangeTeamMemberRole("owner", viewerUserId, { ...member, userId: viewerUserId })).toBe(false);
    expect(canChangeTeamMemberRole("owner", undefined, member)).toBe(false);
  });

});

describe("team settings behavior", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const team = {
    role: "owner",
    members: [
      { id: "owner-id", userId: viewerUserId, email: "owner@example.test", displayName: "Owner", role: "owner", joinedAt: null },
      { id: "member-id", ...member, email: "teammate@example.test", displayName: "Teammate", joinedAt: null },
      { id: "other-member-id", userId: "other-user", email: "other@example.test", displayName: "Other", role: "member", joinedAt: null },
    ],
    invitations: [],
  };

  beforeEach(() => {
    hooks.states = [];
    hooks.stateIndex = 0;
    hooks.effects = [];
    fetchMock.mockReset();
    vi.stubGlobal("React", React);
    vi.stubGlobal("window", { location: { origin: "https://app.example.test" }, sessionStorage: { getItem: () => null } });
    vi.stubGlobal("fetch", fetchMock);
  });

  async function loadPage(data = team): Promise<void> {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(data)));
    renderPage();
    hooks.effects[0]!();
    await vi.waitFor(() => { expect(hooks.states[0]).toEqual(data); });
  }

  it("applies the PATCH response before refresh and retains it with a soft notice when refresh fails", async () => {
    await loadPage();
    let finishRefresh: (response: Response) => void = () => { throw new Error("Refresh is pending"); };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: "member-id", role: "admin" })));
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishRefresh = resolve; }));
    roleSelect()!.props.onChange!({ target: { value: "admin" } });
    await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(3); });
    const savingSelect = roleSelect()!;
    expect(savingSelect.props.value).toBe("admin");
    expect(savingSelect.props.disabled).toBe(true);
    expect(savingSelect.props["aria-busy"]).toBe(true);
    expect(findElement(renderPage(), (element) => element.props.children === "Saving role…")?.props.role).toBe("status");
    expect(findElement(renderPage(), (element) => element.props["aria-label"] === "Role for Other")?.props.value).toBe("member");

    finishRefresh(new Response(JSON.stringify({ error: "Team refresh unavailable" }), { status: 503 }));
    await vi.waitFor(() => {
      const page = renderPage();
      expect(findElement(page, (element) => element.props.children === "Role updated. Refresh to see the latest team.")?.props.role).toBe("status");
      expect(roleSelect(page)?.props).toMatchObject({ value: "admin", disabled: false, "aria-busy": false });
    });

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: "member-id", role: "member" })));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(team)));
    roleSelect()!.props.onChange!({ target: { value: "member" } });
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(roleSelect()?.props.value).toBe("member");
      expect(findElement(renderPage(), (element) => element.props.children === "Role updated.")?.props.role).toBe("status");
    });
    expect(fetchMock.mock.calls[1]![0]).toBe(`${API_BASE_URL}/v1/team/members/member-id`);
    expect(fetchMock.mock.calls[2]![0]).toBe(`${API_BASE_URL}/v1/team`);
    expect(JSON.parse(fetchMock.mock.calls[3]![1]!.body as string)).toEqual({ role: "member" });
  });

  it("keeps the saved role and displays an alert when PATCH fails", async () => {
    await loadPage();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Try updating the role again." }), { status: 403 }));
    roleSelect()!.props.onChange!({ target: { value: "admin" } });
    await vi.waitFor(() => {
      const page = renderPage();
      expect(findElement(page, (element) => element.props.children === "Try updating the role again.")?.props.role).toBe("alert");
      expect(roleSelect(page)?.props).toMatchObject({ value: "member", disabled: false });
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["admin", "member"])("renders plain roles for a %s viewer", async (role) => {
    await loadPage({ ...team, role });
    expect(roleSelect()).toBeUndefined();
  });

  it("keeps owner rows plain and skips a change to the current role", async () => {
    await loadPage();
    expect(findElement(renderPage(), (element) => element.props["aria-label"] === "Role for Owner")).toBeUndefined();
    roleSelect()!.props.onChange!({ target: { value: "member" } });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("blocks the generated invitation link and its Copy button from replay capture", async () => {
    await loadPage();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ invitation: { email: "invitee@example.test" }, token: "private-invitation-token" })));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(team)));
    findElement(renderPage(), (element) => element.type === "form")!.props.onSubmit!({ preventDefault: vi.fn() });
    await vi.waitFor(() => {
      const container = findElement(renderPage(), (element) => element.props.className?.split(" ").includes("settings-secret") === true);
      expect(container?.props.className?.split(" ")).toContain("ph-no-capture");
      expect(findElement(container, (element) => element.type === "code")?.props.children).toBe("https://app.example.test/app/invite/private-invitation-token");
      expect(findElement(container, (element) => element.props.children === "Copy link")).toBeDefined();
    });
  });
});

describe("team role requests", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("window", { sessionStorage: { getItem: (key: string) => key === "inboxjoy.workspace-id" ? "workspace-a" : null, removeItem: vi.fn() } });
    vi.stubGlobal("fetch", fetchMock);
  });

  it.each(["admin", "member"] as const)("PATCHes the %s role using apiFetch", async (role) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "member-id", role }), { status: 200 }));
    await expect(changeTeamMemberRole("member-id", role)).resolves.toEqual({ id: "member-id", role });
    expect(fetchMock).toHaveBeenCalledWith(`${API_BASE_URL}/v1/team/members/member-id`, expect.objectContaining({ method: "PATCH", body: JSON.stringify({ role }), credentials: "include" }));
    const headers = fetchMock.mock.calls[0]![1]!.headers as Headers;
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-workspace-id")).toBe("workspace-a");
  });

  it.each([403, 404])("surfaces a %s response for inline error feedback", async (status) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "Try updating the role again." }), { status }));
    await expect(changeTeamMemberRole("member-id", "admin")).rejects.toMatchObject({ status, message: "Try updating the role again." });
  });
});
