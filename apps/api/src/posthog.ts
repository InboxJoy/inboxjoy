import type { AppEnv } from "@inboxjoy/config";
import { PostHog } from "posthog-node";

export type ApiPostHog = {
  captureException: (error: unknown, context?: Record<string, unknown>) => void;
  shutdown: () => Promise<void>;
};

const disabled: ApiPostHog = {
  captureException: () => {},
  shutdown: async () => {},
};

// Gated entirely on POSTHOG_PROJECT_TOKEN: with no token this is a plain object
// literal with no PostHog client, so it is a true no-op — zero overhead, no
// network calls. A capture failure must never break a request, so every call
// into the client is best-effort.
export function createPostHogServer(env: Pick<AppEnv, "POSTHOG_PROJECT_TOKEN" | "POSTHOG_HOST">): ApiPostHog {
  if (!env.POSTHOG_PROJECT_TOKEN) return disabled;

  const client = new PostHog(env.POSTHOG_PROJECT_TOKEN, { host: env.POSTHOG_HOST });

  return {
    captureException: (error, context) => {
      try {
        client.captureException(error, undefined, context);
      } catch {
        // Telemetry must never break a request.
      }
    },
    shutdown: async () => {
      try {
        await client.shutdown();
      } catch {
        // Best-effort flush on shutdown.
      }
    },
  };
}
