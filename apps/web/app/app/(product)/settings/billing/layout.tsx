import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getEdition } from "@/lib/edition";
import { editionFeatures } from "@/lib/edition-features";

// Self-host has no billing. Old links and bookmarks land back on Settings
// instead of an empty page. Read per request: the /app layout renders dynamically.
export default function BillingSettingsLayout({ children }: { children: ReactNode }) {
  if (!editionFeatures(getEdition()).billing) redirect("/app/settings");
  return children;
}
