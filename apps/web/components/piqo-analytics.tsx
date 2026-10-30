"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { isProductPath, loadPiqo } from "@/lib/piqo";

/**
 * Mounted by HostedSiteExtras (components/edition-scope.tsx) on the hosted
 * site's marketing pages, app and docs; never on self-host. Renders nothing and
 * must never throw or affect page rendering.
 */
export function PiqoAnalytics() {
  const pathname = usePathname();

  // Piqo auto-captures the text of clicked buttons and links. Product screens
  // put lead names and emails in that text, so auto-capture stays on the
  // public site; product pages send pageviews and explicit track() events.
  useEffect(() => {
    document.documentElement.toggleAttribute("data-piqo-ignore", isProductPath(pathname));
  }, [pathname]);

  useEffect(() => {
    try {
      loadPiqo();
    } catch {
      // Analytics is best-effort only.
    }
  }, []);

  return null;
}
