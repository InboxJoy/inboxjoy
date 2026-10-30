import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  downloadFilename,
  editionLabel,
  inspectWorkspaceFile,
  invitationLink,
  notInvitedReason,
  summaryLine,
  WORKSPACE_IMPORT_MAX_BYTES,
} from "../lib/workspace-transfer";
import ExportImportSettingsPage from "../app/app/(product)/settings/export/page";

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

const exportFile = {
  format: "inboxjoy-workspace",
  version: 1,
  exportedAt: "2026-10-29T10:00:00.000Z",
  source: { edition: "cloud" },
  workspace: { name: "Acme outbound" },
  leads: [{ email: "a@example.com" }, { email: "b@example.com" }],
  lists: [{ name: "Founders" }],
  suppressions: [],
  sequences: [{ name: "Intro" }],
  mailboxes: [{ email: "sales@acme.test", provider: "gmail" }],
  team: [{ email: "rep@acme.test", role: "member" }],
};

describe("workspace file inspection", () => {
  it("summarizes a workspace export before upload", () => {
    const inspection = inspectWorkspaceFile(JSON.stringify(exportFile), 1_000);
    expect(inspection).toEqual({ ok: true, summary: { workspaceName: "Acme outbound", exportedAt: "2026-10-29T10:00:00.000Z", edition: "cloud", leads: 2, lists: 1, suppressions: 0, campaigns: 1, teammates: 1, mailboxes: 1 } });
    if (inspection.ok) expect(summaryLine(inspection.summary)).toBe("2 leads · 1 list · 0 suppressions · 1 campaign · 1 teammate");
  });

  it("names the wrong file, a newer format and a file that is too big", () => {
    expect(inspectWorkspaceFile("name,email\nAna,a@example.com", 100)).toMatchObject({ ok: false, error: expect.stringContaining("not an InboxJoy workspace export") });
    expect(inspectWorkspaceFile(JSON.stringify({ format: "other" }), 100)).toMatchObject({ ok: false, error: expect.stringContaining("not an InboxJoy workspace export") });
    expect(inspectWorkspaceFile(JSON.stringify({ ...exportFile, version: 2 }), 100)).toMatchObject({ ok: false, error: "This export comes from a newer InboxJoy. Update this install, then import again." });
    expect(inspectWorkspaceFile("{}", WORKSPACE_IMPORT_MAX_BYTES + 1)).toMatchObject({ ok: false, error: expect.stringContaining("larger than 50 MB") });
  });

  it("formats download names, links and labels", () => {
    expect(downloadFilename('attachment; filename="inboxjoy-acme-2026-10-29.json"')).toBe("inboxjoy-acme-2026-10-29.json");
    expect(downloadFilename('attachment; filename="../../evil.sh"')).toBe("inboxjoy-workspace.json");
    expect(downloadFilename(null)).toBe("inboxjoy-workspace.json");
    expect(invitationLink("https://app.example.test/", "ws.token")).toBe("https://app.example.test/app/invite/ws.token");
    expect(editionLabel("selfhost")).toBe("Self-hosted InboxJoy");
    expect(editionLabel(null)).toBeNull();
    expect(notInvitedReason("invitation_limit")).toBe("Over the 20 open invitation limit");
  });
});

type ElementProps = { children?: React.ReactNode; disabled?: boolean; type?: string; className?: string; role?: string };

function findElement(children: React.ReactNode, matches: (element: React.ReactElement<ElementProps>) => boolean): React.ReactElement<ElementProps> | undefined {
  for (const child of React.Children.toArray(children)) {
    if (!React.isValidElement<ElementProps>(child)) continue;
    if (matches(child)) return child;
    const nested = findElement(child.props.children, matches);
    if (nested) return nested;
  }
  return undefined;
}

function textOf(node: React.ReactNode): string {
  return React.Children.toArray(node).map((child) => typeof child === "string" || typeof child === "number" ? String(child) : React.isValidElement<ElementProps>(child) ? textOf(child.props.children) : "").join("");
}

function renderPage(): React.ReactNode {
  hooks.stateIndex = 0;
  hooks.effects = [];
  return ExportImportSettingsPage();
}

const button = (page: React.ReactNode, label: string) => findElement(page, (element) => typeof element.type !== "string" && textOf(element.props.children).startsWith(label));

describe("export and import settings page", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    hooks.states = [];
    hooks.stateIndex = 0;
    hooks.effects = [];
    fetchMock.mockReset();
    vi.stubGlobal("React", React);
    vi.stubGlobal("window", { location: { origin: "https://app.example.test" }, sessionStorage: { getItem: () => null } });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  async function load(role: "owner" | "admin") {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ workspace: { id: "w1", name: "Fresh install" }, role })));
    renderPage();
    hooks.effects[0]!();
    await vi.waitFor(() => { expect(hooks.states[1]).toBe(role); });
  }

  it("lets the owner download, and keeps import off until a file is chosen", async () => {
    await load("owner");
    const page = renderPage();
    expect(button(page, "Download export")?.props.disabled).toBe(false);
    expect(button(page, "Import into Fresh install")?.props.disabled).toBe(true);
    expect(findElement(page, (element) => element.type === "input" && element.props.type === "file")?.props.disabled).toBe(false);
  });

  it("explains that only the owner can move the workspace", async () => {
    await load("admin");
    const page = renderPage();
    expect(button(page, "Download export")?.props.disabled).toBe(true);
    expect(findElement(page, (element) => element.type === "input" && element.props.type === "file")?.props.disabled).toBe(true);
    expect(textOf(findElement(page, (element) => element.props.className === "settings-warning")?.props.children)).toBe("Only the workspace owner can export or import this workspace.");
  });
});
