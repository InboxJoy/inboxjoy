import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { postAuthDestination } from "../lib/checkout";
import { verificationCallbackUrl } from "../lib/email-verification";

vi.mock("@/lib/auth-client", () => ({ authClient: {} }));

const invitePath = "/app/invite/token-123";
const search = `?next=${encodeURIComponent(invitePath)}`;

function source(path: string) {
  return readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("logged-out invitation paths", () => {
  it("preserves the invitation through login", () => {
    expect(source("components/auth-gate.tsx")).toContain("pathname + window.location.search");
    expect(source("app/app/login/page.tsx")).toContain("startPostLogin(true)");
    expect(postAuthDestination(search, { useNext: true })).toBe(invitePath);
  });

  it("carries the login query into create account and the signup destination", () => {
    expect(source("app/app/login/page.tsx")).toContain('const signupHref = `/app/signup${nextQuery}`');
    expect(source("app/app/login/page.tsx")).toContain("setNextQuery(window.location.search)");
    expect(source("app/app/signup/signup-form.tsx")).toContain("postAuthDestination(window.location.search, { useNext: true })");
    expect(postAuthDestination(search, { useNext: true })).toBe(invitePath);
  });

  it("asks an unverified invitee to verify first and sends the link back to the invite", () => {
    const page = source("app/app/(product)/invite/[token]/page.tsx");
    expect(page).toContain('"verify_email"');
    expect(page).toContain('preview.status === "verify_email"');
    expect(page).toContain("resendVerificationEmail(preview.signedInEmail, `?next=${encodeURIComponent(`/app/invite/${token}`)}`)");
    // The resend helper forwards that query to the callback URL, so the user
    // returns to the invite after verifying rather than to the bare dashboard.
    expect(source("lib/email-verification.ts")).toContain("resendVerificationEmail(email: string, search = window.location.search)");
    vi.stubGlobal("window", { location: { search: "", origin: "https://app.example.test" } });
    const callback = new URL(verificationCallbackUrl(search));
    expect(callback.pathname).toBe("/app/login");
    expect(callback.searchParams.get("next")).toBe(invitePath);
  });

  it("carries the invitation through the signup verification callback and login", () => {
    vi.stubGlobal("window", { location: { search, origin: "https://app.example.test" } });
    expect(source("app/app/signup/signup-form.tsx")).toContain("callbackURL: verificationCallbackUrl()");
    const callback = new URL(verificationCallbackUrl());
    expect(callback.pathname).toBe("/app/login");
    expect(callback.searchParams.get("verified")).toBe("1");
    expect(callback.searchParams.get("next")).toBe(invitePath);
    expect(postAuthDestination(callback.search, { useNext: true })).toBe(invitePath);
  });
});
