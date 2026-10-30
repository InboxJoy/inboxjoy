"use client";

import { Button } from "@inboxjoy/ui";
import Link from "next/link";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { authClient } from "@/lib/auth-client";
import {
  authPageHref,
  classifyPasswordResetError,
  passwordResetCallbackUrl,
  resetTokenFromSearch,
} from "@/components/password-reset-state";
import { Logo } from "@/components/logo";

function AuthCard({ kicker, title, description, children }: {
  kicker: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <main className="auth-page">
      <section className="auth-card">
        <Logo href="/" />
        <p className="landing-kicker">{kicker}</p>
        <h1>{title}</h1>
        <p>{description}</p>
        {children}
      </section>
    </main>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  if (!error || typeof error !== "object" || !("message" in error)) return fallback;
  const message = error.message;
  return typeof message === "string" && message.trim() ? message : fallback;
}

export function ForgotPasswordFlow() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "provider-unavailable">("idle");
  const [error, setError] = useState("");
  const [loginHref, setLoginHref] = useState("/app/login");

  useEffect(() => {
    setLoginHref(authPageHref("/app/login", window.location.search));
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setStatus("loading");

    try {
      const result = await authClient.requestPasswordReset({
        email,
        redirectTo: passwordResetCallbackUrl(window.location.origin, window.location.search),
      });

      if (result.error) {
        if (classifyPasswordResetError(result.error) === "provider-unavailable") {
          setStatus("provider-unavailable");
          return;
        }
        setError(errorMessage(result.error, "We could not request a reset link."));
        setStatus("idle");
        return;
      }

      setStatus("success");
    } catch (requestError) {
      if (classifyPasswordResetError(requestError) === "provider-unavailable") {
        setStatus("provider-unavailable");
        return;
      }
      setError("We could not request a reset link.");
      setStatus("idle");
    }
  }

  if (status === "success") {
    return (
      <AuthCard
        kicker="Check your inbox"
        title="Reset link requested."
        description="If an account exists for that email, we sent a link to choose a new password."
      >
        <p className="auth-switch">Check your spam folder if the message does not arrive soon.</p>
        <Link className="ij-button ij-button--primary auth-status-action" href={loginHref}>Back to sign in</Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      kicker="Account recovery"
      title="Reset your password."
      description="Enter your account email and we’ll send a secure reset link."
    >
      <form onSubmit={handleSubmit}>
        <label>
          Email
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={status === "loading"}
            required
          />
        </label>
        {status === "provider-unavailable" ? (
          <p className="auth-error" role="alert">Password reset email is unavailable right now. Please try again later or contact support.</p>
        ) : null}
        {error ? <p className="auth-error" role="alert">{error}</p> : null}
        <Button type="submit" disabled={status === "loading"}>{status === "loading" ? "Sending reset link…" : "Send reset link"}</Button>
      </form>
      <p className="auth-switch"><Link href={loginHref}>Back to sign in</Link></p>
    </AuthCard>
  );
}

export function ResetPasswordFlow() {
  const [token, setToken] = useState<string | null>(null);
  const [isCheckingToken, setIsCheckingToken] = useState(true);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "provider-unavailable">("idle");
  const [error, setError] = useState("");
  const [loginHref, setLoginHref] = useState("/app/login");
  const [forgotPasswordHref, setForgotPasswordHref] = useState("/app/forgot-password");

  useEffect(() => {
    setToken(resetTokenFromSearch(window.location.search));
    setLoginHref(authPageHref("/app/login", window.location.search));
    setForgotPasswordHref(authPageHref("/app/forgot-password", window.location.search));
    setIsCheckingToken(false);
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    if (password !== confirmation) {
      setStatus("idle");
      setError("Passwords do not match.");
      return;
    }

    setError("");
    setStatus("loading");

    try {
      const result = await authClient.resetPassword({ newPassword: password, token });
      if (result.error) {
        const kind = classifyPasswordResetError(result.error);
        if (kind === "invalid-token") {
          setToken(null);
          setStatus("idle");
          return;
        }
        if (kind === "provider-unavailable") {
          setStatus("provider-unavailable");
          return;
        }
        setError(errorMessage(result.error, "We could not reset your password."));
        setStatus("idle");
        return;
      }

      setStatus("success");
    } catch (resetError) {
      if (classifyPasswordResetError(resetError) === "provider-unavailable") {
        setStatus("provider-unavailable");
        return;
      }
      setError("We could not reset your password.");
      setStatus("idle");
    }
  }

  if (isCheckingToken) {
    return (
      <AuthCard kicker="Account recovery" title="Checking your reset link…" description="This should only take a moment.">
        <p className="auth-switch" role="status">Loading…</p>
      </AuthCard>
    );
  }

  if (!token) {
    return (
      <AuthCard kicker="Reset link expired" title="This reset link is invalid." description="Reset links can only be used once and expire for your security.">
        <Link className="ij-button ij-button--primary auth-status-action" href={forgotPasswordHref}>Request a new reset link</Link>
        <p className="auth-switch"><Link href={loginHref}>Back to sign in</Link></p>
      </AuthCard>
    );
  }

  if (status === "success") {
    return (
      <AuthCard kicker="Password updated" title="Your password has been reset." description="You can now sign in with your new password.">
        <Link className="ij-button ij-button--primary auth-status-action" href={loginHref}>Continue to sign in</Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard kicker="Account recovery" title="Choose a new password." description="Use at least 8 characters and keep it unique to InboxJoy.">
      <form onSubmit={handleSubmit}>
        <label>
          New password
          <input
            type="password"
            autoComplete="new-password"
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={status === "loading"}
            required
          />
        </label>
        <label>
          Confirm new password
          <input
            type="password"
            autoComplete="new-password"
            minLength={8}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            disabled={status === "loading"}
            required
          />
        </label>
        {status === "provider-unavailable" ? (
          <p className="auth-error" role="alert">The password service is unavailable right now. Please try again.</p>
        ) : null}
        {error ? <p className="auth-error" role="alert">{error}</p> : null}
        <Button type="submit" disabled={status === "loading"}>{status === "loading" ? "Resetting password…" : "Reset password"}</Button>
      </form>
      <p className="auth-switch"><Link href={loginHref}>Back to sign in</Link></p>
    </AuthCard>
  );
}
