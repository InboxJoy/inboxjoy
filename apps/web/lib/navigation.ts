import type { Edition } from "@/lib/edition";
import { editionFeatures } from "@/lib/edition-features";

export type NavIcon = "dashboard" | "leads" | "campaigns" | "inbox" | "inboxes" | "analytics" | "affiliate" | "settings" | "docs";

export type NavItem = { href: string; label: string; short: string; icon: NavIcon; newTab?: boolean };

export const navItems: ReadonlyArray<NavItem> = [
  { href: "/app", label: "Dashboard", short: "D", icon: "dashboard" },
  { href: "/app/leads", label: "Leads", short: "L", icon: "leads" },
  { href: "/app/sequences", label: "Campaigns", short: "C", icon: "campaigns" },
  { href: "/app/inbox", label: "Inbox", short: "N", icon: "inbox" },
  { href: "/app/inboxes", label: "Mailboxes", short: "I", icon: "inboxes" },
  { href: "/app/analytics", label: "Analytics", short: "A", icon: "analytics" },
  { href: "/app/affiliate", label: "Refer & earn", short: "R", icon: "affiliate" },
  { href: "/app/settings", label: "Settings", short: "T", icon: "settings" },
  { href: "/docs", label: "Docs", short: "?", icon: "docs", newTab: true },
];

// The sidebar and command palette list what the running edition ships: Refer &
// earn belongs to the hosted affiliate program.
export function navItemsForEdition(edition: Edition): ReadonlyArray<NavItem> {
  const features = editionFeatures(edition);
  return navItems.filter((item) => item.icon !== "affiliate" || features.affiliate);
}
