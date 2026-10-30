"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@inboxjoy/ui";
import { useEditionFeatures } from "@/components/edition-provider";

const items = [
  ["workspace", "Workspace"],
  ["sending", "Sending"],
  ["team", "Team"],
  ["mcp", "MCP"],
  ["api-keys", "API keys"],
  ["billing", "Billing"],
  ["export", "Export & import"],
  ["danger", "Danger zone"],
] as const;

export function SettingsNav() {
  const pathname = usePathname();
  const { billing } = useEditionFeatures();
  const visibleItems = items.filter(([slug]) => slug !== "billing" || billing);

  return <nav className="settings-subnav" aria-label="Settings navigation">
    {visibleItems.map(([slug, label]) => {
      const href = `/app/settings/${slug}`;
      const active = pathname === href;
      return <Link key={slug} href={href} aria-current={active ? "page" : undefined} className={cx("settings-subnav-link", active && "settings-subnav-link--active")}>{label}</Link>;
    })}
  </nav>;
}
