"use client";

import Link from "next/link";
import Script from "next/script";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Logo } from "@/components/logo";
import { authClient } from "@/lib/auth-client";
import { postAuthDestination, rememberPlanHint } from "@/lib/checkout";
import { verificationCallbackUrl } from "@/lib/email-verification";
import { track } from "@/lib/analytics";
import {
  fetchInstanceStatus,
  INVITE_EMAIL_MESSAGE,
  invitationTokenFromSearch,
  isInvitationSearch,
  isSetupTokenError,
  isSignupClosedError,
  requiresTermsConsent,
  SETUP_LINK_MESSAGE,
  setupTokenFromSearch,
  SIGNUP_CLOSED_MESSAGE,
  signupScreen,
  type InstanceStatus,
} from "@/lib/instance-status";
import { clearWorkspaceId } from "@/lib/workspaces";
import { Button } from "@inboxjoy/ui";

type AuthClientError = { code?: string; message?: string | null; status?: number };
type TurnstileWidgetId = string;

type TurnstileApi = {
  render: (container: HTMLElement, options: {
    sitekey: string;
    action: "signup";
    callback: (token: string) => void;
    "expired-callback": () => void;
    "error-callback": () => void;
  }) => TurnstileWidgetId;
  remove: (widgetId: TurnstileWidgetId) => void;
  reset: (widgetId: TurnstileWidgetId) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const turnstileSitekey = process.env.NEXT_PUBLIC_TURNSTILE_SITEKEY?.trim() ?? "";

function isExistingAccountError(error: AuthClientError) {
  const code = error.code?.toUpperCase() ?? "";
  const message = error.message?.toLowerCase() ?? "";
  return code.includes("USER_ALREADY_EXISTS") || code.includes("EMAIL_ALREADY") || message.includes("already registered") || message.includes("already exists");
}

const copy = {
  signup: {
    kicker: "Start sending smarter",
    title: "Create your workspace account.",
    lead: "Create your account for the InboxJoy workspace.",
    submit: "Create account",
    submitting: "Creating your account…",
  },
  setup: {
    kicker: "First-run setup",
    title: "Create the owner account.",
    lead: "This account owns the first workspace on this server. Invite your team once you are in.",
    submit: "Create owner account",
    submitting: "Creating the owner account…",
  },
} as const;

// Account creation for /app/signup and the first-run /app/setup screen. Both
// post to the same sign-up endpoint; the server decides who is admitted.
export function SignupForm({ variant }: { variant: "signup" | "setup" }) {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const postSignupStarted = useRef(false);
  const turnstileContainer = useRef<HTMLDivElement>(null);
  const turnstileWidgetId = useRef<TurnstileWidgetId | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [error, setError] = useState("");
  const [existingAccount, setExistingAccount] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [nextQuery, setNextQuery] = useState("");
  const [redirecting, setRedirecting] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState("");
  // undefined while loading; null when the server could not say.
  const [status, setStatus] = useState<InstanceStatus | null | undefined>(undefined);
  const [closedByServer, setClosedByServer] = useState(false);
  const [setupLinkRejected, setSetupLinkRejected] = useState(false);

  const renderTurnstile = useCallback(() => {
    if (!turnstileSitekey || !turnstileContainer.current || !window.turnstile || turnstileWidgetId.current) return;

    turnstileWidgetId.current = window.turnstile.render(turnstileContainer.current, {
      sitekey: turnstileSitekey,
      action: "signup",
      callback: setTurnstileToken,
      "expired-callback": () => setTurnstileToken(""),
      "error-callback": () => setTurnstileToken(""),
    });
  }, []);

  const resetTurnstile = useCallback(() => {
    if (!turnstileSitekey) return;
    setTurnstileToken("");
    if (window.turnstile && turnstileWidgetId.current) {
      window.turnstile.reset(turnstileWidgetId.current);
    }
  }, []);

  useEffect(() => { setNextQuery(window.location.search); }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchInstanceStatus().then((result) => { if (!cancelled) setStatus(result); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => () => {
    if (window.turnstile && turnstileWidgetId.current) {
      window.turnstile.remove(turnstileWidgetId.current);
      turnstileWidgetId.current = null;
    }
  }, []);

  // Every new account lands in the product. A ?plan= hint is carried to /app so
  // the plan picker pre-selects it; checkout starts only from that picker.
  const completeSignup = useCallback(() => {
    setRedirecting(true);
    rememberPlanHint(window.location.search);
    router.replace(postAuthDestination(window.location.search, { useNext: true }));
  }, [router]);

  const startPostSignup = useCallback(() => {
    if (postSignupStarted.current) return;
    postSignupStarted.current = true;
    completeSignup();
  }, [completeSignup]);

  useEffect(() => {
    if (!isPending && session) startPostSignup();
  }, [isPending, session, startPostSignup]);

  const screen = status === undefined ? "loading"
    : closedByServer ? "closed"
    : setupLinkRejected ? "setup-link"
    : signupScreen(variant, status, nextQuery);

  // A fresh server sends sign-ups to setup; a finished setup sends people to sign in.
  useEffect(() => {
    if (isPending || session) return;
    if (screen === "go-setup") router.replace(`/app/setup${window.location.search}`);
    if (screen === "go-login") router.replace(`/app/login${window.location.search}`);
  }, [isPending, router, screen, session]);

  const termsRequired = requiresTermsConsent(status ?? null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (termsRequired && !acceptedTerms) {
      setError("Please accept the Terms and Privacy Policy to create an account.");
      resetTurnstile();
      return;
    }

    setError("");
    setExistingAccount(false);
    setIsSubmitting(true);
    postSignupStarted.current = true;
    let authError: AuthClientError | null = null;
    // The server admits an invitee by their invitation's token and the
    // first-run owner by the installer's setup link, never by the address alone.
    const inviteToken = invitationTokenFromSearch(window.location.search);
    const setupToken = variant === "setup" ? setupTokenFromSearch(window.location.search) : null;
    try {
      clearWorkspaceId();
      const result = await authClient.signUp.email({
        name,
        email,
        password,
        ...({
          ...(termsRequired ? { acceptedTerms } : {}),
          turnstileToken,
          ...(inviteToken ? { inviteToken } : {}),
          ...(setupToken ? { setupToken } : {}),
        } as Record<string, unknown>),
        callbackURL: verificationCallbackUrl(),
      });
      authError = result.error;
    } catch {
      authError = { message: "We could not create your account." };
    }

    if (authError) {
      postSignupStarted.current = false;
      setIsSubmitting(false);
      resetTurnstile();
      if (isSetupTokenError(authError)) {
        // Missing or wrong ?token=: only the installer's link can create the owner.
        setSetupLinkRejected(true);
        return;
      }
      if (isSignupClosedError(authError)) {
        if (variant === "setup") {
          // Someone else created the owner account first.
          setExistingAccount(true);
          setError("Setup is already complete on this server.");
        } else if (isInvitationSearch(window.location.search)) {
          setError(INVITE_EMAIL_MESSAGE);
        } else {
          setClosedByServer(true);
        }
        return;
      }
      setExistingAccount(isExistingAccountError(authError));
      setError(authError.message ?? (authError.status === 429 ? "Too many signup attempts. Try again in a moment." : "We could not create your account."));
      return;
    }

    track("signup_completed");
    completeSignup();
  }

  const loginHref = `/app/login${nextQuery}`;
  if (isPending || session || redirecting || screen === "loading" || screen === "go-setup" || screen === "go-login") {
    return <main className="auth-loading">{redirecting ? "Opening your workspace…" : "Checking your secure session…"}</main>;
  }

  if (screen === "closed") {
    return (
      <main className="auth-page">
        <section className="auth-card">
          <Logo href="/" />
          <p className="landing-kicker">Invite only</p>
          <h1>Sign-ups are closed.</h1>
          <p>{SIGNUP_CLOSED_MESSAGE}</p>
          <Link className="ij-button ij-button--primary auth-status-action" href={loginHref}>Sign in</Link>
        </section>
      </main>
    );
  }

  if (screen === "setup-link") {
    return (
      <main className="auth-page">
        <section className="auth-card">
          <Logo href="/" />
          <p className="landing-kicker">First-run setup</p>
          <h1>Use your setup link.</h1>
          <p>{SETUP_LINK_MESSAGE}</p>
          <p>Lost it? Add <code>?token=</code> and the <code>SETUP_TOKEN</code> value from the server&apos;s <code>.env</code> file to this page&apos;s address.</p>
        </section>
      </main>
    );
  }

  const text = copy[variant];
  return (
    <main className="auth-page">
      <section className="auth-card">
        {turnstileSitekey ? <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer onReady={renderTurnstile} /> : null}
        <Logo href="/" />
        <p className="landing-kicker">{text.kicker}</p>
        <h1>{text.title}</h1>
        <p>{text.lead}</p>
        <form onSubmit={handleSubmit} onInvalid={resetTurnstile}>
          <label>Name<input autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} required /></label>
          <label>Email<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
          <label>Password<input type="password" autoComplete="new-password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
          {termsRequired ? (
            <label className="auth-checkbox">
              <input type="checkbox" checked={acceptedTerms} onChange={(event) => setAcceptedTerms(event.target.checked)} required />
              <span>I agree to the <Link href="/terms" target="_blank" rel="noreferrer">Terms</Link> and <Link href="/privacy" target="_blank" rel="noreferrer">Privacy Policy</Link>.</span>
            </label>
          ) : null}
          {turnstileSitekey ? <div ref={turnstileContainer} data-action="signup" /> : null}
          {error ? <p className="auth-error" role="alert">{error}{existingAccount ? <> <Link href={loginHref}>Log in instead</Link>.</> : null}</p> : null}
          <Button type="submit" disabled={isSubmitting || (termsRequired && !acceptedTerms) || (Boolean(turnstileSitekey) && !turnstileToken)}>{isSubmitting ? text.submitting : text.submit}</Button>
        </form>
        {variant === "signup" ? <p className="auth-switch">Already have an account? <Link href={loginHref}>Sign in</Link></p> : null}
      </section>
    </main>
  );
}
