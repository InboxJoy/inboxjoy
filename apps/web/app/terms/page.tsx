import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/logo";
import { NavAuthLink } from "@/components/nav-auth-link";
import { AnnouncementBanner } from "@/components/announcement-banner";
import { PRIMARY_CTA_HREF, PRIMARY_CTA_LABEL } from "@/lib/site-links";
import "../pages.css";

const title = "Terms of Service";
const description =
  "Read InboxJoy's terms of service for the managed service, covering accounts, acceptable use, the lifetime license and payment, and liability.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/terms" },
};

export default function TermsPage() {
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
        <h1>Terms of Service</h1>
        <p>Last updated October 29, 2026</p>
      </header>
    </section>

    <section className="v2-legal-content" aria-label="Terms of service content">
      <p className="v2-legal-summary"><em>These terms summarize the rules for using the managed service. They are not legal advice.</em></p>
      <article>
        <h2>1. The agreement</h2>
        <p>These Terms of Service are an agreement between InboxJoy and the person or organization that creates or uses an InboxJoy account. “InboxJoy,” “we,” and “us” mean InboxJoy. “You” means the customer and each authorized user.</p>
        <p>By creating an account, accepting an invitation, or using InboxJoy, you agree to these terms and our Privacy Policy. If you use InboxJoy for an organization, you confirm that you can bind that organization. You must be at least 18 and able to form a contract.</p>
      </article>
      <article>
        <h2>2. Accounts and workspaces</h2>
        <p>Signup creates a user account, a workspace, and an owner membership. A workspace can have owners, admins, and members. The owner controls billing and permanent workspace deletion. Owners and admins can manage operational settings and team access as the product permits.</p>
        <p>You must provide accurate account information, keep credentials secure, protect API keys and authorized MCP clients, and promptly remove access that is no longer needed. You are responsible for actions taken by your workspace users and through your connected mailboxes, API keys, and integrations. Tell us at <a href="mailto:hey@inboxjoy.online">hey@inboxjoy.online</a> if you suspect unauthorized access.</p>
      </article>
      <article>
        <h2>3. The managed lifetime license and the self-hosted edition</h2>
        <p>InboxJoy comes in two editions. The managed service, which we host at inboxjoy.online, is what these terms cover. The self-hosted edition is open-source software that you run yourself.</p>
        <p>The managed lifetime license is a one-time payment of $79. It is not a subscription and does not renew. It gives the workspace it is bought for access to the managed service, with every product feature and unlimited team members, for as long as InboxJoy operates the managed service. You can create an account, set up a workspace and launch campaigns before you buy. Campaign emails start sending once the workspace has an active license.</p>
        <p>The hosted Free plan has been retired. Workspaces that were on it keep it for 30 days after the change, and then need the lifetime license for campaign emails to keep sending.</p>
        <p>The self-hosted edition is released under the GNU Affero General Public License v3.0 (AGPL-3.0) and is governed by that license, not by these terms. These terms do not apply to a copy of InboxJoy that you run on your own infrastructure, and we do not provide hosting, uptime, or support for it under these terms. The InboxJoy name and logo are our trademarks and are not licensed under AGPL-3.0.</p>
        <p>Prices shown at checkout control if they differ from this summary.</p>
      </article>
      <article>
        <h2>4. Payment and refunds</h2>
        <p>Dodo Payments processes checkout and payment details. The lifetime license is charged once at checkout. You authorize Dodo Payments to charge your payment method for the license fee and applicable taxes.</p>
        <p>You may request a full refund within 30 days of a charge. Email <a href="mailto:hey@inboxjoy.online">hey@inboxjoy.online</a> and we will process it. The refund goes back to the original payment method. A refund of the lifetime license ends the license when the refund is issued. The workspace is not deleted, but campaign emails stop sending until it has a license again. You can also export your workspace and self-host it under AGPL-3.0. This policy does not limit any refund or cancellation rights required by law. You are responsible for taxes other than taxes on our income.</p>
      </article>
      <article>
        <h2>5. Acceptable use</h2>
        <p>InboxJoy is a sending tool, not permission to contact anyone. You are responsible for the people you upload, the lawful basis for contacting them, your sender identity, and every message sent from your workspace.</p>
        <p>You must:</p>
        <ul>
          <li>comply with CAN-SPAM, GDPR, ePrivacy rules, and every other law that applies to you, the sender, and the recipient;</li>
          <li>use a working unsubscribe method, honor opt-outs promptly, keep suppression records, and not attempt to bypass InboxJoy suppression checks;</li>
          <li>identify the sender accurately and include a valid physical postal address when required by law;</li>
          <li>use only contact data you are authorized to process and have a lawful basis to use; and</li>
          <li>respect Gmail, Outlook, Composio, and other provider rules that apply to your accounts.</li>
        </ul>
        <p>You must not:</p>
        <ul>
          <li>send spam or unlawful, deceptive, harassing, threatening, or abusive messages;</li>
          <li>use purchased or scraped lists where recipient consent is absent or the outreach is otherwise unlawful;</li>
          <li>send phishing messages, impersonate another person, misstate sender identity, distribute malware, or collect credentials deceptively;</li>
          <li>promote illegal goods or services, sexual or adult content, exploitation, discrimination, violence, or other unlawful content;</li>
          <li>probe, disrupt, reverse engineer, or bypass the service&apos;s authentication, limits, safety gates, or suppression controls; or</li>
          <li>use InboxJoy in a way that harms recipients, mailbox providers, our infrastructure, or another customer.</li>
        </ul>
      </article>
      <article>
        <h2>6. Enforcement and sending safety</h2>
        <p>We may investigate suspected abuse and review relevant account, campaign, delivery, complaint, and suppression records. We may block a message, lower a limit, throttle a mailbox, pause a campaign, activate the workspace kill switch, suspend access, or terminate the account when needed to protect recipients, providers, the service, or others. We may act without advance notice when the risk is urgent.</p>
        <p>We may also cooperate with a lawful request and report conduct that we reasonably believe creates a security, fraud, or safety risk. You remain responsible for messages already submitted to a mailbox provider; they may not be recallable.</p>
      </article>
      <article>
        <h2>7. Sending limits, warm-up, and fair use</h2>
        <p>On the managed service, “unlimited sends” means we do not impose a plan-level monthly send quota. It does not mean unlimited throughput. Every connected mailbox has daily and hourly limits, sending windows, health controls, and provider limits. A new mailbox normally starts at 8 sends per day and ramps by about 15 percent per day until it reaches the configured cap. Workspace limits, suppressions, reply detection, account status, and the kill switch can also stop a send.</p>
        <p>You may not split traffic across workspaces, mailboxes, identities, or accounts to evade a limit. We may adjust limits based on fair use, provider constraints, reputation, complaints, bounce rates, security, or abuse risk. We do not guarantee that a provider will accept or deliver a message or place it in an inbox.</p>
      </article>
      <article>
        <h2>8. Connected services</h2>
        <p>You authorize InboxJoy and Composio to use the Gmail or Outlook access you approve to identify the mailbox, send your messages, monitor incoming events, search for replies, and inspect sent-message metadata when delivery is uncertain. You are responsible for the connected account and for keeping that authorization valid.</p>
        <p>Google, Microsoft, Composio, Dodo Payments, and other third-party services have their own terms. We are not responsible for their acts, outages, policy changes, account restrictions, or decisions to reject or filter mail.</p>
      </article>
      <article>
        <h2>9. Your data and content</h2>
        <p>You keep ownership of the contacts, lists, prompts, messages, sequences, and other content you submit. You give InboxJoy a non-exclusive, worldwide license to host, copy, transmit, format, and otherwise process that content only as needed to provide, secure, support, and improve the service and to comply with law.</p>
        <p>You confirm that you have the rights and lawful basis needed to give us the data and instructions. You must not submit content that violates another person&apos;s privacy, intellectual property, confidentiality, publicity, or other rights.</p>
        <p>If you use AI drafting or refinement on the managed service, the content and instructions you submit are sent to Azure OpenAI for generation. You are responsible for reviewing generated text before sending it. Generated text may be inaccurate or similar to content produced for others.</p>
      </article>
      <article>
        <h2>10. Our service and intellectual property</h2>
        <p>InboxJoy and its software, design, documentation, and branding belong to us and our licensors. These terms give you a limited, non-exclusive, non-transferable right to use the service while you have access under these terms. They do not transfer ownership of the service. The self-hosted edition is licensed separately under AGPL-3.0.</p>
        <p>If you send feedback, you allow us to use it without restriction or payment. We will not identify you publicly as the source without permission.</p>
      </article>
      <article>
        <h2>11. Availability and changes</h2>
        <p>We work to keep InboxJoy available, but we do not promise uninterrupted or error-free service and do not offer an uptime service-level agreement under these terms. Maintenance, provider outages, network failures, security events, or changes by Gmail, Outlook, Composio, Azure, or Dodo Payments may affect the service.</p>
        <p>We may add, change, or remove features and limits. If a change materially reduces the core paid service, we will try to give reasonable notice when practical.</p>
      </article>
      <article>
        <h2>12. Confidentiality</h2>
        <p>Each party may receive non-public information from the other. The receiving party will use it only for the agreement, protect it with reasonable care, and disclose it only to people and providers who need it and are bound to protect it. This does not cover information that is public without breach, already lawfully known, independently developed, or lawfully received from another source.</p>
      </article>
      <article>
        <h2>13. Warranty disclaimer</h2>
        <p>To the fullest extent allowed by law, InboxJoy is provided “as is” and “as available.” We disclaim implied warranties of merchantability, fitness for a particular purpose, title, and non-infringement. We do not warrant deliverability, replies, revenue, legal compliance of your campaigns, accuracy of AI output, or continued access to a third-party provider.</p>
      </article>
      <article>
        <h2>14. Limitation of liability</h2>
        <p>To the fullest extent allowed by law, neither party is liable for indirect, incidental, special, consequential, exemplary, or punitive damages, or for lost profits, revenue, goodwill, or data, even if told those losses were possible.</p>
        <p>To the fullest extent allowed by law, InboxJoy&apos;s total liability arising from or related to the service or these terms will not exceed the fees you paid to InboxJoy during the 12 months before the event giving rise to the claim. These limits do not apply where applicable law does not allow them.</p>
      </article>
      <article>
        <h2>15. Indemnity</h2>
        <p>You will defend and indemnify InboxJoy, its officers, employees, and contractors against third-party claims, damages, penalties, and reasonable costs arising from your contact data, message content, campaigns, violation of law, violation of these terms, or infringement of another person&apos;s rights. You do not have to indemnify us to the extent a claim was caused by our own breach, gross negligence, or willful misconduct.</p>
      </article>
      <article>
        <h2>16. Suspension and termination</h2>
        <p>You may stop using InboxJoy at any time. Stopping does not delete the workspace. We may suspend or terminate access for material breach, nonpayment, abuse, legal risk, security risk, or conduct that harms recipients or providers.</p>
        <p>Before deleting a workspace, export any data you need. The owner&apos;s workspace deletion control permanently removes live workspace-owned contacts, campaigns, inbox references, keys, and billing records. Limited account, billing, fraud, dispute, suppression, or security records may be retained where the Privacy Policy or law permits. Backup copies expire through the normal backup cycle.</p>
        <p>Sections that by their nature should continue after termination remain in effect, including ownership, disclaimers, liability limits, indemnity, and governing law.</p>
      </article>
      <article>
        <h2>17. Governing law and disputes</h2>
        <p>These terms are governed by applicable law. Mandatory consumer rights in your country of residence are unaffected. Before filing a claim, raise the dispute with us at <a href="mailto:hey@inboxjoy.online">hey@inboxjoy.online</a> and give us a reasonable chance to resolve it informally.</p>
      </article>
      <article>
        <h2>18. Changes and general terms</h2>
        <p>We may update these terms. We will change the “Last updated” date and provide reasonable notice of material changes. Unless we say otherwise, changes take effect when posted. If you do not agree, stop using the service before the change takes effect.</p>
        <p>You may not assign this agreement without our consent. We may assign it as part of a merger, financing, reorganization, or sale of the service. If one term is unenforceable, the rest remain effective. A delay in enforcement is not a waiver. These terms and the Privacy Policy are the entire agreement about the service unless you and InboxJoy sign a separate written agreement.</p>
      </article>
      <article>
        <h2>19. Contact</h2>
        <p>Questions about these terms can be sent to <a href="mailto:hey@inboxjoy.online">hey@inboxjoy.online</a>.</p>
      </article>
    </section>

    <footer className="v2-footer"><span><img alt="" className="v2-logo-mark" height={18} src="/brand/icon-64x64.png" width={18} />© 2026 InboxJoy</span><span><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link></span></footer>
  </main>;
}
