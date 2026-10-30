import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchInstanceStatus,
  invitationTokenFromSearch,
  isInvitationSearch,
  isSetupTokenError,
  isSignupClosedError,
  loginScreen,
  parseInstanceStatus,
  requiresTermsConsent,
  SETUP_LINK_MESSAGE,
  setupTokenFromSearch,
  showSignupLink,
  SIGNUP_CLOSED_MESSAGE,
  signupScreen,
  type InstanceStatus,
} from "../lib/instance-status";

function source(path: string) {
  return readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
}

const selfhost = (overrides: Partial<InstanceStatus> = {}): InstanceStatus => ({ edition: "selfhost", signupMode: "invite", signupOpen: false, needsSetup: false, setupTokenRequired: false, ...overrides });
const cloud: InstanceStatus = { edition: "cloud", signupMode: "open", signupOpen: true, needsSetup: false, setupTokenRequired: false };
const inviteToken = "0b7c6a8e-3f1d-4c2b-9a5e-7d6f8e9a0b1c.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde";
const invite = `?next=${encodeURIComponent(`/app/invite/${inviteToken}`)}`;

afterEach(() => { vi.unstubAllGlobals(); });

describe("instance status", () => {
  it("accepts only the documented shape", () => {
    expect(parseInstanceStatus({ edition: "cloud", signupMode: "open", signupOpen: true, needsSetup: false, setupTokenRequired: false, extra: 1 }))
      .toEqual(cloud);
    expect(parseInstanceStatus({ edition: "selfhost", signupMode: "invite", signupOpen: true, needsSetup: true, setupTokenRequired: true }))
      .toEqual(selfhost({ signupOpen: true, needsSetup: true, setupTokenRequired: true }));
    expect(parseInstanceStatus({ edition: "other", signupMode: "open", signupOpen: true, needsSetup: false })).toBeNull();
    expect(parseInstanceStatus({ edition: "cloud", signupMode: "open", signupOpen: "yes", needsSetup: false })).toBeNull();
    expect(parseInstanceStatus(null)).toBeNull();
  });

  it("reads an API without the setup-token field as not needing one", () => {
    expect(parseInstanceStatus({ edition: "selfhost", signupMode: "invite", signupOpen: true, needsSetup: true }))
      .toEqual(selfhost({ signupOpen: true, needsSetup: true }));
    expect(parseInstanceStatus({ edition: "selfhost", signupMode: "invite", signupOpen: true, needsSetup: true, setupTokenRequired: "yes" })?.setupTokenRequired).toBe(false);
  });

  it("reads the public status endpoint and treats any failure as unknown", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(selfhost({ needsSetup: true, signupOpen: true })), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchInstanceStatus()).toEqual(selfhost({ needsSetup: true, signupOpen: true }));
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/public/status", expect.objectContaining({ cache: "no-store" }));

    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    expect(await fetchInstanceStatus()).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    expect(await fetchInstanceStatus()).toBeNull();
  });
});

