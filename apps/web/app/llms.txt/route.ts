export const runtime = "nodejs";

import { getEdition } from "@/lib/edition";
import { SELF_HOST_REPO_URL } from "@/lib/site-links";

// Read per request: one image serves both editions (lib/edition.ts).
export const dynamic = "force-dynamic";

const BASE_URL = "https://inboxjoy.online";

const body = `# InboxJoy

> Cold-email sequencing SaaS. Connect Gmail or Outlook in one click, import contacts by CSV or MCP, let AI draft a multi-step sequence, and follow-ups run until someone replies.

InboxJoy is open source (AGPL-3.0) and comes two ways: self-host it free on your own server, or use the managed service at inboxjoy.online for a one-time $79 lifetime license. Both have every feature.

InboxJoy targets solo founders, small sales teams, and agencies who send their own outreach from their own inbox and do not want a heavyweight sales-ops platform. It is also MCP-native: the app itself is a remote MCP server, so campaigns can be run entirely from an AI agent such as Claude, ChatGPT, or Cursor.

## Docs

- [Overview](${BASE_URL}/docs): Guide index.
- [Launch your first campaign](${BASE_URL}/docs/quickstart): Connect an inbox, import leads, draft a campaign with AI, test it, and enroll leads.
- [Connect Gmail or Outlook](${BASE_URL}/docs/connect-inbox): One-click Gmail/Outlook, mailbox statuses, reconnecting, per-mailbox caps and sending windows.
- [Import leads](${BASE_URL}/docs/import-leads): CSV columns, file limit, dedupe, suppression, import previews, bulk actions.
- [Create and manage a campaign](${BASE_URL}/docs/campaigns): AI-drafted campaigns, merge tags, refine actions, publish/pause/archive, reply detection, analytics.
- [Manage warm-up and sending limits](${BASE_URL}/docs/warmup-and-limits): The warm-up ramp, per-mailbox caps and windows, suppression enforcement, bounce handling.
- [Fix sending and setup errors](${BASE_URL}/docs/troubleshooting): Common errors and how to resolve them.
- [Connect Claude, ChatGPT, or Cursor (MCP)](${BASE_URL}/docs/mcp): Remote MCP server, OAuth connection, scopes, and available tools.
- [Use the REST API](${BASE_URL}/docs/api): API keys, authentication, endpoints, and rate limits.

## MCP server

- Connector URL: ${BASE_URL}/mcp
- Authentication: OAuth 2.1 with a workspace picker; no API key required.
- Scopes: inboxjoy:read, inboxjoy:write.

## Other pages

- [Blog](${BASE_URL}/blog/): Practical guides about cold email, deliverability, follow-ups, and outbound workflows.
- [Blog RSS feed](${BASE_URL}/blog/rss/): Automatically updated feed of every published article.
- [Blog sitemap](${BASE_URL}/blog/sitemap.xml): Automatically updated index of all blog posts, authors, and tags.
- [Pricing](${BASE_URL}/pricing): Self-host free (open source, AGPL-3.0) or managed for a $79 lifetime license, paid once.
- [Source code](${SELF_HOST_REPO_URL}): The open-source repository and self-hosting docs.
- [Use cases](${BASE_URL}/use-cases): Playbooks for founders, sales teams, agencies, SaaS, recruiting, consulting, and real estate.
- [Free tools](${BASE_URL}/free-tools): Subject line checker, spam word checker, SPF/DKIM/DMARC checker, warmup calculator, bounce rate calculator.
- [Comparisons](${BASE_URL}/alternatives): InboxJoy vs Instantly, Smartlead, Lemlist, Apollo, Woodpecker, and Mailshake.
`;

export async function GET(): Promise<Response> {
  // It describes the hosted site; a self-hosted install has nothing to publish.
  if (getEdition() === "selfhost") return new Response("Not found", { status: 404 });
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
