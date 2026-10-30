"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@inboxjoy/ui";
import { AppDialog } from "@/components/app-dialog";
import { authClient } from "@/lib/auth-client";
import { resendVerificationEmail } from "@/lib/email-verification";

type ResendState = "idle" | "sending" | "sent" | "error";

function useVerificationPrompt() {
  const { data: session, refetch } = authClient.useSession();
  const email = session?.user.email ?? "";
  const sessionId = session?.session.id ?? "";
  const unverified = session?.user.emailVerified === false;
  const [resendState, setResendState] = useState<ResendState>("idle");
  const [resendError, setResendError] = useState("");
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (!cooldown) return;
    const timer = window.setInterval(() => setCooldown((seconds) => Math.max(0, seconds - 1)), 1_000);
    return () => window.clearInterval(timer);
  }, [cooldown]);

  useEffect(() => {
    if (!unverified) return;
    const refresh = () => { void refetch(); };
    const onVisibilityChange = () => { if (document.visibilityState === "visible") refresh(); };
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refetch, unverified]);

  const resend = useCallback(async () => {
    if (!email || cooldown || resendState === "sending") return;
    setResendState("sending");
    setResendError("");
    try {
      await resendVerificationEmail(email);
      setCooldown(60);
      setResendState("sent");
      await refetch();
    } catch (reason) {
      setResendState("error");
      setResendError(reason instanceof Error ? reason.message : "We could not resend the verification email.");
    }
  }, [cooldown, email, refetch, resendState]);

  const resendLabel = useMemo(() => {
    if (resendState === "sending") return "Sending…";
    if (resendState === "sent" && cooldown > 57) return "Sent.";
    if (cooldown) return `Resend in ${cooldown}s`;
    return "Resend";
  }, [cooldown, resendState]);

  return { cooldown, email, resend, resendError, resendLabel, resendState, sessionId, unverified };
}

export function EmailVerificationBanner() {
  const verification = useVerificationPrompt();
  const dismissalKey = verification.sessionId ? `inboxjoy.verify-email.dismissed:${verification.sessionId}` : "";
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    if (!dismissalKey) return;
    setDismissed(window.sessionStorage.getItem(dismissalKey) === "1");
  }, [dismissalKey]);

  if (!verification.unverified || dismissed) return null;

  return <div className="verification-banner" role="status">
    <p><strong>Verify your email to start sending.</strong> We sent a link to {verification.email}.</p>
    <div className="verification-banner__actions">
      <Button disabled={Boolean(verification.cooldown) || verification.resendState === "sending"} onClick={() => void verification.resend()} variant="secondary">{verification.resendLabel}</Button>
      <button aria-label="Dismiss email verification reminder" onClick={() => { window.sessionStorage.setItem(dismissalKey, "1"); setDismissed(true); }} type="button">✕</button>
    </div>
    {verification.resendError ? <p className="verification-prompt-error" role="alert">{verification.resendError}</p> : null}
  </div>;
}

export function EmailVerificationModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const verification = useVerificationPrompt();

  useEffect(() => {
    if (open && !verification.unverified) onClose();
  }, [onClose, open, verification.unverified]);

  if (!open || !verification.unverified) return null;

  return <AppDialog actions={<>
    <Button onClick={() => void verification.resend()} disabled={Boolean(verification.cooldown) || verification.resendState === "sending"}>{verification.resendLabel}</Button>
    <Button onClick={onClose} variant="ghost">Not now</Button>
  </>} eyebrow="Sending blocked" onClose={onClose} title="Verify your email to start sending">
    <p>We sent a link to {verification.email}.</p>
    {verification.resendError ? <p className="verification-prompt-error" role="alert">{verification.resendError}</p> : null}
  </AppDialog>;
}
