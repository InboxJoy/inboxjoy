"use client";

import { useEffect } from "react";
import { normalizeRefCode } from "@/lib/affiliate-ref";
import { workspaceRequestHeaders } from "@/lib/api";

const COOKIE_NAME = "ij_ref";
const COOKIE_MAX_AGE_SECONDS = 60 * 24 * 60 * 60; // 60 days
const SESSION_CLICK_PREFIX = "ij_ref_click_sent:";

function setRefCookie(code: string) {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${COOKIE_NAME}=${code}; Max-Age=${COOKIE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax${secure}`;
}

function sendClickOnce(code: string) {
  const key = `${SESSION_CLICK_PREFIX}${code}`;
  try {
    if (window.sessionStorage.getItem(key) === "1") return;
    window.sessionStorage.setItem(key, "1");
  } catch {
    // Storage can be unavailable in private modes. Fire the click anyway —
    // worst case it's recorded more than once per session.
  }

  try {
    fetch("/api/v1/public/affiliate/click", {
      method: "POST",
      headers: workspaceRequestHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ code }),
      keepalive: true,
      credentials: "include",
    }).catch(() => {});
  } catch {
    // Never let click tracking affect rendering.
  }
}

/**
 * Mounted by HostedSiteExtras (components/edition-scope.tsx) on the hosted
 * site's pages; never on self-host. Reads `?ref=<code>` from the URL, stores it in a 60-day cookie
 * (last click wins) for the signup API to read server-side, and reports the
 * click once per browser session per code. Renders nothing and must never
 * throw or affect page rendering.
 */
export function AffiliateRefCapture() {
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const code = normalizeRefCode(params.get("ref"));
      if (!code) return;
      setRefCookie(code);
      sendClickOnce(code);
    } catch {
      // Swallow everything — referral capture is best-effort only.
    }
  }, []);

  return null;
}
