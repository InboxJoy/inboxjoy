import type { Metadata } from "next";
import Link from "next/link";
import { DocsPager } from "../docs-pager";

import { DocsBreadcrumbJsonLd } from "../breadcrumbs";
const title = "Fix Sending and Setup Errors | InboxJoy Docs";
const description = "Fixes for common InboxJoy errors — test-send failures, address pending, ramp paused, and invite-gated signup.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: "https://inboxjoy.online/docs/troubleshooting" },
};

export default function TroubleshootingPage() {
  return (
    <article className="docs-article">
      <DocsBreadcrumbJsonLd href="/docs/troubleshooting" />
      <header className="docs-page-header">
        <p className="docs-eyebrow">Sending</p>
        <h1>Fix sending and setup errors</h1>
        <p className="docs-lead">Use the message you see to find the cause and complete the fix.</p>
      </header>

      <div className="docs-troubleshooting">
        <section>
          <h2>Fix “Add your postal address in Settings before sending a test email.”</h2>
          <p><strong>What happened:</strong> Your test send failed with this message.</p>
          <p><strong>Why:</strong> InboxJoy requires a postal address for CAN-SPAM compliance before it sends any email, including tests.</p>
          <p><strong>How to fix it:</strong> Open <strong>Settings → Workspace</strong>, add your postal address, and try again.</p>
        </section>

        <section>
          <h2>Fix “This recipient is suppressed and cannot receive test emails.”</h2>
          <p><strong>What happened:</strong> Your test send failed with this message.</p>
          <p><strong>Why:</strong> The test address is on your workspace&rsquo;s do-not-contact list.</p>
          <p><strong>How to fix it:</strong> Remove the address from <strong>Settings → Sending</strong> if that was unintentional, or test with a different address.</p>
        </section>

        <section>
          <h2>Wait after 20 test sends in one day</h2>
          <p><strong>What happened:</strong> Test sends stopped working after the twentieth send in one day.</p>
          <p><strong>Why:</strong> InboxJoy limits Azure test sends to 20 per workspace per day to prevent misuse.</p>
          <p><strong>How to fix it:</strong> Wait until the next day, when the limit resets.</p>
        </section>

        <section>
          <h2>Fix “Address pending — reconnect”</h2>
          <p><strong>What happened:</strong> A mailbox shows this message instead of an email address.</p>
          <p><strong>Why:</strong> The OAuth connection did not fully complete.</p>
          <p><strong>How to fix it:</strong> Open the <strong>Mailboxes</strong> page and use the <strong>Reconnect</strong> action for that mailbox.</p>
        </section>

        <section>
          <h2>Clear a “needs attention” banner</h2>
          <p><strong>What happened:</strong> You connected a mailbox, but InboxJoy shows a needs attention banner.</p>
          <p><strong>Why:</strong> The mailbox can send, but InboxJoy could not set up inbound reply detection for it.</p>
          <p><strong>How to fix it:</strong> Reconnect the mailbox so replies can automatically stop follow-ups for that lead.</p>
        </section>

        <section>
          <h2>Clear “Ramp paused” or “Sending held”</h2>
          <p><strong>What happened:</strong> The mailbox warm-up shows one of these badges and little or nothing is going out.</p>
          <p><strong>Why:</strong> The mailbox&rsquo;s bounce rate rose enough to mark its health as degraded or critical. Days in that state do not count toward the warm-up ramp, and a critical mailbox is held back from sending entirely.</p>
          <p><strong>How to fix it:</strong> Clean the list behind the campaign — the bounce rate is the cause, not the mailbox. Once 24 hours pass with no new bounce, a critical mailbox returns to half volume by itself and recovers from there; you do not need to reconnect it or start a new ramp. See <Link href="/docs/warmup-and-limits">Manage warm-up and sending limits</Link>.</p>
        </section>

      </div>

      <DocsPager currentHref="/docs/troubleshooting" />
    </article>
  );
}