describe("sign-up screen choice", () => {
  it("closes sign-up in invite mode unless the visitor followed an invitation", () => {
    expect(signupScreen("signup", selfhost(), "")).toBe("closed");
    expect(signupScreen("signup", selfhost(), "?plan=lifetime")).toBe("closed");
    expect(signupScreen("signup", selfhost(), invite)).toBe("form");
    expect(SIGNUP_CLOSED_MESSAGE).toBe("Sign-ups are closed on this server. Ask your admin for an invite.");
  });

  it("sends a fresh server to first-run setup and a finished setup to sign-in", () => {
    expect(signupScreen("signup", selfhost({ needsSetup: true, signupOpen: true }), invite)).toBe("go-setup");
    expect(signupScreen("setup", selfhost({ needsSetup: true, signupOpen: true }), "")).toBe("form");
    expect(signupScreen("setup", selfhost(), "")).toBe("go-login");
  });

  it("keeps open sign-up and an unreachable status on the normal form", () => {
    expect(signupScreen("signup", cloud, "")).toBe("form");
    expect(signupScreen("signup", null, "")).toBe("form");
    expect(signupScreen("setup", null, "")).toBe("form");
  });

  it("asks for the installer's setup link when the server requires one", () => {
    const fresh = selfhost({ needsSetup: true, signupOpen: true, setupTokenRequired: true });
    expect(signupScreen("setup", fresh, "")).toBe("setup-link");
    expect(signupScreen("setup", fresh, "?token=")).toBe("setup-link");
    expect(signupScreen("setup", fresh, "?token=abcdefghijklmnopqrstuvwxyz")).toBe("form");
    // Without the requirement the plain setup page works; after setup it is sign-in.
    expect(signupScreen("setup", selfhost({ needsSetup: true, signupOpen: true }), "")).toBe("form");
    expect(signupScreen("setup", selfhost({ setupTokenRequired: false }), "?token=abc")).toBe("go-login");
    expect(SETUP_LINK_MESSAGE).toBe("Open the setup link printed by the installer.");
  });

  it("reads the setup token from ?token=", () => {
    expect(setupTokenFromSearch("?token=abcdefghijklmnopqrstuvwxyz")).toBe("abcdefghijklmnopqrstuvwxyz");
    expect(setupTokenFromSearch(`?token=${encodeURIComponent("a+b/c=")}&next=%2Fapp`)).toBe("a+b/c=");
    expect(setupTokenFromSearch("?token=%20%20")).toBeNull();
    expect(setupTokenFromSearch("")).toBeNull();
  });

  it("only treats a real invitation path as an invitation", () => {
    expect(isInvitationSearch(invite)).toBe(true);
    expect(isInvitationSearch(`?next=${encodeURIComponent("/app/leads")}`)).toBe(false);
    expect(isInvitationSearch(`?next=${encodeURIComponent("/app/invite//evil.example")}`)).toBe(false);
    expect(isInvitationSearch("")).toBe(false);
  });

  it("carries the invitation token from ?next= into sign-up", () => {
    expect(invitationTokenFromSearch(invite)).toBe(inviteToken);
    expect(invitationTokenFromSearch(`${invite}&plan=lifetime`)).toBe(inviteToken);
    expect(invitationTokenFromSearch(`?next=${encodeURIComponent(`/app/invite/${inviteToken}/extra?x=1`)}`)).toBe(inviteToken);
    expect(invitationTokenFromSearch(`?next=${encodeURIComponent("/app/leads")}`)).toBeNull();
    expect(invitationTokenFromSearch(`?next=${encodeURIComponent("/app/invite/")}`)).toBeNull();
    expect(invitationTokenFromSearch("")).toBeNull();
  });

  it("asks for Terms consent only on the managed service", () => {
    expect(requiresTermsConsent(cloud)).toBe(true);
    expect(requiresTermsConsent(null)).toBe(true);
    expect(requiresTermsConsent(selfhost())).toBe(false);
  });

  it("hides the login page's create-account link when sign-up is closed", () => {
    expect(showSignupLink(selfhost(), "")).toBe(false);
    expect(showSignupLink(selfhost(), invite)).toBe(true);
    expect(showSignupLink(selfhost({ signupMode: "open", signupOpen: true }), "")).toBe(true);
    expect(showSignupLink(null, "")).toBe(true);
  });

  it("recognizes the server's closed sign-up error", () => {
    expect(isSignupClosedError({ code: "signup_closed" })).toBe(true);
    expect(isSignupClosedError({ code: "USER_ALREADY_EXISTS" })).toBe(false);
    expect(isSignupClosedError(null)).toBe(false);
  });

  it("recognizes the server's setup-token refusal", () => {
    expect(isSetupTokenError({ code: "setup_token_required" })).toBe(true);
    expect(isSetupTokenError({ code: "signup_closed" })).toBe(false);
    expect(isSetupTokenError(undefined)).toBe(false);
  });
});

describe("auth screens", () => {
  it("serves setup and sign-up from the same form", () => {
    expect(source("app/app/setup/page.tsx")).toContain('<SignupForm variant="setup" />');
    expect(source("app/app/signup/page.tsx")).toContain('<SignupForm variant="signup" />');
    const form = source("app/app/signup/signup-form.tsx");
    expect(form).toContain("Create the owner account.");
    expect(form).toContain('router.replace(`/app/setup${window.location.search}`)');
    // The consent checkbox and its legal links render only when Terms apply.
    expect(form).toMatch(/\{termsRequired \? \(\s*<label className="auth-checkbox">/);
    // Invite-only sign-up sends the invitation's token; setup sends the installer's.
    expect(form).toContain("invitationTokenFromSearch(window.location.search)");
    expect(form).toContain('variant === "setup" ? setupTokenFromSearch(window.location.search) : null');
    expect(form).toContain("...(inviteToken ? { inviteToken } : {})");
    expect(form).toContain("...(setupToken ? { setupToken } : {})");
    expect(form).toContain("<p>{SETUP_LINK_MESSAGE}</p>");
  });

  it("sends login to setup on a fresh server", () => {
    const login = source("app/app/login/page.tsx");
    expect(login).toContain("router.replace(`/app/setup${window.location.search}`)");
    expect(login).toContain("showSignupLink(status, nextQuery)");
  });

  it("shows the sign-in form without waiting for the instance status", () => {
    // Status not known yet: the form (with its create-account link) shows as
    // soon as the session check finishes.
    expect(loginScreen(true, false, null)).toBe("checking");
    expect(loginScreen(false, true, null)).toBe("checking");
    expect(loginScreen(false, false, null)).toBe("form");
    expect(showSignupLink(null, "")).toBe(true);
    // When it arrives it only redirects a fresh server or hides the link.
    expect(loginScreen(false, false, selfhost({ needsSetup: true, signupOpen: true }))).toBe("go-setup");
    expect(loginScreen(false, false, selfhost())).toBe("form");
    expect(loginScreen(false, false, cloud)).toBe("form");

    const login = source("app/app/login/page.tsx");
    expect(login).toContain("useState<InstanceStatus | null>(null)");
    expect(login).toContain("loginScreen(isPending, Boolean(session), status)");
    expect(login).toContain('if (screen !== "form")');
  });
});
