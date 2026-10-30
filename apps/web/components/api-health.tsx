"use client";

import { useEffect, useState } from "react";
import { StatusBadge } from "@inboxjoy/ui";
import { API_BASE_URL, workspaceRequestHeaders } from "@/lib/api";

type HealthState = "checking" | "healthy" | "offline";

export function ApiHealth() {
  const [state, setState] = useState<HealthState>("checking");

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 3000);

    fetch(`${API_BASE_URL}/health`, {
      headers: workspaceRequestHeaders(),
      cache: "no-store",
      signal: controller.signal
    })
      .then((response) => setState(response.ok ? "healthy" : "offline"))
      .catch(() => setState("offline"))
      .finally(() => window.clearTimeout(timeout));

    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, []);

  const copy = {
    checking: ["Checking API", "neutral"],
    healthy: ["API online", "good"],
    offline: ["API offline", "warning"]
  } as const;
  const [label, tone] = copy[state];

  return (
    <div className="api-health">
      <span>Backend</span>
      <StatusBadge tone={tone}>{label}</StatusBadge>
    </div>
  );
}
