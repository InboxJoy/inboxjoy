import { PostHog } from "posthog-node";

import type { WorkerEnv } from "./env.js";

export type WorkerPostHog = {
  captureException: (error: unknown, context?: Record<string, unknown>) => void;
  shutdown: () => Promise<void>;
};

const disabled: WorkerPostHog = {
  captureException: () => {},
  shutdown: async () => {},
};

// Gated entirely on POSTHOG_PROJECT_TOKEN: with no token this is a plain object
// literal with no PostHog client, so it is a true no-op — zero overhead, no
// network calls. A capture failure must never break job processing, so every
// call into the client is best-effort.
export function createPostHogServer(env: Pick<WorkerEnv, "POSTHOG_PROJECT_TOKEN" | "POSTHOG_HOST">): WorkerPostHog {
  if (!env.POSTHOG_PROJECT_TOKEN) return disabled;

  const client = new PostHog(env.POSTHOG_PROJECT_TOKEN, { host: env.POSTHOG_HOST });

  return {
    captureException: (error, context) => {
      try {
        client.captureException(error, undefined, context);
      } catch {
        // Telemetry must never break job processing.
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
