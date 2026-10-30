import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/logo";
import { NavAuthLink } from "@/components/nav-auth-link";
import { AnnouncementBanner } from "@/components/announcement-banner";
import { PRIMARY_CTA_HREF, PRIMARY_CTA_LABEL } from "@/lib/site-links";
import "../pages.css";

const title = "Privacy Policy";
const description =
  "Read InboxJoy's privacy policy covering what we collect on the managed service, how we use it, and your data access and deletion choices.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPage() {
  return <main className="v2-page v2-legal-page">
    <AnnouncementBanner />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link href="https://fonts.googleapis.com/css2?family=Google+Sans+Flex:wght@400..800&display=swap" rel="stylesheet" />
    <section className="v2-hero-panel v2-legal-hero">
      <div className="v2-stripes" />
      <nav className="v2-nav" aria-label="Primary navigation">
        <Logo className="v2-brand" href="/" variant="white" />
        <div className="v2-nav-links"><Link href="/#features">Features</Link><Link href="/#how-it-works">How it works</Link><Link href="/pricing">Pricing</Link><Link href="/#questions">Questions</Link><NavAuthLink /></div>
        <Link className="v2-nav-cta" href={PRIMARY_CTA_HREF}>{PRIMARY_CTA_LABEL}</Link>
      </nav>
      <header className="v2-legal-header">
        <Link href="/">← Back to home</Link>
        <h1>Privacy Policy</h1>
        <p>Last updated October 29, 2026</p>
      </header>
    </section>

    <section className="v2-legal-content" aria-label="Privacy policy content">
      <p className="v2-legal-summary"><em>This policy summarizes how the service works. It is not legal advice.</em></p>
      <article>
        <h2>1. Who we are</h2>
        <p>InboxJoy is a service for creating and sending email sequences through mailboxes you connect. In this policy, “InboxJoy,” “we,” and “us” refer to InboxJoy.</p>
        <p>This policy covers the managed service at inboxjoy.online and our website. If you self-host the open-source edition, your installation runs on your own infrastructure and does not send data to us. We do not receive your workspace, contacts, messages, or usage data from a self-hosted install, and we have no access to it.</p>
        <p>Questions, privacy requests, and recipient suppression requests can be sent to <a href="mailto:hey@inboxjoy.online">hey@inboxjoy.online</a>.</p>
      </article>
      <article>
        <h2>2. When we are controller and when we are processor</h2>
        <p>We are the controller of personal data we collect to create and administer your InboxJoy account, bill your workspace, secure the service, provide support, and operate our website.</p>
        <p>You control the leads, contacts, message content, and campaign data that you or your team upload or send through InboxJoy. For that customer data, you are the controller and InboxJoy is your processor or service provider. You decide whom to contact, why you may contact them, what to say, and how long to keep their data.</p>
        <p>If you use InboxJoy for another organization, that organization is the customer and controller. You must have authority to give us instructions on its behalf.</p>
      </article>
      <article>
        <h2>3. What we collect</h2>
        <h3>Account and team data</h3>
        <p>We store your name, email address, verification state, optional profile image, password credential in protected form, acceptance date and version for the terms, and account and session timestamps. A workspace has a name, slug, status, time zone, sending limits, optional postal address, and an emergency sending switch. Team records include member roles and status, join dates, and pending invitation email addresses.</p>
        <h3>Connected mailbox data</h3>
        <p>For a Gmail, Google Workspace, or Outlook mailbox, we store the provider, mailbox address and display name, a Composio connected-account reference, connection status, time zone, sending schedule and limits, warm-up state, health data, and provider message or thread identifiers. InboxJoy does not store the Google or Microsoft OAuth token for these mailbox connections.</p>
        <h3>Customer-uploaded data and content</h3>
        <p>You can add contacts through CSV, the REST API, MCP, or the product interface. Contact fields can include email address, first and last name, company, title, website, phone, location, LinkedIn URL, source, a lawful-basis note, and custom fields. We also store lists, import records, campaigns, sequence descriptions, subjects, message bodies, personalization variables, schedules, and delivery records.</p>
        <h3>Engagement and delivery data</h3>
        <p>We record send attempts and events such as acceptance, opens, replies, automatic replies, bounces, complaints, and unsubscribes. Provider webhooks can contain sender and recipient details, message headers or content, and delivery diagnostics. We use these events to stop follow-ups, show campaign results, protect sender reputation, and add recipients to suppression lists.</p>
        <h3>Billing data</h3>
        <p>Dodo Payments handles checkout and card processing. We receive and store customer and subscription references, plan, subscription status, trial and billing dates, cancellation state, product reference, and payment webhook status. We do not receive or store full card numbers.</p>
        <h3>Technical and service data</h3>
        <p>We process session information, IP addresses and user agents used for authentication and security, API-key and OAuth grant activity, audit records, request and error logs, feature usage, and support communications. API keys, invitation tokens, and MCP tokens are stored as hashes.</p>
        <h3>Product analytics and session replay</h3>
        <p>We record product sessions inside the InboxJoy app for debugging and product improvement. Inputs and contact data are masked before they leave your browser. This recording does not apply to recipients of customer campaigns.</p>
      </article>
      <article>
        <h2>4. How we use data and our lawful bases</h2>
        <ul>
          <li><strong>Contract.</strong> We use account, workspace, mailbox, contact, message, usage, and billing data to provide the service you request, authenticate users, send messages, detect replies, process subscriptions, and provide support. This is GDPR Article 6(1)(b) where it applies.</li>
          <li><strong>Legitimate interests.</strong> We use limited account, usage, delivery, and security data to prevent abuse, enforce sending limits, troubleshoot failures, maintain suppression controls, improve reliability, and protect InboxJoy, customers, mailbox providers, and recipients. This is GDPR Article 6(1)(f) where it applies.</li>
          <li><strong>Consent.</strong> We rely on consent where applicable law requires it, including for optional tracking or communications that cannot rely on another basis. You may withdraw consent without affecting earlier processing.</li>
          <li><strong>Legal obligations.</strong> We may retain or disclose records when needed to comply with tax, accounting, court, or regulatory requirements. This is GDPR Article 6(1)(c) where it applies.</li>
        </ul>
        <p>When we process customer-controlled contact and campaign data as a processor, the customer determines the lawful basis. InboxJoy does not sell personal data or use customer contact lists for advertising.</p>
      </article>
      <article>
        <h2>5. Mailbox access</h2>
        <p>You connect Gmail or Outlook through Composio OAuth. The connection gives InboxJoy, through Composio, the provider access needed to identify the mailbox, send your campaign messages, subscribe to incoming-message events, search for replies, and inspect limited sent-message metadata when delivery is uncertain.</p>
        <p>We use mailbox access to deliver campaigns, keep message threads together, confirm whether a send succeeded, and detect replies, bounces, complaints, and expired connections. We do not use mailbox data for advertising or sell it. We do not routinely copy or index your unrelated mailbox. Automated reply searches and inbound provider events can still access relevant message metadata or content, and the webhook payload received from the provider is stored as an operational record.</p>
        <p>Composio holds the provider authorization. InboxJoy stores the connected-account reference. You can stop InboxJoy from sending through a mailbox by disconnecting it, and you can revoke the underlying authorization through Google, Microsoft, or Composio.</p>
      </article>
      <article>
        <h2>6. AI drafting</h2>
        <p>If you ask InboxJoy to draft a sequence, we send your campaign description, requested tone, and step count to Azure OpenAI. If you ask it to refine a step, we send that subject, body, action, and any custom instruction. Azure OpenAI returns generated content to InboxJoy. Do not place personal data or confidential information in an AI prompt unless you are authorized to have it processed for that purpose.</p>
      </article>
      <article>
        <h2>7. Open tracking and suppression</h2>
        <p>When open tracking is present, a small image request can record an open event. For each recorded open, InboxJoy stores the event time and message association, the first 300 characters of the user agent, a bot classification and reason where applicable, and a salted SHA-256 hash of the IP address. The raw IP is used transiently to make that hash and is not retained in raw form as part of the open event.</p>
        <p>Mail privacy tools, proxies, and security scanners can trigger the image, so an open is not proof that a person read a message. We classify known proxies, scanners, missing user agents, and immediate prefetches as automated where our rules detect them.</p>
        <p>Unsubscribe, permanent-bounce, complaint, block, and manual suppression records prevent later enrollment and sending. An unsubscribe record may include a user agent and hashed IP. We do not use tracking to build advertising profiles.</p>
      </article>
      <article>
        <h2>8. Service providers and subprocessors</h2>
        <p>We disclose only the data each provider needs for its role. Current providers are:</p>
        <div className="v2-legal-table-wrap">
          <table>
            <thead><tr><th>Provider</th><th>Purpose</th><th>Region</th></tr></thead>
            <tbody>
              <tr><td data-label="Provider">Microsoft Azure</td><td data-label="Purpose">Application hosting, PostgreSQL database, backups, monitoring, and Key Vault secrets</td><td data-label="Region">North Central US for the primary production infrastructure</td></tr>
              <tr><td data-label="Provider">Azure Communication Services</td><td data-label="Purpose">Account, billing, service, and campaign test emails</td><td data-label="Region">Europe, based on the configured service endpoint</td></tr>
              <tr><td data-label="Provider">Azure OpenAI</td><td data-label="Purpose">Optional sequence drafting and message refinement using content you submit</td><td data-label="Region">The region assigned to our configured Azure OpenAI resource</td></tr>
              <tr><td data-label="Provider">Composio</td><td data-label="Purpose">Gmail and Outlook OAuth connections, sending, provider actions, and inbound event delivery</td><td data-label="Region">Provider-managed infrastructure; no fixed region is set in InboxJoy code</td></tr>
              <tr><td data-label="Provider">Dodo Payments</td><td data-label="Purpose">Checkout, card processing, subscription management, and billing webhooks</td><td data-label="Region">Provider-managed infrastructure; no fixed region is set in InboxJoy code</td></tr>
              <tr><td data-label="Provider">PostHog</td><td data-label="Purpose">Session replay and error tracking</td><td data-label="Region">The configured PostHog cloud region</td></tr>
              <tr><td data-label="Provider">Piqo</td><td data-label="Purpose">Website and product usage analytics: page views, clicks on public pages, and conversion events</td><td data-label="Region">Provider-managed infrastructure; no fixed region is set in InboxJoy code</td></tr>
              <tr><td data-label="Provider">Ghost</td><td data-label="Purpose">Public blog software on a separate, self-hosted Azure instance; it does not receive workspace data</td><td data-label="Region">North Central US</td></tr>
            </tbody>
          </table>
        </div>
        <p>Google or Microsoft also process data under the mailbox account you choose to connect. They provide your email service rather than acting only on InboxJoy&apos;s instructions.</p>
      </article>
      <article>
        <h2>9. International transfers</h2>
        <p>Your data may be processed outside your state, province, or country. Our primary production infrastructure and separate Ghost blog instance are in North Central US. The configured Azure Communication Services endpoint is in Europe. Other provider locations are controlled by those providers and are not fixed in the application code.</p>
        <p>Where transfer law applies, we use an available lawful transfer mechanism, such as an adequacy decision, contractual safeguards, or the provider&apos;s approved transfer terms. Contact us if you need information about the mechanism relevant to your data.</p>
      </article>
      <article>
        <h2>10. Retention</h2>
        <ul>
          <li><strong>Account data.</strong> We keep it while your account is open and for up to 30 days after a closure request to finish support, security, and billing work, unless law requires longer retention.</li>
          <li><strong>Workspace and customer data.</strong> Contacts, messages, campaigns, imports, connected-mailbox references, provider webhook records, and engagement events are kept for the life of the workspace unless you delete them sooner. We do not currently apply a shorter fixed period to engagement events. Using the workspace deletion control removes live workspace-owned data.</li>
          <li><strong>Suppression data.</strong> We keep suppression entries for the life of the workspace and ordinarily indefinitely within it. Deleting an unsubscribe or complaint entry could allow the same person to be contacted again.</li>
          <li><strong>Short-lived credentials.</strong> Sessions, verification links, connection state, and OAuth codes expire according to their configured lifetime. Revoked key and grant records may remain as security records.</li>
          <li><strong>Backups.</strong> Deleted data may remain in protected database backups until the backup cycle expires. The current PostgreSQL point-in-time recovery window is 14 days.</li>
          <li><strong>Legal records.</strong> We may keep billing, fraud, dispute, and compliance records for the period required by law or needed to establish legal claims.</li>
        </ul>
        <p>Canceling a subscription is not the same as deleting a workspace. Contact us or use the workspace deletion control when you want workspace data removed.</p>
      </article>
      <article>
        <h2>11. Security</h2>
        <p>InboxJoy uses HTTPS encryption in transit. Production database traffic stays on a private Azure network. Deployment secrets are kept in Azure Key Vault and read through managed identity. Provider tokens for connected Gmail and Outlook mailboxes remain with Composio. Application access is tied to authenticated users, workspace memberships, roles, and workspace-scoped database queries. API keys, invitation tokens, and MCP tokens are stored as hashes.</p>
        <p>No system is perfectly secure. You must protect your password, connected accounts, API keys, and authorized MCP clients, and tell us promptly if you suspect unauthorized access.</p>
      </article>
      <article>
        <h2>12. Your privacy rights</h2>
        <p>Depending on where you live, you may ask to access, correct, erase, restrict, or receive a portable copy of your personal data. You may object to processing based on legitimate interests and withdraw consent where consent applies. You may also complain to your local data protection authority.</p>
        <p>Email <a href="mailto:hey@inboxjoy.online">hey@inboxjoy.online</a> to exercise a right. Tell us the account or email address involved. We may need to verify your identity. We will respond within 30 days, or within another period required by applicable law. We will tell you if a lawful extension or exception applies.</p>
        <p>For customer-controlled contact or campaign data, we normally refer your request to the customer that uploaded it and help that customer respond as its processor.</p>
      </article>
      <article>
        <h2>13. If you received a customer&apos;s email</h2>
        <p>The InboxJoy customer that contacted you controls your contact data and message. Use the unsubscribe link in the email to stop future campaign messages from that customer. You can also contact the sender or email <a href="mailto:hey@inboxjoy.online">hey@inboxjoy.online</a> and ask us to help place your address on that customer&apos;s suppression list.</p>
        <p>A suppression request stops future InboxJoy campaign sends for that workspace. It does not control messages the sender sends outside InboxJoy.</p>
      </article>
      <article>
        <h2>14. Children</h2>
        <p>InboxJoy is a business service and is not directed to children under 18. Do not create an account for a child or upload children&apos;s personal data. If you believe a child&apos;s data was provided to us, contact us so we can review and remove it.</p>
      </article>
      <article>
        <h2>15. Changes to this policy</h2>
        <p>We may update this policy when the service, our providers, or the law changes. We will change the “Last updated” date and provide additional notice for a material change when appropriate. Your continued use after the effective date is subject to the updated policy.</p>
      </article>
    </section>

    <footer className="v2-footer"><span><img alt="" className="v2-logo-mark" height={18} src="/brand/icon-64x64.png" width={18} />© 2026 InboxJoy</span><span><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link></span></footer>
  </main>;
}
