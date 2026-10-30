import { API_BASE_URL } from "@/lib/api";

// GET /v1/public/status: who may sign up on this server, read before anyone is
// signed in. The server enforces the same rule; this only picks the screen.
export type InstanceStatus = {
  edition: "cloud" | "selfhost";
  signupMode: "open" | "invite";
  signupOpen: boolean;
  needsSetup: boolean;
  // First-run setup needs the installer's link (?token=); never the token itself.
  setupTokenRequired: boolean;
};

export const SIGNUP_CLOSED_CODE = "signup_closed";
export const SIGNUP_CLOSED_MESSAGE = "Sign-ups are closed on this server. Ask your admin for an invite.";
export const INVITE_EMAIL_MESSAGE = "This server is invite-only. Sign up with the email address your invitation was sent to.";
export const SETUP_TOKEN_REQUIRED_CODE = "setup_token_required";
export const SETUP_LINK_MESSAGE = "Open the setup link printed by the installer.";

export function parseInstanceStatus(value: unknown): InstanceStatus | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  if (body.edition !== "cloud" && body.edition !== "selfhost") return null;
  if (body.signupMode !== "open" && body.signupMode !== "invite") return null;
  if (typeof body.signupOpen !== "boolean" || typeof body.needsSetup !== "boolean") return null;
  // An API from before the setup token never asks for one.
  const setupTokenRequired = body.setupTokenRequired === true;
  return { edition: body.edition, signupMode: body.signupMode, signupOpen: body.signupOpen, needsSetup: body.needsSetup, setupTokenRequired };
}

// null when the status cannot be read: screens then fall back to the normal
// form and let the server decide.
export async function fetchInstanceStatus(): Promise<InstanceStatus | null> {
  try {
    const response = await fetch(`${API_BASE_URL}/v1/public/status`, { cache: "no-store", credentials: "include" });
    if (!response.ok) return null;
    return parseInstanceStatus(await response.json());
  } catch {
    return null;
  }
}

// Someone following an invitation link arrives with ?next=/app/invite/<token>.
export function isInvitationSearch(search: string): boolean {
  const next = new URLSearchParams(search).get("next");
  return Boolean(next?.startsWith("/app/invite/") && !next.startsWith("/app/invite//"));
}

// The invitation token in ?next=/app/invite/<token>. Invite-only sign-up needs
// it: the server admits an invitee by the token, never by the address alone.
export function invitationTokenFromSearch(search: string): string | null {
  if (!isInvitationSearch(search)) return null;
  const segment = new URLSearchParams(search).get("next")!.slice("/app/invite/".length).split(/[/?#]/, 1)[0] ?? "";
  let token = segment;
  try { token = decodeURIComponent(segment); } catch { /* keep the raw segment */ }
  return token.length > 0 && token.length <= 200 ? token : null;
}

// The setup link the installer prints: /app/setup?token=<SETUP_TOKEN>.
export function setupTokenFromSearch(search: string): string | null {
  const token = new URLSearchParams(search).get("token")?.trim() ?? "";
  return token.length > 0 ? token : null;
}

export type SignupScreen = "form" | "closed" | "go-setup" | "go-login" | "setup-link";

export function signupScreen(variant: "signup" | "setup", status: InstanceStatus | null, search: string): SignupScreen {
  if (!status) return "form";
  if (variant === "setup") {
    if (!status.needsSetup) return "go-login";
    return status.setupTokenRequired && !setupTokenFromSearch(search) ? "setup-link" : "form";
  }
  if (status.needsSetup) return "go-setup";
  return status.signupOpen || isInvitationSearch(search) ? "form" : "closed";
}

// The Terms and Privacy pages exist only on the managed service.
export function requiresTermsConsent(status: InstanceStatus | null): boolean {
  return status?.edition !== "selfhost";
}

// The sign-in form never waits for the status: it shows once the session check
// finishes. A status that arrives later only sends a fresh server to setup (and
// showSignupLink hides the link when sign-up is closed); null means not known
// yet, or not readable.
export function loginScreen(sessionPending: boolean, signedIn: boolean, status: InstanceStatus | null): "checking" | "go-setup" | "form" {
  if (sessionPending || signedIn) return "checking";
  return status?.needsSetup ? "go-setup" : "form";
}

export function showSignupLink(status: InstanceStatus | null, search: string): boolean {
  return !status || status.signupOpen || isInvitationSearch(search);
}

export function isSignupClosedError(error: { code?: string | null } | null | undefined): boolean {
  return error?.code === SIGNUP_CLOSED_CODE;
}

export function isSetupTokenError(error: { code?: string | null } | null | undefined): boolean {
  return error?.code === SETUP_TOKEN_REQUIRED_CODE;
}
