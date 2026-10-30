import { PostHog } from "posthog-node";

let client: PostHog | null | undefined;

export function getPostHogServer() {
  if (client !== undefined) return client;

  const token = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
  // Off without a token. An unset or empty host means PostHog's public cloud
  // (the SDK default); our cloud build passes its own proxy host.
  client = token
    ? new PostHog(token, { host: process.env.NEXT_PUBLIC_POSTHOG_HOST || undefined })
    : null;
  return client;
}
