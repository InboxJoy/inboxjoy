"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { track } from "@/lib/analytics";
import { workspaceRequestHeaders } from "@/lib/api";

export type GuideCalloutSource = "home" | "pricing";

type GuideCalloutState = "hidden" | "entering" | "idle" | "submitting" | "success" | "error" | "dismissed";

const SESSION_SHOWN_KEY = "inboxjoy.guide-callout.shown";
const SNOOZED_UNTIL_KEY = "inboxjoy.guide-callout.snoozed-until";
const COMPLETED_KEY = "inboxjoy.guide-signup.completed";
const MINIMUM_DELAY_MS = 3_000;
// Show after 60% of the page, or on desktop exit intent (cursor leaving the top edge).
const SCROLL_THRESHOLD = 0.6;
const ENTRY_DURATION_MS = 380;
const SUCCESS_DISMISS_MS = 6_000;
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1_000;

function readStorage(storageName: "localStorage" | "sessionStorage", key: string) {
  try {
    return window[storageName].getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(storageName: "localStorage" | "sessionStorage", key: string, value: string) {
  try {
    window[storageName].setItem(key, value);
  } catch {
    // Storage can be unavailable in privacy modes. The callout still works.
  }
}

function removeStorage(storageName: "localStorage" | "sessionStorage", key: string) {
  try {
    window[storageName].removeItem(key);
  } catch {
    // Storage can be unavailable in privacy modes. The callout still works.
  }
}

function shouldSuppressCallout() {
  if (readStorage("localStorage", COMPLETED_KEY) === "1") return true;
  if (readStorage("sessionStorage", SESSION_SHOWN_KEY) === "1") return true;

  const snoozedUntil = Number(readStorage("localStorage", SNOOZED_UNTIL_KEY));
  if (Number.isFinite(snoozedUntil) && snoozedUntil > Date.now()) return true;
  if (snoozedUntil) removeStorage("localStorage", SNOOZED_UNTIL_KEY);

  return false;
}

export function GuideCallout({ source }: { source: GuideCalloutSource }) {
  const [state, setState] = useState<GuideCalloutState>("hidden");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const submittingRef = useRef(false);
  const descriptionId = useId();
  const errorId = useId();
  const titleId = useId();

  useEffect(() => {
    if (shouldSuppressCallout()) return;

    let delayElapsed = false;
    let thresholdCrossed = false;
    let revealed = false;

    const revealIfReady = () => {
      if (revealed || !delayElapsed || !thresholdCrossed) return;
      revealed = true;
      writeStorage("sessionStorage", SESSION_SHOWN_KEY, "1");
      setState("entering");
      window.removeEventListener("scroll", checkScrollPosition);
      window.removeEventListener("resize", checkScrollPosition);
      document.removeEventListener("mouseout", checkExitIntent);
    };

    const checkExitIntent = (event: MouseEvent) => {
      if (event.relatedTarget || event.clientY > 0) return;
      thresholdCrossed = true;
      revealIfReady();
    };

    const checkScrollPosition = () => {
      const scrollableHeight = document.documentElement.scrollHeight - window.innerHeight;
      if (scrollableHeight <= 0 || window.scrollY / scrollableHeight < SCROLL_THRESHOLD) return;
      thresholdCrossed = true;
      revealIfReady();
    };

    const delayTimer = window.setTimeout(() => {
      delayElapsed = true;
      revealIfReady();
    }, MINIMUM_DELAY_MS);

    checkScrollPosition();
    window.addEventListener("scroll", checkScrollPosition, { passive: true });
    window.addEventListener("resize", checkScrollPosition, { passive: true });
    document.addEventListener("mouseout", checkExitIntent);

    return () => {
      window.clearTimeout(delayTimer);
      window.removeEventListener("scroll", checkScrollPosition);
      window.removeEventListener("resize", checkScrollPosition);
      document.removeEventListener("mouseout", checkExitIntent);
    };
  }, []);

  useEffect(() => {
    if (state !== "entering") return;
    const timer = window.setTimeout(() => setState("idle"), ENTRY_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [state]);

  useEffect(() => {
    if (state !== "success") return;
    const timer = window.setTimeout(() => setState("dismissed"), SUCCESS_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [state]);

  const dismiss = () => {
    writeStorage("localStorage", SNOOZED_UNTIL_KEY, String(Date.now() + SNOOZE_MS));
    setState("dismissed");
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submittingRef.current) return;

    const form = event.currentTarget;
    const input = form.elements.namedItem("email");
    if (!(input instanceof HTMLInputElement) || !input.validity.valid) {
      setError("That email doesn't look right.");
      setState("error");
      return;
    }

    submittingRef.current = true;
    setError("");
    setState("submitting");

    try {
      const response = await fetch("/api/v1/guide-signup", {
        method: "POST",
        headers: workspaceRequestHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ email: email.trim(), source }),
      });

      if (!response.ok) {
        if (response.status === 400) setError("That email doesn't look right.");
        else if (response.status === 429) setError("Too many tries — give it a minute.");
        else setError("Something went wrong. Try again.");
        setState("error");
        return;
      }

      const result = await response.json() as { ok?: unknown };
      if (result.ok !== true) {
        setError("Something went wrong. Try again.");
        setState("error");
        return;
      }

      writeStorage("localStorage", COMPLETED_KEY, "1");
      removeStorage("localStorage", SNOOZED_UNTIL_KEY);
      track("guide_signup", { source });
      setState("success");
    } catch {
      setError("Something went wrong. Try again.");
      setState("error");
    } finally {
      submittingRef.current = false;
    }
  };

  if (state === "hidden" || state === "dismissed") return null;

  const describedBy = error ? `${descriptionId} ${errorId}` : descriptionId;

  return (
    <aside
      aria-labelledby={titleId}
      className={`guide-callout guide-callout--${state}`}
      data-state={state}
    >
      <div className="guide-callout__card">
        <button
          aria-label="Dismiss guide signup"
          className="guide-callout__close"
          onClick={dismiss}
          type="button"
        >
          <X aria-hidden="true" size={18} strokeWidth={2} />
        </button>

        {state === "success" ? (
          <div className="guide-callout__success" role="status">
            <h2 id={titleId}>You&apos;re on the list.</h2>
            <p>The guide lands in your inbox soon.</p>
          </div>
        ) : (
          <>
            <h2 id={titleId}>The Stupidly Simple Cold Email Guide</h2>
            <p className="guide-callout__description" id={descriptionId}>
              Everything we know about cold email that lands. Free, in your inbox.
            </p>
            <form className="guide-callout__form" noValidate onSubmit={(event) => void submit(event)}>
              <label className="sr-only" htmlFor={`${descriptionId}-email`}>Email address</label>
              <div className="guide-callout__fields">
                <input
                  aria-describedby={describedBy}
                  aria-invalid={Boolean(error)}
                  autoComplete="email"
                  disabled={state === "submitting"}
                  id={`${descriptionId}-email`}
                  inputMode="email"
                  name="email"
                  onChange={(event) => {
                    setEmail(event.target.value);
                    if (state === "error") {
                      setError("");
                      setState("idle");
                    }
                  }}
                  placeholder="you@company.com"
                  required
                  type="email"
                  value={email}
                />
                <button disabled={state === "submitting"} type="submit">
                  {state === "submitting" ? "Sending…" : "Send me the guide"}
                </button>
              </div>
              {error ? <p className="guide-callout__error" id={errorId} role="alert">{error}</p> : null}
              <p className="guide-callout__privacy">The guide and nothing else. No spam.</p>
            </form>
          </>
        )}
      </div>
    </aside>
  );
}
