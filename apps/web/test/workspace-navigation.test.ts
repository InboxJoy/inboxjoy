import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ menuOpen: false, stateIndex: 0, firstState: undefined as unknown }));

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  use: () => ({ token: "invitation-token" }),
  useEffect: () => {},
  useId: () => "workspace-menu",
  useRef: (initial: unknown) => ({ current: initial ?? {} }),
  useState: (initial: unknown) => {
    const value = hooks.stateIndex === 0 && hooks.firstState !== undefined ? hooks.firstState
      : hooks.menuOpen && hooks.stateIndex === 0 ? { left: 16, bottom: 16, maxHeight: 360 } : initial;
    hooks.stateIndex += 1;
    return [value, vi.fn()];
  },
}));
vi.mock("react-dom", () => ({ createPortal: (children: React.ReactNode) => children }));
vi.mock("next/link", () => ({ default: "a" }));
vi.mock("@/lib/auth-client", () => ({ authClient: { signOut: vi.fn() } }));

type ClickableProps = { children?: React.ReactNode; onClick?: () => void; role?: string; "aria-checked"?: boolean };

function findAction(children: React.ReactNode, matches: (props: ClickableProps) => boolean): (() => void) | undefined {
  for (const child of React.Children.toArray(children)) {
    if (!React.isValidElement<ClickableProps>(child)) continue;
    if (child.props.onClick && matches(child.props)) return child.props.onClick;
    const nested = findAction(child.props.children, matches);
    if (nested) return nested;
  }
  return undefined;
}

describe("workspace navigation storage ordering", () => {
  const oldWorkspaceId = "10000000-0000-4000-8000-000000000001";
  const newWorkspaceId = "10000000-0000-4000-8000-000000000002";
  const workspaceKey = "inboxjoy.workspace-id";
  let stored: Map<string, string>;
  let assign: ReturnType<typeof vi.fn>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    hooks.menuOpen = false;
    hooks.stateIndex = 0;
    hooks.firstState = undefined;
    stored = new Map([[workspaceKey, oldWorkspaceId]]);
    assign = vi.fn(() => { expect(stored.get(workspaceKey)).toBe(newWorkspaceId); });
    fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ accepted: true, workspaceId: newWorkspaceId })));
    vi.stubGlobal("React", React);
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => { stored.set(key, value); },
        removeItem: (key: string) => { stored.delete(key); },
      },
      location: { assign },
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it("stores the switched workspace after the endpoint succeeds and before navigation", async () => {
    hooks.menuOpen = true;
    const { WorkspaceMenu } = await import("../components/workspace-menu");
    const menu = WorkspaceMenu({ children: "Workspace", resetKey: "/app", workspaces: [
      { id: oldWorkspaceId, name: "Alpha", role: "owner", isCurrent: true },
      { id: newWorkspaceId, name: "Beta", role: "member", isCurrent: false },
    ] });
    const switchAction = findAction(menu, (props) => props.role === "menuitemradio" && props["aria-checked"] === false);
    expect(switchAction).toBeTypeOf("function");
    switchAction!();
    await vi.waitFor(() => { expect(assign).toHaveBeenCalledWith("/app"); });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ workspaceId: newWorkspaceId });
    expect((fetchMock.mock.calls[0]![1].headers as Headers).get("x-workspace-id")).toBe(oldWorkspaceId);
  });

  it("stores the accepted workspace after the endpoint succeeds and before navigation", async () => {
    hooks.firstState = { status: "pending", workspaceId: newWorkspaceId, workspaceName: "Acme", inviterName: "Sam", role: "member", invitedEmail: "a@example.test", signedInEmail: "a@example.test", expiresAt: new Date().toISOString() };
    const { default: AcceptInvitePage } = await import("../app/app/(product)/invite/[token]/page");
    const page = AcceptInvitePage({ params: Promise.resolve({ token: "invitation-token" }) });
    const acceptAction = findAction(page, (props) => props.children === "Join Acme");
    expect(acceptAction).toBeTypeOf("function");
    acceptAction!();
    await vi.waitFor(() => { expect(assign).toHaveBeenCalledWith("/app"); });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ token: "invitation-token" });
    expect((fetchMock.mock.calls[0]![1].headers as Headers).get("x-workspace-id")).toBe(oldWorkspaceId);
  });
});
