import type { Instrumentation } from "next";
import { editionConfigError } from "@/lib/edition";
import { getPostHogServer } from "@/lib/posthog-server";

function postHogDistinctId(cookieHeader: string | string[] | undefined) {
  const cookies = Array.isArray(cookieHeader) ? cookieHeader.join(";") : cookieHeader;
  const cookieMatch = cookies?.match(/ph_phc_.*?_posthog=([^;]+)/);
  if (!cookieMatch?.[1]) return undefined;

  try {
    const cookie = JSON.parse(decodeURIComponent(cookieMatch[1])) as { distinct_id?: unknown };
    return typeof cookie.distinct_id === "string" ? cookie.distinct_id : undefined;
  } catch {
    return undefined;
  }
}

// Runs once at server start, so a misconfigured deploy fails its healthcheck
// and rolls back instead of serving wrong pages. A missing INBOXJOY_EDITION
// would otherwise run the hosted site as self-host (no billing, no marketing
// site), and loading oauth-consent throws in production when WEB_BASE_URL is
// missing rather than failing on the first OAuth consent request.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const editionError = editionConfigError(process.env);
  if (editionError) throw new Error(editionError);
  await import("@/lib/oauth-consent");
}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  const posthog = getPostHogServer();
  if (!posthog) return;

  posthog.captureException(error, postHogDistinctId(request.headers.cookie), {
    route_path: context.routePath,
    route_type: context.routeType,
    router_kind: context.routerKind,
  });
  await posthog.flush();
};
