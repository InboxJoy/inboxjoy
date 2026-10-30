import type { Metadata } from "next";
import Link from "next/link";
import { PlanCards } from "../_pages/plan-cards";
import { CheckList, FaqSection, HeroCta, MarketingPage, PageHero, SectionHeading, SiteFooter } from "../_pages/site";
import { CheckoutCancelledNotice } from "./checkout-cancelled-notice";
import { GuideCallout } from "@/components/guide-callout";
import { PRIMARY_CTA_HREF, PRIMARY_CTA_LABEL } from "@/lib/site-links";
import "../pages.css";

const title = "Cold Email Software Pricing | InboxJoy";
const description =
  "Cold email software pricing: self-host InboxJoy free (open source, AGPL-3.0), or let us run it for a $79 lifetime license paid once. No subscription, no renewals.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: "/pricing" },
};

const faqs = [
  ["Is there a free option?", "Yes: self-host. InboxJoy is open source (AGPL-3.0). Run it on your own server, connect your own SMTP/IMAP mailboxes or Composio key, and add your own AI key. You get every feature with no send limits, and community support on GitHub. There is no free hosted plan."],
  ["What happened to the Free plan?", "We retired the hosted Free plan. Workspaces already on Free keep it for 30 days after the change, and we email the owner before it ends. After that, choose managed (the $79 lifetime license) or self-host for free."],
  ["Is it really open source?", "Yes. The app is released under AGPL-3.0, so anyone can run it, read it, and change it. If you offer a modified version to others as a hosted service, you have to publish your changes. The InboxJoy name and logo are trademarks and are not part of the license, so a fork needs its own name."],
  ["Can I move between self-host and managed?", "Yes. Both run the same code, so you can export a workspace from one and import it into the other, in either direction."],
  ["What does the managed lifetime license cost?", "$79, paid once. There is no subscription and nothing renews, so you are never charged again for it."],
  ["What does \"lifetime\" mean?", "Your workspace keeps managed access, with unlimited sends and no footer, for as long as InboxJoy runs the managed service. The license belongs to the workspace you buy it for. The code is open source, so you can always export your workspace and run it yourself."],
  ["Can I try managed before I pay?", "You can create an account, set up your workspace and launch a campaign before you buy. Campaign emails start sending once you have the license. If it is not right for you, the 30-day money-back guarantee covers it."],
  ["Do you offer refunds?", "Yes. Ask for a full refund within 30 days of buying, no reason needed. Email hey@inboxjoy.online and we'll process it. A refund ends the managed license; nothing is deleted, but campaigns stop sending until you buy again. You can also export your workspace and self-host it."],
  ["Is AI drafting included?", "On managed, yes, with fair-use limits. When you self-host, add your own OpenAI-compatible key; AI is optional."],
  ["What counts toward my send caps?", "Every outbound email from a connected mailbox — first sends and follow-up steps both count against that mailbox's daily and hourly limit."],
  ["How does the warm-up ramp behave?", "A newly connected mailbox starts at 8 sends a day and increases roughly 15% each day until it reaches your configured cap — usually two to three weeks to full speed."],
  ["Which inboxes can I connect?", "Gmail, Google Workspace, and Outlook. On managed, connect any of them in one click — no new domain or DNS setup required. When you self-host, connect them with an app password over SMTP/IMAP, or with your own Composio key."],
  ["Are team seats included?", "Yes. Self-host and managed both include unlimited team members at no extra cost — invite your whole team."],
  ["Can I run InboxJoy from Claude or ChatGPT?", "Yes. InboxJoy is a remote MCP server — paste one URL into Claude or ChatGPT, approve access, and import leads, launch campaigns, or pull reports straight from the chat. On managed the URL is inboxjoy.online/mcp; self-hosted installs serve it from your own domain."],
] as const;

