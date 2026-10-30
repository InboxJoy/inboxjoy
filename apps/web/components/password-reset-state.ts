export type PasswordResetErrorKind = "invalid-token" | "provider-unavailable" | "other";

function errorField(error: unknown, field: "code" | "message" | "status"): unknown {
  if (!error || typeof error !== "object") return undefined;
  return field in error ? error[field as keyof typeof error] : undefined;
}

export function classifyPasswordResetError(error: unknown): PasswordResetErrorKind {
  const code = String(errorField(error, "code") ?? "").toUpperCase();
  const message = String(errorField(error, "message") ?? "").toLowerCase();
  const status = Number(errorField(error, "status"));

  if (code === "INVALID_TOKEN" || message.includes("invalid token")) return "invalid-token";
  if (
    code === "RESET_PASSWORD_DISABLED"
    || code === "PASSWORD_RESET_DISABLED"
    || message.includes("reset password isn't enabled")
    || message.includes("failed to fetch")
    || status >= 500
  ) return "provider-unavailable";
  return "other";
}

export function safeNextPath(search: string): string | null {
  const next = new URLSearchParams(search).get("next");
  return next?.startsWith("/app/") ? next : null;
}

export function authPageHref(path: string, search: string): string {
  const next = safeNextPath(search);
  if (!next) return path;
  return `${path}?next=${encodeURIComponent(next)}`;
}

export function passwordResetCallbackUrl(origin: string, search: string): string {
  return new URL(authPageHref("/app/reset-password", search), origin).toString();
}

export function resetTokenFromSearch(search: string): string | null {
  const params = new URLSearchParams(search);
  if (params.get("error")?.toUpperCase() === "INVALID_TOKEN") return null;
  return params.get("token")?.trim() || null;
}
