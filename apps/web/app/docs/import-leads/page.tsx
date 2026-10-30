import type { Metadata } from "next";
import Link from "next/link";
import { DocsPager } from "../docs-pager";

import { DocsBreadcrumbJsonLd } from "../breadcrumbs";
const title = "Import Leads | InboxJoy Docs";
const description = "Add individual leads or import mapped CSV files with previewed creates, updates, skips, and suppression checks.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: "https://inboxjoy.online/docs/import-leads" },
};

export default function ImportLeadsPage() {
  return (
    <article className="docs-article">
      <DocsBreadcrumbJsonLd href="/docs/import-leads" />
      <header className="docs-page-header">
        <p className="docs-eyebrow">Getting started</p>
        <h1>Import leads</h1>
        <p className="docs-lead">Add one lead at a time or review a CSV import before any contacts are created or updated.</p>
      </header>

      <section>
        <h2>Add an individual lead</h2>
        <ol className="docs-procedure">
          <li><h3>Open Add leads</h3><p>On the <strong>Leads</strong> page, click <strong>Add leads</strong> and keep the <strong>Individual lead</strong> tab selected.</p></li>
          <li><h3>Enter the contact</h3><p>Email is required. First name, last name, company, title, and list are optional. The list defaults to the list you are currently viewing.</p></li>
          <li><h3>Save</h3><p>Choose <strong>Save lead</strong> to finish or <strong>Save and add another</strong> to keep the modal open. InboxJoy warns you if the email already exists.</p></li>
        </ol>
        <p>Open any lead to edit its name, company, or title. Email is the lead identity and cannot be changed.</p>
      </section>

      <section>
        <h2>Prepare your CSV</h2>
        <p>Your CSV can include these columns. Only <code>email</code> is required.</p>
        <div className="docs-table-wrap">
          <table className="docs-table">
            <thead><tr><th>Column</th><th>Required</th></tr></thead>
            <tbody>
              <tr><td><code>email</code></td><td>Yes</td></tr>
              <tr><td><code>firstName</code></td><td>No</td></tr>
              <tr><td><code>lastName</code></td><td>No</td></tr>
              <tr><td><code>company</code></td><td>No</td></tr>
              <tr><td><code>title</code></td><td>No</td></tr>
              <tr><td><code>source</code></td><td>No</td></tr>
            </tbody>
          </table>
        </div>
        <p>The optional fields supply the <code>{"{{firstName}}"}</code>, <code>{"{{company}}"}</code>, and <code>{"{{title}}"}</code> merge tags used in campaign drafts.</p>
        <p>CSV uploads and pasted CSV content are limited to 6MB. Split larger lists into multiple files, or import them in batches over MCP.</p>
      </section>

      <section>
        <h2>Upload and preview the file</h2>
        <ol className="docs-procedure">
          <li>
            <h3>Open the Leads page</h3>
            <p>Click <strong>Add leads</strong>, open <strong>Upload CSV</strong>, then upload a file or paste CSV content. A downloadable template is available in the modal.</p>
          </li>
          <li>
            <h3>Map columns and choose behavior</h3>
            <p>InboxJoy detects common column names automatically. Confirm the email, first name, last name, company, title, and source mappings, then choose an import mode:</p>
            <ul className="docs-list">
              <li><strong>Add new leads:</strong> Create unknown email addresses and skip existing leads.</li>
              <li><strong>Update existing leads:</strong> Update mapped, nonempty fields and skip unknown email addresses.</li>
              <li><strong>Add and update:</strong> Create unknown leads and update existing matches.</li>
            </ul>
            <p>You can use the active list, choose another list, import without a list, or name a new list. A new list is created only when you confirm the import.</p>
          </li>
          <li>
            <h3>Review the preview</h3>
            <p>Check create, update, unchanged, ready, duplicate, suppressed, invalid, and skipped counts. Updated rows show the fields that will change. Download the error CSV when you need to repair skipped rows.</p>
          </li>
          <li>
            <h3>Confirm the import</h3>
            <p>InboxJoy rechecks contacts and suppressions when you confirm. Suppressed addresses are never imported, duplicate rows in the file are skipped, and contacts changed after preview are not overwritten. The completion screen reports the actual created, updated, unchanged, and skipped totals.</p>
          </li>
        </ol>
      </section>

      <section>
        <h2>Add custom variables for personalization</h2>
        <p>Beyond the built-in merge tags, a sequence step can use any <code>{"{{name}}"}</code> token, such as <code>{"{{icebreaker}}"}</code> or <code>{"{{recentPost}}"}</code>. Names use letters, digits, and underscores and start with a letter. The names <code>firstName</code>, <code>lastName</code>, <code>company</code>, <code>title</code>, and <code>email</code> stay reserved for the built-in fields.</p>
        <p>InboxJoy fills each token in this order:</p>
        <ol className="docs-list">
          <li>The built-in field on the lead (blank when empty).</li>
          <li>The value saved for that lead on the campaign.</li>
          <li>The lead&rsquo;s custom field with the same name.</li>
        </ol>
        <p>Over MCP, each lead in <code>inboxjoy_leads_import</code> accepts <code>customFields</code> (saved on the lead for every campaign) and <code>variables</code> (saved for the campaign you name with <code>campaignId</code> or <code>sequenceId</code>). Send <code>null</code> for a key to delete it. Values are trimmed, line breaks become spaces, and each value holds up to 1,000 characters.</p>
        <h3>Import custom columns from a CSV</h3>
        <p>In the column mapping step, map any extra CSV column to a custom field and name it, for example an <strong>Ice breaker</strong> column mapped to <code>icebreaker</code>. Choose where the values go:</p>
        <ul className="docs-list">
          <li><strong>One campaign:</strong> pick the campaign and the values are saved for that campaign only, so each campaign can carry its own line for the same lead.</li>
          <li><strong>The lead:</strong> without a campaign, values are saved on the lead and every campaign can use them. A blank cell leaves the stored value as it was.</li>
        </ul>
        <p>Custom columns apply to new leads and, when you choose <strong>Update existing leads</strong> or <strong>Add and update</strong>, to existing leads. Values are saved before leads join a list, so leads that were waiting for these values in a live campaign enroll as soon as the import completes, and emails queued but not yet sent pick up the new text. Names cannot reuse a built-in field such as <code>firstName</code> or <code>company</code>.</p>
        <p>A campaign launches once every lead in its audience has a value for every custom variable its steps use. You can create the campaign, import leads, and write variables in any order before launch. After launch, leads added to the campaign&rsquo;s lists enroll automatically as soon as their values are complete. Use <code>inboxjoy_campaigns_setLeadVariables</code> to add or update values later.</p>
      </section>

      <section>
        <h2>Manage leads in bulk</h2>
        <p>Select multiple leads on the <strong>Leads</strong> page, then choose an action:</p>
        <ul className="docs-list">
          <li><strong>Enroll:</strong> Add the selected leads to a campaign.</li>
          <li><strong>Suppress:</strong> Add the selected leads&rsquo; emails to the do-not-contact list.</li>
          <li><strong>Delete:</strong> Remove the selected leads. Leads with campaign history are kept instead of deleted, so enrollment records stay intact.</li>
        </ul>
        <p>Use the search box to find leads by name, email, or company. Use the status filters to narrow the list.</p>
      </section>

      <section>
        <h2>Import leads with an AI agent</h2>
        <p>Connect an AI agent through MCP, then ask it to import leads directly. The MCP import tool accepts up to 1,000 leads per call and can add them straight to a named list, together with custom fields and personalized campaign variables. See <Link href="/docs/mcp">Connect Claude, ChatGPT, or Cursor</Link>.</p>
      </section>

      <DocsPager currentHref="/docs/import-leads" />
    </article>
  );
}
