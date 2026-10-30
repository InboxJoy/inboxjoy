import type { Metadata } from "next";
import { DocsPager } from "../docs-pager";

import { DocsBreadcrumbJsonLd } from "../breadcrumbs";
const title = "Connect Claude, ChatGPT, or Cursor | InboxJoy MCP";
const description = "InboxJoy is a remote MCP server. Paste one URL into Claude, ChatGPT, or Cursor and run campaigns with about 57 tools, scoped to read or write.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: "https://inboxjoy.online/docs/mcp" },
};

export default function McpDocsPage() {
  return (
    <article className="docs-article">
      <DocsBreadcrumbJsonLd href="/docs/mcp" />
      <header className="docs-page-header">
        <p className="docs-eyebrow">Agents &amp; API</p>
        <h1>Connect Claude, ChatGPT, or Cursor</h1>
        <p className="docs-lead">By the end of this page, your AI agent can use InboxJoy through its remote MCP server.</p>
      </header>

      <section>
        <h2>Connect your AI agent</h2>
        <p>InboxJoy is a remote MCP server. You do not need to build a separate integration.</p>
        <ol className="docs-procedure">
          <li>
            <h3>Add the connector URL</h3>
            <p>Open your agent&rsquo;s connector or MCP server settings and paste this URL:</p>
            <pre className="docs-code"><code>https://inboxjoy.online/mcp</code></pre>
          </li>
          <li>
            <h3>Sign in to InboxJoy</h3>
            <p>Follow the redirect to InboxJoy. Sign in and choose the workspace the agent can access.</p>
          </li>
          <li>
            <h3>Approve the requested permissions</h3>
            <p>Review the exact permissions before you approve them. No API key is involved. The connection stays authorized until you revoke it in <strong>Settings → MCP → Connected apps</strong>.</p>
          </li>
        </ol>
      </section>

      <section>
        <h2>Review the requested scopes</h2>
        <p>Every connection requests one or both scopes. InboxJoy shows each scope by name when you approve access.</p>
        <div className="docs-table-wrap">
          <table className="docs-table">
            <thead><tr><th>Scope</th><th>What it allows</th></tr></thead>
            <tbody>
              <tr><td><code>inboxjoy:read</code></td><td>Read your campaigns and sending data.</td></tr>
              <tr><td><code>inboxjoy:write</code></td><td>Create campaigns and send on your behalf.</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2>Use InboxJoy MCP tools</h2>
        <p>InboxJoy exposes every operation as an MCP tool named <code>inboxjoy_&lt;area&gt;_&lt;action&gt;</code>. Your agent can use about 57 tools.</p>
        <div className="docs-table-wrap">
          <table className="docs-table">
            <thead><tr><th>Tool</th><th>What it does</th></tr></thead>
            <tbody>
              <tr><td><code>inboxjoy_leads_import</code></td><td>Imports up to 1,000 leads at once, optionally into a named list, with optional custom fields and per-campaign variables.</td></tr>
              <tr><td><code>inboxjoy_campaigns_setLeadVariables</code></td><td>Writes personalized text for each lead, such as <code>{"{{icebreaker}}"}</code>, for one campaign.</td></tr>
              <tr><td><code>inboxjoy_campaigns_getLeadVariables</code></td><td>Shows which custom variables a campaign uses, how many leads are ready for each, and which leads still need values.</td></tr>
              <tr><td><code>inboxjoy_campaigns_listLeadVariableNames</code></td><td>Lists the custom variable names already used in your workspace.</td></tr>
              <tr><td><code>inboxjoy_sequences_draft</code></td><td>Drafts a multi-step sequence from a description.</td></tr>
              <tr><td><code>inboxjoy_campaigns_create</code></td><td>Creates a draft campaign from a sequence, list, and mailbox.</td></tr>
              <tr><td><code>inboxjoy_campaigns_launch</code></td><td>Publishes a campaign and enrolls every eligible contact.</td></tr>
              <tr><td><code>inboxjoy_campaigns_get</code></td><td>Gets per-step analytics and enrollment status counts.</td></tr>
              <tr><td><code>inboxjoy_analytics_summary</code></td><td>Gets workspace delivery analytics and daily time series.</td></tr>
              <tr><td><code>inboxjoy_export_csv</code></td><td>Exports leads, suppressions, or campaign results as CSV.</td></tr>
            </tbody>
          </table>
        </div>
        <p>The full set covers leads, campaigns and sequences, sending analytics, suppressions, templates, search, notifications, and workspace and team read access. Read-scoped tools are available with <code>inboxjoy:read</code> alone. Write actions require <code>inboxjoy:write</code>.</p>
      </section>

      <section>
        <h2>Personalize each lead with custom variables</h2>
        <p>Sequence steps can use tokens such as <code>{"{{icebreaker}}"}</code> that carry a different line for every lead. Your agent writes the lines with <code>inboxjoy_campaigns_setLeadVariables</code> (pass a campaign ID or sequence ID plus each lead&rsquo;s email and a <code>variables</code> object), or includes <code>variables</code> on each lead in <code>inboxjoy_leads_import</code>.</p>
        <ul className="docs-list">
          <li><strong>Lookup order:</strong> the built-in field (<code>firstName</code>, <code>lastName</code>, <code>company</code>, <code>title</code>, <code>email</code>), then the campaign value for that lead, then the lead&rsquo;s custom field of the same name.</li>
          <li><strong>Names:</strong> letters, digits, and underscores, starting with a letter (up to 64 characters). Values are trimmed and limited to 1,000 characters.</li>
          <li><strong>Updates merge:</strong> new keys are added or overwritten, other keys stay, and <code>null</code> deletes a key.</li>
          <li><strong>Launch check:</strong> a campaign launches once every lead in its audience has a value for every custom variable its steps use. The tool response lists leads that still miss values.</li>
          <li><strong>Automatic enrollment:</strong> leads added to a live campaign enroll as soon as their values are complete, and queued emails that have not been attempted pick up new values.</li>
          <li><strong>See what is missing:</strong> <code>inboxjoy_campaigns_getLeadVariables</code> returns, per variable, how many audience leads are ready or missing, plus a paged list of leads with each value and whether it comes from the campaign or the lead. Filter to the leads that miss a value, then fill them with <code>inboxjoy_campaigns_setLeadVariables</code>.</li>
          <li><strong>Older merge tags keep working:</strong> spellings such as <code>{"{{first_name}}"}</code>, <code>{"{{FirstName}}"}</code>, and <code>{"{{company_name}}"}</code> fill from the matching built-in field.</li>
          <li><strong>Several campaigns at once:</strong> a lead can be active in more than one campaign, with its own values in each.</li>
        </ul>
      </section>

      <section>
        <h2>Ask your agent to complete a task</h2>
        <p>The tools map directly to InboxJoy operations. You can ask your agent:</p>
        <ul className="docs-list">
          <li>“Import this list of 80 leads from my CRM export into a list called Q3 outbound.”</li>
          <li>“Draft a 4-step sequence for operations leaders about reducing manual lead routing.”</li>
          <li>“Write a one-line icebreaker for each lead in Q3 outbound and save it as the icebreaker variable on that campaign.”</li>
          <li>“Which leads in Q3 outbound still need an icebreaker?”</li>
          <li>“Launch that campaign to the Q3 outbound list from my main mailbox.”</li>
          <li>“How is the campaign performing so far?”</li>
        </ul>
      </section>

      <section>
        <h2>Revoke an agent&rsquo;s access</h2>
        <p>Open <strong>Settings → MCP</strong>. Find the app and review the scopes on its active OAuth grant. Click <strong>Revoke</strong> to invalidate its tokens immediately.</p>
      </section>

      <DocsPager currentHref="/docs/mcp" />
    </article>
  );
}
