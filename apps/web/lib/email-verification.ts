import { authClient } from "@/lib/auth-client";
import { checkoutPlanFromSearch } from "@/lib/checkout";

export function verificationCallbackUrl(search = window.location.search) {
  const searchParams = new URLSearchParams(search);
  const callbackUrl = new URL("/app/login", window.location.origin);
  callbackUrl.searchParams.set("verified", "1");

  const next = searchParams.get("next");
  if (next?.startsWith("/app/")) callbackUrl.searchParams.set("next", next);

  const plan = checkoutPlanFromSearch(search);
  if (plan) callbackUrl.searchParams.set("plan", plan);

  return callbackUrl.toString();
}

export async function resendVerificationEmail(email: string, search = window.location.search) {
  const { error } = await authClient.sendVerificationEmail({
    email,
    callbackURL: verificationCallbackUrl(search),
  });
  if (error) throw new Error(error.message ?? "We could not resend the verification email.");
}
