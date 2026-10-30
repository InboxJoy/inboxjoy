"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

export const OPEN_TRACKING_SETTINGS_HREF = "/app/settings/sending#open-tracking";

/** The workspace's open-tracking setting; null until it loads (or if it can't be read), so pages keep their numbers. */
export function useOpenTrackingEnabled(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    apiFetch<{ workspace: { openTrackingEnabled?: boolean } }>("/v1/workspace", {}, "Could not load workspace settings.")
      .then((data) => { if (active) setEnabled(data.workspace.openTrackingEnabled === true); })
      .catch(() => {});
    return () => { active = false; };
  }, []);
  return enabled;
}

/** Stands in for an open count or rate while open tracking is off, and links to the setting. */
export function OpenTrackingOff() {
  return <Link className="open-tracking-off" href={OPEN_TRACKING_SETTINGS_HREF} title="Open tracking is off. Turn it on in Settings → Sending.">Off</Link>;
}