const comparison = [
  ["Price", "Free, open source (AGPL-3.0)", "$79 once, lifetime"],
  ["Who runs it", "You, on your own server", "We do, on inboxjoy.online"],
  ["Gmail and Outlook", "SMTP/IMAP app passwords, or your own Composio key", "One-click connect"],
  ["AI drafting", "Bring your own key", "Included, with fair-use limits"],
  ["Updates, backups, uptime", "Your job", "Ours"],
  ["MCP for Claude and ChatGPT", "Yes, on your own domain", "Yes, at inboxjoy.online/mcp"],
  ["Send limits", "None", "None"],
  ["Support", "Community, on GitHub", "Email"],
] as const;

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: faqs.map(([question, answer]) => ({
    "@type": "Question",
    name: question,
    acceptedAnswer: {
      "@type": "Answer",
      text: answer,
    },
  })),
};

const softwareApplicationJsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "InboxJoy",
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web",
  url: "https://inboxjoy.online/pricing",
  description,
  publisher: { "@id": "https://inboxjoy.online/#organization" },
  offers: [
    {
      "@type": "Offer",
      name: "Self-host (open source, AGPL-3.0)",
      price: "0",
      priceCurrency: "USD",
    },
    {
      "@type": "Offer",
      name: "Managed lifetime license",
      price: "79",
      priceCurrency: "USD",
    },
  ],
};

