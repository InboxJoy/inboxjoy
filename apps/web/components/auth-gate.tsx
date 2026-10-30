"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

export function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { data: session, isPending, refetch } = authClient.useSession();

  useEffect(() => {
    if (isPending || session) return;
    let cancelled = false;
    const toLogin = () => {
      const destination = pathname + window.location.search;
      if (!cancelled) router.replace("/app/login?next=" + encodeURIComponent(destination));
    };
    // Right after sign-up useSession can report "no session" for a beat. Confirm with
    // the server before bouncing to login, which would otherwise flash the login
    // page and drop the landing URL's query (e.g. the ?plan= hint).
    void authClient.getSession().then(({ data }) => {
      if (cancelled) return;
      if (data) void refetch();
      else toLogin();
    }).catch(toLogin);
    return () => { cancelled = true; };
  }, [isPending, pathname, refetch, router, session]);

  if (isPending || !session) {
    return <main className="auth-loading">Checking your secure session…</main>;
  }

  return <>{children}</>;
}
