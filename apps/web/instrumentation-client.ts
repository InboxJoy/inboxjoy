import posthog from "posthog-js";
import { track } from "@/lib/analytics";
import { containsInviteTokenPath, redactSensitiveQueryParameters, sanitizeCapturedEvent, updateSessionRecording } from "@/lib/analytics-privacy";

export { redactSensitiveQueryParameters, sanitizeCapturedEvent } from "@/lib/analytics-privacy";

const token = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;

export function onRouterTransitionStart(url: string): void {
  if (token) updateSessionRecording(`${window.location.href} ${url}`, posthog);
}

if (token) {
  posthog.init(token, {
    // Empty (the Dockerfile default) must fall back to PostHog's public cloud, not "".
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || undefined,
    ui_host: process.env.NEXT_PUBLIC_POSTHOG_UI_HOST,
    defaults: "2026-05-30",
    person_profiles: "identified_only",
    autocapture: false,
    // Pageviews and product events live in Piqo; PostHog keeps replay and errors.
    capture_pageview: false,
    capture_pageleave: false,
    before_send: sanitizeCapturedEvent,
    capture_exceptions: true,
    disable_session_recording: containsInviteTokenPath(window.location.href),
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: "[data-ph-mask], .ph-mask",
      maskInputOptions: { password: true, email: true, text: true },
      maskCapturedNetworkRequestFn: redactSensitiveQueryParameters,
    },
  });

  updateSessionRecording(window.location.href, posthog);
}

// Runs with or without PostHog: track() reports to Piqo.
const analyticsWindow = window as typeof window & { __inboxjoyPostHogFetchPatched?: boolean };
if (!analyticsWindow.__inboxjoyPostHogFetchPatched) {
  analyticsWindow.__inboxjoyPostHogFetchPatched = true;
  const originalFetch = window.fetch;
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    const [input, init] = args;
    const requestUrl = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (response.ok && method === "POST") {
      const pathname = new URL(requestUrl, window.location.origin).pathname;
      if (pathname.endsWith("/send-verification-email")) track("verify_email_resent");
      if (pathname.endsWith("/sign-out")) window.dispatchEvent(new Event("inboxjoy:signout-succeeded"));
    }
    return response;
  };
}