export default function PricingPage() {
  return (
    <MarketingPage className="pages-pricing-page">
      <GuideCallout source="pricing" />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareApplicationJsonLd) }}
      />
      <PageHero kicker="Simple, transparent pricing" title={<>Same Product,<br />Two Ways to Run It.</>} description="Every feature in both, unlimited team members, no add-ons. Self-host it free on your own server, or pay $79 once and we run it for you. No subscription, no renewals.">
        <HeroCta note="Free and open source (AGPL-3.0) to self-host · $79 once for managed lifetime · 30-day money-back guarantee" />
      </PageHero>

      <section className="v2-section pricing-section" id="plans" aria-label="Pricing plans and included features">
        <div className="pricing-shell">
          <CheckoutCancelledNotice />
          <PlanCards />
        </div>
      </section>

      <section className="v2-section" aria-label="What's included in both options">
        <SectionHeading eyebrow="Everything, both ways" title="What's included in both" description="Self-host and managed ship the exact same product — whether you're sending from a single Gmail inbox or coordinating a small team across a dozen connected mailboxes, you get the full toolkit below on day one. There is no feature-gated tier to upgrade into later." />
        <div className="pages-card-grid">
          <article className="pages-info-card"><span>01</span><h3>Connect in one click</h3><p>On managed, link Gmail, Google Workspace, or Outlook with OAuth — no DNS records, no dedicated sending domain, and no IT ticket required. Self-hosting connects the same mailboxes over SMTP/IMAP or with your own Composio key.</p></article>
          <article className="pages-info-card"><span>02</span><h3>Clean CSV import</h3><p>Upload a spreadsheet and InboxJoy maps the columns, then skips duplicates and suppressed or already-enrolled contacts automatically.</p></article>
          <article className="pages-info-card"><span>03</span><h3>AI drafts + merge tags</h3><p>Describe the campaign and AI writes the full sequence using <code>{"{{firstName}}"}</code>, <code>{"{{company}}"}</code>, and <code>{"{{title}}"}</code> merge tags, ready for you to edit.</p></article>
          <article className="pages-info-card"><span>04</span><h3>Sending windows & caps</h3><p>Set a sending window per mailbox plus a daily and hourly send cap, so outreach only goes out inside the hours you choose.</p></article>
          <article className="pages-info-card"><span>05</span><h3>Automatic warm-up ramp</h3><p>New mailboxes start at 8 sends a day and increase roughly 15% daily until they reach your configured cap — skip it for inboxes that are already warm.</p></article>
          <article className="pages-info-card"><span>06</span><h3>Reply auto-stop</h3><p>The moment a contact replies, InboxJoy cancels their remaining follow-up steps automatically — no manual cleanup after the fact.</p></article>
          <article className="pages-info-card"><span>07</span><h3>Per-step analytics</h3><p>See opens, replies, bounces, and unsubscribe rate broken down by sequence step, with bot and prefetch opens filtered out so the numbers stay honest.</p></article>
          <article className="pages-info-card"><span>08</span><h3>MCP server for AI agents</h3><p>Add <code>inboxjoy.online/mcp</code> as a connector in Claude or ChatGPT and import leads, launch campaigns, or pull reports straight from the chat.</p></article>
          <article className="pages-info-card"><span>09</span><h3>Unlimited team seats</h3><p>Invite your whole team at no extra cost — seats are never metered, capped, or billed per user.</p></article>
        </div>
      </section>

      <section className="v2-section" aria-label="How InboxJoy pricing compares">
        <SectionHeading eyebrow="Pricing model" title="How InboxJoy pricing compares" description="Cold email tools commonly price per sending seat or move warm-up, extra mailboxes, and reporting behind add-ons — so the sticker price is rarely the final bill." />
        <div className="pages-split">
          <div className="pages-split-copy">
            <div className="v2-stripes" />
            <h3>One flat price for the whole team</h3>
            <p>InboxJoy charges one flat price for the account, no matter how many mailboxes or teammates you add. Connect as many Gmail, Google Workspace, or Outlook inboxes as you have and invite everyone who needs access.</p>
            <CheckList items={["No per-mailbox fees — connect as many inboxes as you want", "No per-seat charges — invite your whole team at no extra cost", "No warm-up add-on — the ramp is automatic and included", "No reporting tier lock — per-step analytics in both editions"]} />
          </div>
          <article className="pages-fair-card">
            <span>Why this adds up</span>
            <h3>Per-seat and add-on pricing compounds fast</h3>
            <p>In tools billed per sending seat, adding a third or fourth mailbox or a second teammate to manage campaigns directly raises the monthly bill. Warm-up, higher send limits, or deeper analytics are often a separate line item on top of that.</p>
            <p>With InboxJoy, none of that changes your price. Self-host it for free, or pay $79 once for the managed lifetime license, whether you're running one inbox or ten, alone or with a full team.</p>
            <p>That predictability is the point: there is no monthly bill to budget for, and the number never moves as your sending volume, mailbox count, or headcount grows.</p>
          </article>
        </div>
      </section>

      <section className="v2-section v2-comparison pages-compare-three" aria-label="Self-host and managed compared">
        <SectionHeading eyebrow="Self-host or managed" title="Which one is right for you?" description="Same code, same features. The difference is who runs it. Self-host if you want control and are happy to look after a server. Choose managed if you would rather send than maintain." />
        <div className="v2-compare-table">
          <div className="v2-compare-row v2-compare-head"><span>Area</span><span>Self-host</span><span>Managed</span></div>
          {comparison.map(([area, selfHost, managed]) => (
            <div className="v2-compare-row" key={area}><span>{area}</span><span>{selfHost}</span><span className="v2-compare-us">{managed}</span></div>
          ))}
          <div className="v2-compare-row v2-compare-footer"><span>Every feature is in both. No feature is held back for managed.</span><span className="v2-compare-us"><Link href={PRIMARY_CTA_HREF}>{PRIMARY_CTA_LABEL}</Link></span></div>
        </div>
      </section>

      <section className="v2-section" aria-label="Self-host, lifetime license, and refunds">
        <SectionHeading eyebrow="Billing details" title="Self-host, lifetime license, and refunds" description="The mechanics behind the numbers above, so there are no surprises on your statement — what self-hosting involves, what one payment buys, and what happens if you ask for a refund." />
        <div className="pages-card-grid">
          <article className="pages-info-card"><span>1</span><h3>Self-host for free</h3><p>InboxJoy is open source under AGPL-3.0. Run it on your own server with your own SMTP/IMAP mailboxes or Composio key and your own AI key. Help comes from the community on GitHub.</p></article>
          <article className="pages-info-card"><span>2</span><h3>Pay once, keep it</h3><p>The managed lifetime license is a single $79 payment. We host it and handle updates and backups. There is no subscription, so nothing renews and there is nothing to cancel.</p></article>
          <article className="pages-info-card"><span>3</span><h3>30-day money-back guarantee</h3><p>Ask for a full refund within 30 days of buying, no reason required. Email hey@inboxjoy.online and it's processed without a retention flow. Nothing is deleted, and you can export your workspace to self-host it.</p></article>
        </div>
      </section>

      <FaqSection items={faqs} title="Pricing questions" />
      <SiteFooter />
    </MarketingPage>
  );
}
