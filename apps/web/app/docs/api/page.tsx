import type { Metadata } from "next";
import { DocsPager } from "../docs-pager";

import { DocsBreadcrumbJsonLd } from "../breadcrumbs";
const title = "Use the REST API | InboxJoy Docs";
const description = "API keys, Bearer authentication, example requests for the InboxJoy REST API, and rate limits. An OpenAPI reference is coming.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: "https://inboxjoy.online/docs/api" },
};

export default function ApiDocsPage() {
  return (
    <article className="docs-article">
      <DocsBreadcrumbJsonLd href="/docs/api" />
      <header className="docs-page-header">
        <p className="docs-eyebrow">Agents &amp; API</p>
        <h1>Use the REST API</h1>
        <p className="docs-lead">By the end of this page, your script can authenticate and make a request to the InboxJoy REST API.</p>
      </header>

      <aside className="docs-callout docs-callout--info">
        <h2>Use MCP for AI agents</h2>
        <p>Use the REST API for your own code. If an AI agent is doing the work, connect it over MCP instead. MCP does not require an API key.</p>
      </aside>

      <section>
        <h2>Create an API key</h2>
        <ol className="docs-procedure">
          <li>
            <h3>Open Settings → API keys</h3>
            <p>Only the workspace owner can create or revoke keys.</p>
          </li>
          <li>
            <h3>Create and copy the key</h3>
            <p>Copy the full key when InboxJoy shows it. The full key appears once, at creation. InboxJoy stores only a hash and cannot show the key again.</p>
          </li>
          <li>
            <h3>Revoke the key when needed</h3>
            <p>Revoking a key disables it immediately.</p>
          </li>
        </ol>
      </section>

      <section>
        <h2>Authenticate each request</h2>
        <p>Send the key as a Bearer token on every request. The base URL is <code>https://inboxjoy.online/api</code>. Every endpoint lives under <code>/v1</code>.</p>
        <pre className="docs-code"><code>{`curl https://inboxjoy.online/api/v1/leads \\
  -H "Authorization: Bearer ij_your_key_here"`}</code></pre>
      </section>

      <section>
        <h2>Keep owner and admin tasks in the browser</h2>
        <p>API keys are scoped to sending and content operations. They cannot call routes for API key management, team management, or billing. They also cannot delete a workspace. Those actions require a browser session signed in as an owner or admin.</p>
      </section>

      <section>
        <h2>List active leads</h2>
        <pre className="docs-code"><code>{`curl "https://inboxjoy.online/api/v1/leads?status=active&page=1&pageSize=25" \\
  -H "Authorization: Bearer ij_your_key_here"`}</code></pre>
      </section>

      <section>
        <h2>Import leads</h2>
        <pre className="docs-code"><code>{`curl https://inboxjoy.online/api/v1/leads/import \\
  -H "Authorization: Bearer ij_your_key_here" \\
  -H "Content-Type: application/json" \\
  -d '{
    "leads": [
      { "email": "ada@example.com", "firstName": "Ada", "company": "Example Co" }
    ],
    "listName": "Q3 outbound"
  }'`}</code></pre>
      </section>

      <section>
        <h2>Handle rate limits</h2>
        <p>Requests are limited to 300 per minute per workspace. If you exceed the limit, InboxJoy returns a 429 response with a message that tells you how long to wait before retrying.</p>
      </section>

      <section>
        <h2>Use the available endpoint guidance</h2>
        <p>A full OpenAPI reference covering every endpoint is coming. Until then, this page and the example requests cover the most common operations: leads, campaigns, and imports.</p>
      </section>

      <DocsPager currentHref="/docs/api" />
    </article>
  );
}
