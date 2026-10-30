import type { Metadata } from "next";
import { DocsPager } from "../docs-pager";

import { DocsBreadcrumbJsonLd } from "../breadcrumbs";
const title = "Create and Manage a Campaign | InboxJoy Docs";
const description = "AI-drafted campaigns, saved sender mailboxes, merge tags, refine actions, publish and pause, automatic reply detection, and per-step analytics.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: "https://inboxjoy.online/docs/campaigns" },
};

export default function CampaignsPage() {
  return (
    <article className="docs-article">
      <DocsBreadcrumbJsonLd href="/docs/campaigns" />
      <header className="docs-page-header">
        <p className="docs-eyebrow">Sending</p>
        <h1>Create and manage a campaign</h1>
        <p className="docs-lead">By the end of this page, you can draft, refine, publish, and monitor a campaign.</p>
      </header>

      <aside className="docs-callout docs-callout--info">
        <h2>Use campaign in the dashboard</h2>
        <p>The InboxJoy dashboard uses <strong>campaign</strong> for a series of email steps sent to an audience. In the API, campaigns are called sequences.</p>
      </aside>

      <section>
        <h2>Create a campaign</h2>
        <ol className="docs-procedure">
          <li>
            <h3>Choose the Audience</h3>
            <p>Select the leads you want the campaign to reach.</p>
          </li>
          <li>
            <h3>Write the Message</h3>
            <p>Describe the campaign in a sentence or two. Pick <strong>Direct</strong> or <strong>Friendly</strong>, then choose 2 to 8 steps.</p>
            <p>AI drafts the full campaign in InboxJoy&rsquo;s house voice. The draft is short, direct, and free of exclamation marks and hype language.</p>
          </li>
          <li>
            <h3>Review and test</h3>
            <p>Check your message with a preview through Azure email before publishing. Choose the connected Gmail or Outlook mailboxes your campaign will use; launching saves that selection for future enrollments.</p>
          </li>
        </ol>
      </section>

      <section>
        <h2>Personalize the draft</h2>
        <p>Built-in merge tags are <code>{"{{firstName}}"}</code>, <code>{"{{lastName}}"}</code>, <code>{"{{company}}"}</code>, <code>{"{{title}}"}</code>, and <code>{"{{email}}"}</code>.</p>
        <p>Add custom per-lead variables such as <code>{"{{icebreaker}}"}</code> to any step. InboxJoy fills each one in this order:</p>
        <ol className="docs-list docs-list--compact">
          <li>The built-in lead field, when the name matches one.</li>
          <li>The value set for that lead in this campaign through the MCP tool <code>campaigns.setLeadVariables</code>.</li>
          <li>The lead&apos;s custom field from your import.</li>
        </ol>
        <p>Launch waits until every lead in the audience has a value for each custom variable, and names the leads that still need one. Leads added later join the campaign once their values arrive.</p>
      </section>

      <section>
        <h2>Refine a campaign step</h2>
        <p>Edit a step directly, type a custom instruction, or choose a one-click action:</p>
        <ul className="docs-list docs-list--compact">
          <li><strong>Shorten</strong></li>
          <li><strong>Lengthen</strong></li>
          <li><strong>More direct</strong></li>
          <li><strong>Warmer</strong></li>
          <li><strong>Fix formatting</strong></li>
          <li><strong>New subject</strong></li>
        </ul>
        <p>A refine action replaces the step and offers <strong>Undo</strong>, so you can restore the previous draft.</p>
      </section>

      <section>
        <h2>Set the delay between steps</h2>
        <p>Set each step&rsquo;s delay in days from the previous step. For example, you can send an opener, a bump three days later, and a break-up email a week after that.</p>
      </section>

      <section>
        <h2>Change the campaign status</h2>
        <div className="docs-table-wrap">
          <table className="docs-table">
            <thead><tr><th>Action</th><th>Available when</th><th>Effect</th></tr></thead>
            <tbody>
              <tr><td>Publish</td><td>Draft</td><td>Makes the campaign active and eligible to enroll leads. Requires a postal address on file.</td></tr>
              <tr><td>Pause</td><td>Active</td><td>Holds new sends and keeps existing enrollments ready to resume.</td></tr>
              <tr><td>Resume</td><td>Paused</td><td>Continues sending from where the campaign left off. Emails that came due while paused go out right away, and edits you saved while paused apply to every email not sent yet.</td></tr>
              <tr><td>Duplicate</td><td>Any status</td><td>Creates a new draft copy of the campaign.</td></tr>
              <tr><td>Archive</td><td>Draft or paused</td><td>Removes the campaign from active use.</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2>Save your sender mailboxes</h2>
        <p>Keep new contacts sending from the mailboxes you choose. Open <strong>Sender mailboxes</strong> on your campaign and choose <strong>Rotate across all healthy mailboxes</strong> to spread contacts across available capacity, or <strong>Choose specific mailboxes</strong> and select at least one mailbox.</p>
        <p>Click <strong>Save changes</strong> to save the full selection while your campaign is draft, active, or paused. Draft and paused campaigns also save your message edits. Active campaigns save your mailbox selection while their email steps keep sending.</p>
        <p>New enrollments use your saved selection automatically. Save any mailbox changes before clicking <strong>Enroll contacts</strong>. Contacts waiting for their first email can move to the selected mailboxes; contacts who have already received an email keep their sender for every follow-up.</p>
      </section>

      <section>
        <h2>Enroll eligible leads</h2>
        <p>Queue eligible contacts by enrolling your audience after you publish. InboxJoy automatically filters suppressed, unsubscribed, already-replied, bounced, and already-enrolled contacts.</p>
        <p>The enrollment card shows your saved sender selection. Each contact keeps the same sender address for every follow-up in the campaign.</p>
      </section>

      <section>
        <h2>Let replies stop follow-ups</h2>
        <p>Before every scheduled send, InboxJoy checks whether the lead has replied. If they have, InboxJoy skips later campaign steps for that lead.</p>
      </section>

      <section>
        <h2>Review campaign analytics</h2>
        <p>See how your campaign performs with per-step counts for sent, opened, and replied emails, plus open and reply rates.</p>
      </section>

      <section>
        <h2>Honor unsubscribe requests</h2>
        <p>Every sent email includes an unsubscribe link in the footer beside your workspace&rsquo;s postal address. A recipient who unsubscribes is added to your suppression list and excluded from future sends.</p>
      </section>

      <DocsPager currentHref="/docs/campaigns" />
    </article>
  );
}
