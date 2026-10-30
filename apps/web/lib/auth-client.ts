import { createAuthClient } from "better-auth/react";

// In the browser default to the same-origin /api proxy (like every other page's fetches).
// The server-side fallback is only used during prerender, where no auth request is made,
// but createAuthClient requires an absolute URL at module init.
const apiUrl = process.env.NEXT_PUBLIC_API_BASE_URL ??
  (typeof window !== "undefined" ? `${window.location.origin}/api` : "http://localhost:4000");

export const authClient = createAuthClient({
  baseURL: `${apiUrl}/v1/auth`,
  fetchOptions: { credentials: "include" },
});
