import type { Edition } from "@/lib/edition";

// What each edition ships. Every feature
// of the app itself stays in both editions; only the commercial layer around it
// is cloud-only. Server and client code read this one table, so a surface can't
// be hidden in one place and left showing in another.
export type EditionFeatures = {
  // Dodo checkout, the licence banner and plan picker, Settings > Billing.
  billing: boolean;
  // Refer & earn page and the ?ref= cookie capture.
  affiliate: boolean;
  // Piqo, the hosted site's analytics. PostHog stays opt-in by its own key.
  piqo: boolean;
  // Marketing and legal pages. Self-host sends them to the app.
  marketingSite: boolean;
};

export function editionFeatures(edition: Edition): EditionFeatures {
  const cloud = edition === "cloud";
  return { billing: cloud, affiliate: cloud, piqo: cloud, marketingSite: cloud };
}

// First path segments that belong to the marketing site. `/` is the home page.
// Keep in step with `config.matcher` in proxy.ts (a test compares them), and add
// new marketing sections here and there.
export const MARKETING_SEGMENTS: readonly string[] = [
  "pricing",
  "alternatives",
  "use-cases",
  "compare",
  "free-tools",
  "blog",
  "terms",
  "privacy",
];

export function isMarketingPath(pathname: string): boolean {
  if (pathname === "" || pathname === "/") return true;
  const segment = pathname.split("/")[1]?.toLowerCase() ?? "";
  return MARKETING_SEGMENTS.includes(segment);
}
