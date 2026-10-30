"use client";

import { useEffect, type ReactNode } from "react";

export type ToastTone = "success" | "error" | "warning" | "info";

const icons: Record<ToastTone, ReactNode> = {
  success: <path d="m5 12 4 4L19 6" />,
  error: <><path d="m7 7 10 10" /><path d="M17 7 7 17" /></>,
  warning: <><path d="M12 4 3.5 19h17L12 4Z" /><path d="M12 9v4" /><path d="M12 16h.01" /></>,
  info: <><path d="M12 11v6" /><path d="M12 7h.01" /><circle cx="12" cy="12" r="9" /></>,
};

export function Toast({ tone = "info", message, action, onDismiss }: { tone?: ToastTone; message: string; action?: ReactNode; onDismiss?: () => void }) {
  useEffect(() => {
    if (!onDismiss) return;
    const timeout = window.setTimeout(onDismiss, tone === "error" ? 8000 : tone === "warning" ? 6000 : 4500);
    return () => window.clearTimeout(timeout);
  }, [message, onDismiss, tone]);

  return <div className={`app-toast app-toast--${tone}`} role={tone === "error" ? "alert" : "status"} aria-live={tone === "error" ? "assertive" : "polite"}>
    <span className="app-toast__icon" aria-hidden="true"><svg viewBox="0 0 24 24">{icons[tone]}</svg></span>
    <p>{message}</p>
    {action}
    {onDismiss ? <button className="app-toast__close" aria-label="Dismiss notification" onClick={onDismiss} type="button">×</button> : null}
  </div>;
}
