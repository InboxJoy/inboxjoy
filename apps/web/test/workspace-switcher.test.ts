import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { workspaceMemberships, type WorkspaceMembership } from "../lib/workspaces";
import { workspaceMenuPortalTarget } from "../lib/workspace-menu";

const current: WorkspaceMembership = { id: "workspace-a", name: "Alpha", role: "owner", isCurrent: true };
const other: WorkspaceMembership = { id: "workspace-b", name: "Beta", role: "member", isCurrent: false };

function source(path: string) {
  return readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
}

describe("workspace memberships", () => {
  it("keeps the server order and all supported membership roles", () => {
    const workspaces = [current, { ...other, role: "admin" }, { ...other, id: "workspace-c" }];
    expect(workspaceMemberships({ workspaces })).toEqual(workspaces);
  });

  it("allows one workspace to retain the static rail", () => {
    expect(workspaceMemberships({ workspaces: [current] })).toEqual([current]);
  });

  it.each([
    null,
    undefined,
    {},
    { workspaces: "unexpected" },
    { workspaces: [] },
    { workspaces: [null] },
    { workspaces: [current, { ...other, role: "guest" }] },
    { workspaces: [current, { ...other, id: "" }] },
    { workspaces: [current, { ...other, name: " " }] },
    { workspaces: [current, { ...other, isCurrent: "false" }] },
    { workspaces: [current, { ...other, id: current.id }] },
    { workspaces: [current, { ...other, isCurrent: true }] },
    { workspaces: [other] },
  ])("falls back silently for unexpected response %#", (response) => {
    expect(workspaceMemberships(response)).toEqual([]);
  });
});

describe("workspace navigation safeguards", () => {
  it("switches server-side before full navigation and preserves the failure message", () => {
    const menu = source("components/workspace-menu.tsx");
    expect(menu).toMatch(/const result = await apiFetch<[\s\S]*?"\/v1\/workspaces\/switch"[\s\S]*?JSON\.stringify\(\{ workspaceId: workspace.id \}\)[\s\S]*?setWorkspaceId\(result.workspaceId\);[\s\S]*?window\.location\.assign\("\/app"\)/);
    expect(menu).toContain('setError("Try switching workspaces again.")');
    expect(menu).toContain('role="alert"');
    expect(menu).toContain("workspaceMenuPortalTarget(trigger)");
    expect(menu).toContain('position: inDrawer ? "absolute" : "fixed"');
    expect(menu).toContain('if (portalRef.current?.matches(\'.rail-drawer[role="dialog"]\')) event.preventDefault()');
    expect(menu).toContain("createPortal(");
  });

  it("portals the mobile menu into its dialog", () => {
    const drawer = {} as HTMLElement;
    const closest = vi.fn((selector: string) => selector === '.rail-drawer[role="dialog"]' ? drawer : null);
    expect(workspaceMenuPortalTarget({ closest })).toBe(drawer);
    expect(closest).toHaveBeenCalledTimes(1);
  });

  it("keeps desktop and collapsed-rail menus at the shell root", () => {
    const shell = {} as HTMLElement;
    const closest = vi.fn((selector: string) => selector === ".app-shell" ? shell : null);
    expect(workspaceMenuPortalTarget({ closest })).toBe(shell);
  });

  it("keeps detached triggers closed", () => {
    expect(workspaceMenuPortalTarget({ closest: vi.fn(() => null) })).toBeNull();
  });

  it("reloads the shell after invitation acceptance and retains existing error handling", () => {
    const page = source("app/app/(product)/invite/[token]/page.tsx");
    expect(page).toMatch(/const result = await apiFetch<[\s\S]*?"\/v1\/team\/invitations\/accept"[\s\S]*?setWorkspaceId\(result.workspaceId\);[\s\S]*?window\.location\.assign\("\/app"\)/);
    expect(page).toContain('apiErrorMessage(value, "Could not accept this invitation.")');
  });

  it("scopes warm-up dismissal to the active workspace", () => {
    expect(source("components/app-shell.tsx")).toContain('key: `${workspace?.workspace.id}:complete:${inboxes.length}`');
  });

  it("adopts the current workspace once per fresh tab", () => {
    expect(source("components/app-shell.tsx")).toMatch(/apiFetch<unknown>\("\/v1\/workspaces"\)[\s\S]*?if \(!getWorkspaceId\(\) && current\) setWorkspaceId\(current.id\)/);
  });

  it("clears the tab pin in every sign-out flow", () => {
    for (const path of ["components/app-shell.tsx", "app/app/(product)/settings/workspace/page.tsx", "app/app/(product)/settings/danger/page.tsx"]) {
      expect(source(path), path).toMatch(/await authClient.signOut\(\)[\s\S]*?clearWorkspaceId\(\);[\s\S]*?window.location.assign\("\/"\)/);
    }
  });

  it("starts email sign-in and signup with a fresh tab preference", () => {
    expect(source("app/app/login/page.tsx")).toMatch(/clearWorkspaceId\(\);\s*const \{ error: authError \} = await authClient.signIn.email/);
    expect(source("app/app/signup/signup-form.tsx")).toMatch(/clearWorkspaceId\(\);\s*const result = await authClient.signUp.email/);
  });

  it("includes the tab header in every direct API fetch", () => {
    for (const path of ["components/api-health.tsx", "components/affiliate-ref-capture.tsx", "components/guide-callout.tsx", "app/app/(product)/settings/danger/page.tsx"]) {
      expect(source(path), path).toMatch(/fetch\([\s\S]*?headers: workspaceRequestHeaders\(/);
    }
  });
});

describe("invitation email feedback", () => {
  it("confirms an emailed invite and retains the share-link fallback and backup", () => {
    const page = source("app/app/(product)/settings/team/page.tsx");
    expect(page).toContain('data.emailSent === true ? `Invitation emailed to ${data.invitation.email}.` : "Invitation created. Share the link before leaving this page."');
    expect(page).toContain('inviteEmailed ? "Copy link as a backup" : "Share this invitation link"');
    expect(page).toContain("Invitees get an email with a join link that works for 7 days.");
  });

  it("uses a plain retry message for invitation rate limits", () => {
    expect(source("app/app/(product)/settings/team/page.tsx")).toContain('value instanceof ApiError && value.status === 429 ? "Please wait a minute before sending another invitation."');
  });
});
