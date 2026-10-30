import type { MetadataRoute } from "next";
import { getEdition } from "@/lib/edition";

// Read per request: one image serves both editions (lib/edition.ts).
export const dynamic = "force-dynamic";

const baseUrl = "https://inboxjoy.online";
const lastModified = new Date();

const routes: Array<{ path: string; priority: number; changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"] }> = [
  { path: "", priority: 1, changeFrequency: "weekly" },
  { path: "/blog/", priority: 0.8, changeFrequency: "daily" },
  { path: "/pricing", priority: 0.9, changeFrequency: "weekly" },
  { path: "/alternatives", priority: 0.8, changeFrequency: "monthly" },
  { path: "/alternatives/mailshake", priority: 0.7, changeFrequency: "monthly" },
  { path: "/alternatives/instantly", priority: 0.7, changeFrequency: "monthly" },
  { path: "/alternatives/smartlead", priority: 0.7, changeFrequency: "monthly" },
  { path: "/alternatives/lemlist", priority: 0.7, changeFrequency: "monthly" },
  { path: "/alternatives/apollo", priority: 0.7, changeFrequency: "monthly" },
  { path: "/alternatives/woodpecker", priority: 0.7, changeFrequency: "monthly" },
  { path: "/use-cases", priority: 0.8, changeFrequency: "monthly" },
  { path: "/use-cases/founders", priority: 0.7, changeFrequency: "monthly" },
  { path: "/use-cases/sales-teams", priority: 0.7, changeFrequency: "monthly" },
  { path: "/use-cases/agencies", priority: 0.7, changeFrequency: "monthly" },
  { path: "/use-cases/saas", priority: 0.7, changeFrequency: "monthly" },
  { path: "/use-cases/recruiting", priority: 0.7, changeFrequency: "monthly" },
  { path: "/use-cases/consulting", priority: 0.7, changeFrequency: "monthly" },
  { path: "/use-cases/real-estate", priority: 0.7, changeFrequency: "monthly" },
  { path: "/free-tools", priority: 0.7, changeFrequency: "monthly" },
  { path: "/free-tools/subject-line-checker", priority: 0.6, changeFrequency: "monthly" },
  { path: "/free-tools/spam-word-checker", priority: 0.6, changeFrequency: "monthly" },
  { path: "/free-tools/spf-dkim-dmarc-checker", priority: 0.6, changeFrequency: "monthly" },
  { path: "/free-tools/warmup-calculator", priority: 0.6, changeFrequency: "monthly" },
  { path: "/free-tools/bounce-rate-calculator", priority: 0.6, changeFrequency: "monthly" },
  { path: "/docs", priority: 0.8, changeFrequency: "monthly" },
  { path: "/docs/quickstart", priority: 0.7, changeFrequency: "monthly" },
  { path: "/docs/connect-inbox", priority: 0.7, changeFrequency: "monthly" },
  { path: "/docs/import-leads", priority: 0.7, changeFrequency: "monthly" },
  { path: "/docs/campaigns", priority: 0.7, changeFrequency: "monthly" },
  { path: "/docs/warmup-and-limits", priority: 0.7, changeFrequency: "monthly" },
  { path: "/docs/mcp", priority: 0.7, changeFrequency: "monthly" },
  { path: "/docs/api", priority: 0.7, changeFrequency: "monthly" },
  { path: "/docs/troubleshooting", priority: 0.6, changeFrequency: "monthly" },
  { path: "/privacy", priority: 0.3, changeFrequency: "yearly" },
  { path: "/terms", priority: 0.3, changeFrequency: "yearly" },
];

export default function sitemap(): MetadataRoute.Sitemap {
  // Self-hosted installs have no marketing pages to list.
  if (getEdition() === "selfhost") return [];
  return routes.map(({ path, priority, changeFrequency }) => ({
    url: `${baseUrl}${path}`,
    changeFrequency,
    priority,
    lastModified,
  }));
}
