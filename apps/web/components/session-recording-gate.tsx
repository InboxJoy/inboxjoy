"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import posthog from "posthog-js";
import { updateSessionRecording } from "@/lib/analytics-privacy";

export function SessionRecordingGate() {
  const pathname = usePathname();
  const search = useSearchParams().toString();

  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN) return;
    const update = () => updateSessionRecording(window.location.href, posthog);
    update();
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, [pathname, search]);

  return null;
}
