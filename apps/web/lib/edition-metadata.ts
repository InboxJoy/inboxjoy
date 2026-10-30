import type { Metadata } from "next";
import type { Edition } from "@/lib/edition";

// The root layout carries the hosted site's metadata, statically: marketing
// pages are cloud-only (proxy.ts), so they can be prerendered. Pages that both
// editions serve layer this on per request from their layout's
// generateMetadata. A self-hosted instance is a private tool, not the public
// InboxJoy site: it neither claims the canonical URL nor asks to be indexed.
export function editionMetadata(edition: Edition): Metadata {
  if (edition === "cloud") return {};
  return {
    description: "Email sequencing for Gmail, Outlook and any SMTP mailbox, running on your own server.",
    alternates: { canonical: null },
    robots: { index: false, follow: false },
  };
}
