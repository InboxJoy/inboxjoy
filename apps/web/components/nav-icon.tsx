import { LayoutDashboard, UsersRound, Send, Inbox, ChartNoAxesCombined, Gift, Settings2, BookOpen } from "lucide-react";
import type { NavIcon as NavIconName } from "@/lib/navigation";

const icons = { dashboard: LayoutDashboard, leads: UsersRound, campaigns: Send, inbox: Inbox, inboxes: Inbox, analytics: ChartNoAxesCombined, affiliate: Gift, settings: Settings2, docs: BookOpen };

export function NavIcon({ name }: { name: NavIconName }) {
  const Icon = icons[name];
  return <Icon aria-hidden="true" className="nav-icon" size={20} strokeWidth={1.75} />;
}
