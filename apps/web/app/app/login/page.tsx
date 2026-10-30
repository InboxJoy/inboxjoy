"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";
import { postAuthDestination, rememberPlanHint } from "@/lib/checkout";
import { fetchInstanceStatus, loginScreen, showSignupLink, type InstanceStatus } from "@/lib/instance-status";
import { clearWorkspaceId } from "@/lib/workspaces";
import { Logo } from "@/components/logo";
import { Button } from "@inboxjoy/ui";

export default function LoginPage() {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const postLoginStarted = useRef(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [nextQuery, setNextQuery] = useState("");
  // Fetched in the background; null until it arrives or when the server cannot say.
  const [status, setStatus] = useState<InstanceStatus | null>(null);

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    setNextQuery(window.location.search);
    if (searchParams.get("verified") === "1") setNotice("Email verified. Sign in to continue.");
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchInstanceStatus().then((result) => { if (!cancelled) setStatus(result); });
    return () => { cancelled = true; };
  }, []);

  // A server with no account yet has nobody to sign in: create the owner first.
  const screen = loginScreen(isPending, Boolean(session), status);
  useEffect(() => {
    if (screen === "go-setup") router.replace(`/app/setup${window.location.search}`);
  }, [router, screen]);

  // Sign-in always lands in the product (or a safe ?next= page). An old
  // ?plan= link is forwarded as a hint for the in-app plan picker.
  const completeLogin = useCallback((useNextDestination: boolean) => {
    rememberPlanHint(window.location.search);
    router.replace(postAuthDestination(window.location.search, { useNext: useNextDestination }));
  }, [router]);

  const startPostLogin = useCallback((useNextDestination: boolean) => {
    if (postLoginStarted.current) return;
    postLoginStarted.current = true;
    setIsSubmitting(true);
    completeLogin(useNextDestination);
  }, [completeLogin]);

  useEffect(() => {
    if (!isPending && session) startPostLogin(true);
  }, [isPending, session, startPostLogin]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    setIsSubmitting(true);
    clearWorkspaceId();
    const { error: authError } = await authClient.signIn.email({ email, password });

    if (authError) {
      setIsSubmitting(false);
      setError(authError.message ?? "We could not sign you in.");
      return;
    }

    startPostLogin(true);
  }

  const signupHref = `/app/signup${nextQuery}`;
  const forgotPasswordHref = `/app/forgot-password${nextQuery}`;
  if (screen !== "form") {
    return <main className="auth-loading">Checking your secure session…</main>;
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <Logo href="/" />
        <p className="landing-kicker">Welcome back</p>
        <h1>Sign in to your workspace.</h1>
        <p>Continue building safer, more thoughtful outbound.</p>
        <form onSubmit={handleSubmit}>
          <label>Email<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
          <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
          <p className="auth-switch"><Link href={forgotPasswordHref}>Forgot your password?</Link></p>
          {notice ? <p className="auth-success" role="status">{notice}</p> : null}
          {error ? <p className="auth-error" role="alert">{error}</p> : null}
          <Button type="submit" disabled={isSubmitting}>{isSubmitting ? "Signing in…" : "Sign in"}</Button>
        </form>
        {showSignupLink(status, nextQuery) ? <p className="auth-switch">New to InboxJoy? <Link href={signupHref}>Create an account</Link></p> : null}
      </section>
    </main>
  );
}
