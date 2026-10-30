import { NextResponse, type NextRequest } from "next/server";
import { getEdition } from "@/lib/edition";
import { editionFeatures, isMarketingPath } from "@/lib/edition-features";

// Self-host has no marketing or legal site: the instance is the product, so
// those routes send people to the app. Runs in Node at request time, so the
// edition comes from the running container's environment, not from the build.
// Cloud passes straight through.
export function proxy(request: NextRequest) {
  if (editionFeatures(getEdition()).marketingSite || !isMarketingPath(request.nextUrl.pathname)) return NextResponse.next();
  // Next requires an absolute URL here (a relative Location makes the proxy
  // throw "Invalid URL" and answer 500) and hands clients a relative one.
  return NextResponse.redirect(new URL("/app", request.url), 307);
}

// Matchers must be literals (Next reads them at build time). Keep this list in
// step with MARKETING_SEGMENTS in lib/edition-features.ts; a test compares them.
export const config = {
  matcher: [
    "/",
    "/pricing/:path*",
    "/alternatives/:path*",
    "/use-cases/:path*",
    "/compare/:path*",
    "/free-tools/:path*",
    "/blog/:path*",
    "/terms/:path*",
    "/privacy/:path*",
  ],
};
