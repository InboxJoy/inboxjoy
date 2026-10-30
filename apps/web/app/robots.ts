import type { MetadataRoute } from "next";
import { getEdition } from "@/lib/edition";

// Read per request: one image serves both editions (lib/edition.ts).
export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  // A self-hosted install is a private app, not a site to index.
  if (getEdition() === "selfhost") return { rules: { userAgent: "*", disallow: "/" } };
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/app", "/api", "/oauth", "/mcp", "/unsubscribe", "/.well-known"],
    },
    sitemap: [
      "https://inboxjoy.online/sitemap.xml",
      "https://inboxjoy.online/blog/sitemap.xml",
    ],
  };
}
