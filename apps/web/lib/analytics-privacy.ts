import type { CapturedNetworkRequest } from "posthog-js";

const INVITE_TOKEN_PATH = /((?:\/|%(?:25)*2f)app(?:\/|%(?:25)*2f)invite(?:\/|%(?:25)*2f))(?:(?!%(?:25)*(?:2f|3f|23|26))[^/?#&\s])+/gi;

type SessionRecordingControls = {
  stopSessionRecording: () => void;
  startSessionRecording: () => void;
};

export function containsInviteTokenPath(location: string): boolean {
  return location.search(INVITE_TOKEN_PATH) !== -1;
}

export function updateSessionRecording(location: string, recording: SessionRecordingControls): void {
  if (containsInviteTokenPath(location)) recording.stopSessionRecording();
  else recording.startSessionRecording();
}

function redactInviteTokens(value: string): string {
  return value.replace(INVITE_TOKEN_PATH, "$1[REDACTED]");
}

function redactSensitiveUrl(value: string): string {
  if (!value) return value;
  const redacted = redactInviteTokens(value);
  try {
    const url = new URL(redacted, window.location.origin);
    for (const key of [...url.searchParams.keys()]) {
      if (/token|auth|email|key/i.test(key)) url.searchParams.set(key, "[REDACTED]");
      else {
        const values = url.searchParams.getAll(key);
        if (values.some((entry) => redactInviteTokens(entry) !== entry)) {
          url.searchParams.delete(key);
          for (const entry of values) url.searchParams.append(key, redactInviteTokens(entry));
        }
      }
    }
    return url.toString();
  } catch {
    return redacted;
  }
}

export function redactSensitiveQueryParameters(request: CapturedNetworkRequest): CapturedNetworkRequest {
  if (typeof request.name === "string") request.name = redactSensitiveUrl(request.name);
  return request;
}

export function sanitizeCapturedEvent<T extends { properties?: Record<string, unknown> } | null>(event: T): T {
  if (!event?.properties) return event;

  for (const key of ["$current_url", "$referrer", "$initial_current_url", "$initial_referrer"]) {
    if (typeof event.properties[key] === "string") event.properties[key] = redactSensitiveUrl(event.properties[key]);
  }
  if (typeof event.properties.$pathname === "string") event.properties.$pathname = redactInviteTokens(event.properties.$pathname);
  for (const containerKey of ["$set", "$set_once"]) {
    const container = event.properties[containerKey];
    if (!container || typeof container !== "object" || Array.isArray(container)) continue;
    const values = container as Record<string, unknown>;
    for (const key of ["$current_url", "$referrer", "$initial_current_url", "$initial_referrer"]) {
      if (typeof values[key] === "string") values[key] = redactSensitiveUrl(values[key]);
    }
    if (typeof values.$pathname === "string") values.$pathname = redactInviteTokens(values.$pathname);
  }
  return event;
}
