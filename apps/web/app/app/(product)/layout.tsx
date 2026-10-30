import type { ReactNode } from "react";
import { AuthGate } from "@/components/auth-gate";
import { AppShell } from "@/components/app-shell";
import "../dashboard.css";
import "../dashboard-polish.css";
import "../dashboard-responsive.css";

export default function ProductLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGate>
      <AppShell>{children}</AppShell>
    </AuthGate>
  );
}
