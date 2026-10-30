import type { Metadata } from "next";
import Link from "next/link";
import { DocsPager } from "../docs-pager";

import { DocsBreadcrumbJsonLd } from "../breadcrumbs";
const title = "Connect your mailbox: Gmail, Outlook, or SMTP/IMAP | InboxJoy Docs";
const description = "Connect Gmail or Outlook with OAuth, or another mailbox with SMTP/IMAP and app passwords. Manage connections, limits, sending windows, and pause/resume.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: "https://inboxjoy.online/docs/connect-inbox" },
};

export default function ConnectInboxPage() {
  return (
    <article className="docs-article">
      <DocsBreadcrumbJsonLd href="/docs/connect-inbox" />
      <header className="docs-page-header">
        <p className="docs-eyebrow">Getting started</p>
        <h1>Connect your email account</h1>
        <p className="docs-lead">By the end of this page, your existing mailbox can send campaigns with the limits and schedule you choose.</p>
      </header>

      <section>
        <h2>Connect Gmail or Outlook (recommended)</h2>
        <p>Use the one-click OAuth connection for Gmail or Outlook whenever possible. You approve access with your provider without sharing a mailbox password with InboxJoy.</p>
        <ol className="docs-procedure">
          <li>
            <h3>Open the Mailboxes page</h3>
            <p>Click <strong>Connect mailbox</strong>, then choose <strong>Gmail</strong> or <strong>Outlook</strong>.</p>
          </li>
          <li>
            <h3>Approve provider access</h3>
            <p>Complete the one-click OAuth connection through Composio. Your provider redirects you back to InboxJoy with the mailbox ready to use as a campaign sender.</p>
          </li>
          <li>
            <h3>Confirm the mailbox is active</h3>
            <p>Check that the mailbox shows <strong>Active</strong>. With OAuth, you do not need to enter SMTP settings or an app password.</p>
          </li>
        </ol>
      </section>

      <section>
        <h2>Connect any other mailbox (SMTP/IMAP)</h2>
        <p>If your workspace has SMTP/IMAP connections enabled, choose <strong>Connect mailbox → SMTP/IMAP</strong> on the <Link href="/app/inboxes">Mailboxes page</Link>. This option supports password-based mail access where your provider permits it, including Zoho, Fastmail, and hosted custom-domain mailboxes.</p>
        <ol className="docs-procedure">
          <li><h3>Get your provider&rsquo;s connection settings</h3><p>Use the email address you want as the From address. Find the SMTP sending server and IMAP receiving server in your provider&rsquo;s settings. Your website or domain name is not necessarily the mail server.</p></li>
          <li><h3>Create an app password if required</h3><p>Use a dedicated app password rather than your regular sign-in password when your provider supports it. Enable IMAP access and password-based SMTP access if required by your provider or administrator.</p></li>
          <li><h3>Enter both connections</h3><p>Enter the host, port, security, username, and password for SMTP and IMAP. Usernames start with your email address and can be edited. <strong>Use same password as SMTP</strong> is checked by default; uncheck it if your IMAP password is different. A display name is optional.</p></li>
          <li><h3>Test and connect</h3><p>Click <strong>Connect mailbox</strong>. InboxJoy tests SMTP and IMAP access before saving the connection. Testing can take about ten seconds; an error identifies the setting to check. Credentials are stored encrypted and saved passwords are never returned to the browser.</p></li>
        </ol>
        <div className="docs-table-wrap">
          <table className="docs-table">
            <thead><tr><th>Required setting</th><th>SMTP (sending)</th><th>IMAP (receiving)</th></tr></thead>
            <tbody>
              <tr><td>Host</td><td>Your provider&rsquo;s SMTP hostname</td><td>Your provider&rsquo;s IMAP hostname</td></tr>
              <tr><td>Port and security</td><td>587 with STARTTLS (default), or 465 with SSL/TLS</td><td>993 with SSL/TLS (default), or 143 with STARTTLS</td></tr>
              <tr><td>Username</td><td>Usually your full email address</td><td>Usually your full email address</td></tr>
              <tr><td>Password</td><td>A provider-issued app password, where required</td><td>The same password, or a separate IMAP app password</td></tr>
            </tbody>
          </table>
        </div>
        <p>SMTP ports 25 and 2525 are also accepted when your provider requires them. Use the provider&rsquo;s prescribed TLS setting; InboxJoy does not offer an unencrypted connection option.</p>
        <ul className="docs-list">
          <li><strong>Gmail:</strong> Prefer the Gmail OAuth option. If your account permits app passwords, enable two-step verification and create an app password in your Google Account security settings. Workspace administrators may restrict this option.</li>
          <li><strong>Outlook:</strong> Prefer the Outlook OAuth option. If your Microsoft account offers app passwords, create one after enabling two-step verification. An app password does not override a requirement for OAuth or an administrator&rsquo;s SMTP/IMAP restrictions; use the Outlook connection when password-based access is unavailable.</li>
          <li><strong>Zoho, Fastmail, and custom domains:</strong> Follow your host&rsquo;s app-password instructions and use its exact server names. Check whether your plan and administrator permit SMTP/IMAP access. For a custom domain, the settings come from the mailbox host, not necessarily the domain registrar.</li>
        </ul>
        <p>Keep app passwords private. Do not paste them into support messages, screenshots, or campaign content. If an app password is revoked, reconnect with a replacement.</p>
      </section>

      <section>
        <h2>Check the mailbox status</h2>
        <div className="docs-table-wrap">
          <table className="docs-table">
            <thead><tr><th>Status</th><th>Meaning</th></tr></thead>
            <tbody>
              <tr><td>Connecting</td><td>The provider connection is in progress.</td></tr>
              <tr><td>Active</td><td>The mailbox is connected and can send campaign email.</td></tr>
              <tr><td>Paused</td><td>Sending is manually paused from the Mailboxes page. Resume to start sending again.</td></tr>
              <tr><td>Expired</td><td>The OAuth authorization or SMTP/IMAP credentials need attention. Reconnect the mailbox.</td></tr>
              <tr><td>Error</td><td>The provider rejected the last request. Reconnect the mailbox.</td></tr>
              <tr><td>Disconnected</td><td>The mailbox was disconnected and is no longer used for sending.</td></tr>
            </tbody>
          </table>
        </div>
        <p>If the address shows <strong>Address pending — reconnect</strong>, the connection did not fully complete. Reconnect it from the <strong>Mailboxes</strong> page.</p>
      </section>

      <section>
        <h2>Reconnect a mailbox</h2>
        <p>Open the <strong>Mailboxes</strong> page and use the reconnect action when a mailbox shows <strong>Expired</strong>, <strong>Error</strong>, or a pending address.</p>
        <p>For SMTP/IMAP mailboxes, <strong>Reconnect</strong> opens the saved host, port, security, and username settings. Passwords remain blank: use <strong>Replace password</strong> to change them, or leave them unchanged to retain the stored credentials. A replacement SMTP password also replaces the IMAP password when <strong>Use same password as SMTP</strong> is checked. Reconnecting tests both connections before saving.</p>
        <p>Use <strong>Check connection</strong> on a non-paused, connected SMTP/IMAP mailbox to test its saved credentials without entering them again. Pause or disconnect remains a separate action; resume a paused mailbox explicitly before checking it.</p>
        <p>If a mailbox connects successfully but reply detection could not be set up, InboxJoy still lets it send. A banner asks you to reconnect. Reply detection lets InboxJoy stop follow-ups automatically when someone replies.</p>
      </section>

      <section>
        <h2>Set caps, a sending window, and a timezone</h2>
        <p>Edit these safety settings for each connected mailbox on the <strong>Mailboxes</strong> page:</p>
        <ul className="docs-list">
          <li><strong>Daily limit:</strong> Set up to 200 emails per day.</li>
          <li><strong>Hourly limit:</strong> Set up to 50 emails per hour.</li>
          <li><strong>Sending window:</strong> Choose the days of the week and start and end times when campaigns can send.</li>
          <li><strong>Timezone:</strong> Choose the timezone used to evaluate that mailbox&rsquo;s sending window.</li>
        </ul>
        <p>A new mailbox does not send at its configured daily limit right away. It warms up gradually. See <Link href="/docs/warmup-and-limits">Manage warm-up and sending limits</Link>.</p>
      </section>

      <section>
        <h2>Pause, resume, or disconnect a mailbox</h2>
        <p>Click <strong>Pause</strong> on the <strong>Mailboxes</strong> page to stop sending immediately without disconnecting the mailbox. Click <strong>Resume</strong> to continue sending.</p>
        <p>Disconnecting removes the mailbox as a sender for active campaigns.</p>
      </section>

      <DocsPager currentHref="/docs/connect-inbox" />
    </article>
  );
}
