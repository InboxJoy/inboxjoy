import { connection } from "next/server";

// Which product this deployment is:
// "cloud" is the managed service we sell, "selfhost" the open-source edition.
// Server-only: read from the running server's environment, never baked into
// the build, so one published image serves both editions. Client components get
// it from EditionProvider (components/edition-provider.tsx).
export type Edition = "cloud" | "selfhost";

const EDITIONS: readonly string[] = ["cloud", "selfhost"] satisfies Edition[];

// Dev and test fall back to self-host so a fresh clone just works. Production
// never gets here without a valid value: instrumentation.ts refuses to start.
export function getEdition(): Edition {
  return process.env.INBOXJOY_EDITION === "cloud" ? "cloud" : "selfhost";
}

export function isCloudEdition(): boolean {
  return getEdition() === "cloud";
}

/**
 * The edition for server rendering. Awaiting it renders the route per request,
 * so a page that reads the edition is never prerendered with the build
 * machine's value (images are built without one, which reads as self-host).
 * Layouts use this; plain getEdition() is for the proxy, route handlers that
 * opt out of caching, and pages already under such a layout (/app, /docs).
 */
export async function getRequestEdition(): Promise<Edition> {
  await connection();
  return getEdition();
}

type EditionEnv = { NODE_ENV?: string; NEXT_PHASE?: string; INBOXJOY_EDITION?: string };

/**
 * Why this web server must not start, or null when the edition is usable. Same
 * rule as the API and worker (packages/config): production needs cloud or
 * selfhost spelled out, blank counts as unset, and an unknown value is always
 * wrong. `next build` is exempt: images are built without the variable.
 */
export function editionConfigError(env: EditionEnv): string | null {
  if (env.NEXT_PHASE === "phase-production-build") return null;
  const value = env.INBOXJOY_EDITION;
  if (value === undefined || value.trim() === "") {
    return env.NODE_ENV === "production" ? "INBOXJOY_EDITION must be set to cloud or selfhost in production." : null;
  }
  return EDITIONS.includes(value) ? null : `INBOXJOY_EDITION must be cloud or selfhost, not "${value}".`;
}
