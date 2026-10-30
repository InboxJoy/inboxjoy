import type { Metadata } from "next";
import Link from "next/link";
import { DOC_GROUPS } from "./_data";
import { DocsPager } from "./docs-pager";

import { DocsBreadcrumbJsonLd } from "./breadcrumbs";
const title = "Overview | InboxJoy Docs";
const description = "Guides for connecting a mailbox, importing leads, drafting campaigns, warm-up limits, the MCP server, and the REST API.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: "https://inboxjoy.online/docs" },
};

export default function DocsOverviewPage() {
  return (
    <article className="docs-article">
      <DocsBreadcrumbJsonLd href="/docs" />
      <header className="docs-page-header">
        <p className="docs-eyebrow">InboxJoy documentation</p>
        <h1>Overview</h1>
        <p className="docs-lead">Use these guides to connect a mailbox, import leads, launch a campaign, manage sending health, or connect your own code and AI agents. You do not need a developer for Gmail or Outlook connections, CSV imports, or AI drafting in the dashboard. The REST API is optional and uses a Bearer API key for your scripts and integrations. MCP is optional for agents such as Claude, ChatGPT, or Cursor, and you approve access with your InboxJoy login without an API key. Add a postal address in <strong>Settings → Workspace</strong> before you test or publish a campaign because CAN-SPAM requires it in commercial email footers. New mailboxes ramp up gradually, and recent bounces can reduce a mailbox below its configured daily limit.</p>
      </header>

      <div className="docs-overview-groups">
        {DOC_GROUPS.map((group) => (
          <section className="docs-overview-group" key={group.title}>
            <h2>{group.title}</h2>
            <ul>
              {group.pages.map((page) => (
                <li key={page.href}>
                  <Link href={page.href}>{page.title}</Link>
                  <p>{page.description}</p>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <DocsPager currentHref="/docs" />
    </article>
  );
}
