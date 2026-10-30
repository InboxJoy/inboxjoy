"use client";

import Link from "next/link";
import { authClient } from "@/lib/auth-client";

export function NavAuthLink({ className, tabIndex }: { className?: string; tabIndex?: number }) {
  const { data: session } = authClient.useSession();

  return (
    <Link className={className} href={session ? "/app" : "/app/login"} tabIndex={tabIndex}>
      {session ? "Dashboard" : "Log in"}
    </Link>
  );
}
