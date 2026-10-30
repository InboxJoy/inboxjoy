import type { Metadata } from "next";
import Link from "next/link";
import { DocsPager } from "../docs-pager";

import { DocsBreadcrumbJsonLd } from "../breadcrumbs";
const title = "Manage Warm-up and Sending Limits | InboxJoy Docs";
const description = "How InboxJoy's warm-up ramp works, per-mailbox daily and hourly caps, sending windows, suppression enforcement, and bounce handling.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: "https://inboxjoy.online/docs/warmup-and-limits" },
};

export default function WarmupAndLimitsPage() {
  return (
    <article className="docs-article">
      <DocsBreadcrumbJsonLd href="/docs/warmup-and-limits" />
      <header className="docs-page-header">
        <p className="docs-eyebrow">Sending</p>
        <h1>Manage warm-up and sending limits</h1>
        <p className="docs-lead">By the end of this page, you can read a mailbox&rsquo;s effective cap and understand what changes its sending volume.</p>
      </header>

      <section>
        <h2>Monitor the warm-up ramp</h2>
        <p>A newly connected mailbox starts at 8 emails per day. Its allowed volume then compounds by about 15% each day until it reaches the mailbox&rsquo;s configured daily limit.</p>
        <p>Depending on that limit, the mailbox typically reaches full speed in roughly two to three weeks. A mailbox capped at 50 per day reaches full speed sooner than one capped at 200 per day.</p>
        <p>Open the <strong>Mailboxes</strong> page to see each mailbox&rsquo;s warm-up progress as a percentage and today&rsquo;s effective cap.</p>
      </section>

      <section>
        <h2>Skip warm-up for trusted mailboxes</h2>
        <p>If a mailbox already has stable sending history, open <strong>Safety settings</strong> on the <strong>Mailboxes</strong> page and turn on <strong>This mailbox is already warmed up — send at full speed</strong>.</p>
        <p>InboxJoy removes the ramp start date for that mailbox, so it can use its configured daily limit immediately. Turn the setting off to start a fresh ramp from today.</p>
      </section>

      <section>
        <h2>Respond when bounces pause the ramp</h2>
        <p>A day does not count toward the ramp when bounces push a mailbox&rsquo;s health to degraded or critical. The countdown pauses instead of continuing through a bad day.</p>
        <p>The <strong>Mailboxes</strong> page shows <strong>Ramp paused — today does not count</strong> beside the warm-up percentage, along with the current bounce rate. The ramp resumes counting when health recovers.</p>
        <p>Recovery does not need you to do anything: if no new bounce arrives for 24 hours, a critical mailbox steps back to half volume on its own, and that trickle of sends restores the bounce rate from there. Fresh bounces put it back on hold.</p>
      </section>

      <section>
        <h2>Set mailbox caps and sending windows</h2>
        <p>Configure these limits independently for every mailbox:</p>
        <ul className="docs-list">
          <li><strong>Daily limit:</strong> Set up to 200 emails per day for each mailbox.</li>
          <li><strong>Hourly limit:</strong> Set up to 50 emails per hour for each mailbox.</li>
          <li><strong>Sending window:</strong> Choose the days and hours when the mailbox can send. InboxJoy evaluates the window in that mailbox&rsquo;s timezone.</li>
        </ul>
        <p>A workspace-wide daily send cap also applies across every connected mailbox combined. Configure it in <strong>Settings → Sending</strong>.</p>
      </section>

      <section>
        <h2>Rotate across several mailboxes</h2>
        <p>When you connect multiple Gmail or Outlook mailboxes, you multiply your daily capacity. When you enroll leads, InboxJoy spreads them across healthy mailboxes in proportion to each mailbox&rsquo;s remaining daily capacity, including its warm-up limit.</p>
        <p>Each lead keeps the same sender address for every follow-up in the sequence. Paused or unhealthy mailboxes are skipped automatically.</p>
      </section>

      <section>
        <h2>Keep suppressed addresses from sending</h2>
        <p>InboxJoy checks every send against your workspace suppression list when the email goes out, not only at enrollment. If you add an enrolled lead&rsquo;s address to the do-not-contact list, that address does not receive further sends.</p>
      </section>

      <section>
        <h2>Check bounce-related limits</h2>
        <p>InboxJoy calculates each mailbox&rsquo;s bounce rate from recent sends. When the rate rises, InboxJoy cuts the effective daily limit automatically, independent of the configured daily limit.</p>
        <div className="docs-table-wrap">
          <table className="docs-table">
            <thead><tr><th>Mailbox health</th><th>Trigger</th><th>Effective daily limit</th></tr></thead>
            <tbody>
              <tr><td>Healthy</td><td>Bounce rate under 2%</td><td>Full configured daily limit</td></tr>
              <tr><td>Degraded</td><td>Bounce rate 2% or higher, or repeated send failures</td><td>Cut to about half the daily limit</td></tr>
              <tr><td>Critical</td><td>Bounce rate 5% or higher, or repeated permanent failures</td><td>Cut to zero until it recovers</td></tr>
            </tbody>
          </table>
        </div>
        <p>InboxJoy calculates these limits automatically from delivery events. There is nothing to configure. Keeping your list clean is the most direct way to avoid a reduction. See <Link href="/docs/import-leads">Import leads</Link>.</p>
      </section>

      <DocsPager currentHref="/docs/warmup-and-limits" />
    </article>
  );
}
