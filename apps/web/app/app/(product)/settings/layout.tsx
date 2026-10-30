import type { ReactNode } from "react";
import { PageHeader } from "@inboxjoy/ui";
import { getEdition } from "@/lib/edition";
import { editionFeatures } from "@/lib/edition-features";
import { SettingsNav } from "./settings-nav";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const description = editionFeatures(getEdition()).billing
    ? "Manage workspace details, sending controls, teammates, access, and billing."
    : "Manage workspace details, sending controls, teammates, and access.";
  return <div className="page-stack settings-page dashboard-polish-page">
    <PageHeader eyebrow="Workspace" title="Settings" description={description} />
    <div className="settings-shell">
      <SettingsNav />
      <div className="settings-content">{children}</div>
    </div>
  </div>;
}
