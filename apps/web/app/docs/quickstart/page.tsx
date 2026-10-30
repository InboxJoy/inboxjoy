import type { Metadata } from "next";
import Link from "next/link";
import { DocsPager } from "../docs-pager";

import { DocsBreadcrumbJsonLd } from "../breadcrumbs";
const title = "Launch Your First Campaign | InboxJoy Docs";
const description = "Connect Gmail or Outlook, import leads, draft a campaign with AI, test-send it, and enroll leads — the InboxJoy quickstart.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: "https://inboxjoy.online/docs/quickstart" },
};

export default function QuickstartPage() {
  return (
    <article className="docs-article">
      <DocsBreadcrumbJsonLd href="/docs/quickstart" />
      <header className="docs-page-header">
        <p className="docs-eyebrow">Getting started</p>
        <h1>Launch your first campaign</h1>
        <p className="docs-lead">By the end of this page, you can launch an AI-drafted campaign from your existing mailbox in about ten minutes.</p>
      </header>

      <ol className="docs-procedure">
        <li>
          <h2>Connect Gmail or Outlook</h2>
          <p>Open the <strong>Mailboxes</strong> page. Click <strong>Connect mailbox</strong>, then choose <strong>Gmail</strong> or <strong>Outlook</strong>. This starts a one-click OAuth connection. You do not need a dedicated sending domain or DNS records.</p>
          <p>See <Link href="/docs/connect-inbox">Connect a mailbox</Link> for mailbox statuses and sending controls.</p>
        </li>
        <li>
          <h2>Import your leads</h2>
          <p>Open the <strong>Leads</strong> page and upload a CSV with an <code>email</code> column. The <code>firstName</code>, <code>lastName</code>, <code>company</code>, and <code>title</code> columns are optional.</p>
          <p>Review the preview. InboxJoy deduplicates by email and skips suppressed addresses automatically. You can also ask an AI agent connected over MCP to import leads. See <Link href="/docs/import-leads">Import leads</Link>.</p>
        </li>
        <li>
          <h2>Create a campaign</h2>
          <p>Describe what the campaign is for. AI drafts a multi-step sequence using <code>{"{{firstName}}"}</code>, <code>{"{{company}}"}</code>, and <code>{"{{title}}"}</code> merge tags.</p>
          <p>Refine any step with <strong>Shorten</strong>, <strong>Lengthen</strong>, <strong>More direct</strong>, <strong>Warmer</strong>, <strong>Fix formatting</strong>, <strong>New subject</strong>, or a custom instruction. See <Link href="/docs/campaigns">Create and manage a campaign</Link>.</p>
        </li>
        <li>
          <h2>Send yourself a test</h2>
          <p>Review the campaign, then send a test email to yourself before enrolling anyone. Test sends require a postal address on file and are capped at 20 per day per workspace.</p>
        </li>
        <li>
          <h2>Publish and enroll leads</h2>
          <p>Publish the campaign and enroll your audience. InboxJoy excludes suppressed, unsubscribed, already-replied, bounced, and already-enrolled contacts automatically. It schedules the first send inside the sending window you set for that mailbox.</p>
        </li>
      </ol>

      <aside className="docs-callout">
        <h2>Add a postal address before testing</h2>
        <p>CAN-SPAM requires a postal address in commercial email footers. Open <strong>Settings → Workspace</strong> and add yours before sending a test. InboxJoy blocks the send with an error until it is set.</p>
      </aside>

      <aside className="docs-callout docs-callout--info">
        <h2>Use an active sending mailbox</h2>
        <p>Campaigns send from a connected Gmail or Outlook mailbox with status <strong>Active</strong>. If a mailbox shows <strong>Paused</strong>, <strong>Expired</strong>, or <strong>Error</strong>, fix it on the <strong>Mailboxes</strong> page first.</p>
      </aside>

      <DocsPager currentHref="/docs/quickstart" />
    </article>
  );
}
