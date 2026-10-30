import type { Metadata } from "next";
import Link from "next/link";
import { Check, Mail } from "lucide-react";
import { FeatureIcon } from "@/components/feature-icon";
import { GithubNavLink } from "@/components/github-mark";
import { Logo } from "@/components/logo";
import { NavAuthLink } from "@/components/nav-auth-link";
import { Reveal } from "@/components/reveal";
import { StickyNav } from "@/components/sticky-nav";
import { AnnouncementBanner } from "@/components/announcement-banner";
import { GuideCallout } from "@/components/guide-callout";
import { HeroVideo } from "@/components/hero-video";
import { FinalCta, HeroCta, HeroGithubPill, SiteFooter } from "@/app/_pages/site";
import { PRIMARY_CTA_HREF, PRIMARY_CTA_LABEL } from "@/lib/site-links";
import { PlanCards } from "@/app/_pages/plan-cards";
import { faqPageJsonLd, JsonLd } from "@/app/_pages/seo";

export const metadata: Metadata = {
  title: { absolute: "Cold Email Software & Inbox Rotation | InboxJoy" },
  description:
    "Cold email software with automatic inbox rotation and bounce intelligence — unlimited mailboxes, protected email deliverability, one flat price.",
};

const gmailIcon = "/brand/gmail.svg";
const outlookIcon = "/brand/outlook.svg";

const simpleFeatures = [
  { icon: "window" as const, title: "Controlled sending", body: "Set daily caps, hourly limits, timezones, and sending windows." },
  { icon: "limits" as const, title: "Automatic warm-up", body: "New inboxes start safely and ramp up over time." },
  { icon: "reply" as const, title: "Auto-stop on reply", body: "The sequence stops as soon as a contact replies." },
  { icon: "import" as const, title: "Clean CSV imports", body: "Map fields and skip duplicates or suppressed contacts." },
  { icon: "chart" as const, title: "Honest analytics", body: "Opens, replies, and bounces per step — with bot and prefetch opens filtered out so your numbers stay real." },
];



const steps = [
  { num: "01", icon: "mailbox" as const, title: "Connect your email", body: "One click to link Gmail or Outlook. Emails send from your real address — no new domain, no DNS setup.", hint: "Gmail · Outlook" },
  { num: "02", icon: "import" as const, title: "Upload your contacts", body: "Drop in a CSV, map the columns, and InboxJoy skips anyone suppressed, bounced, or already enrolled.", hint: "CSV · auto-mapped" },
  { num: "03", icon: "draft" as const, title: "Launch your sequence", body: "AI drafts the steps, you approve them, and follow-ups run until someone replies. Unlimited sequences included.", hint: "AI-drafted · stops on reply" },
];

const audiences = [
  { image: "/people/founder-outreach.jpg", title: "Founders", body: "Send your own outbound without hiring an SDR or learning a heavyweight sales platform.", line: "Your first 100 conversations" },
  { image: "/people/sales-team-outreach.jpg", title: "Small sales teams", body: "Run campaigns from your real inboxes with limits that keep your domain healthy.", line: "Two to ten people, no ops" },
  { image: "/people/agency-outreach.jpg", title: "Agencies & consultants", body: "Pitch new clients from a connected mailbox and let replies stop the follow-ups for you.", line: "New business on autopilot" },
];

const comparisonRows = [
  ["Manage from Claude & ChatGPT (MCP)", "Built in", "No", "No"],
  ["Price for one sender", "$79 once (lifetime), or free to self-host", "$29/user/mo", "$47/mo"],
  ["AI writes the whole sequence", "Included", "Included", "Included"],
  ["Inbox warm-up ramp", "Automatic on connect", "Add-on", "Included"],
  ["Inbox rotation", "Automatic, warm-up aware", "No", "Included"],
  ["Sends from your real inbox", "Gmail / Outlook, one click", "Gmail / Outlook", "Dedicated domains recommended"],
  ["Per-mailbox daily & hourly caps", "You set them", "You set them", "Managed for you"],
  ["Sending windows & timezone", "Per mailbox", "Per campaign", "Per campaign"],
  ["Replies stop follow-ups", "Automatic", "Automatic", "Automatic"],
  ["Suppression list enforced at send", "Every send", "Yes", "Yes"],
  ["Setup before first send", "Connect and go", "Guided onboarding", "Domain + DNS setup"],
];

const productTourJsonLd = {
  "@context": "https://schema.org",
  "@type": "VideoObject",
  name: "InboxJoy product tour",
  description: "A 90-second walkthrough of InboxJoy: connect Gmail or Outlook, import leads, launch AI-drafted sequences, and track replies with automatic inbox rotation and warm-up.",
  thumbnailUrl: "https://inboxjoy.online/videos/demo-tour-poster.jpg",
  contentUrl: "https://inboxjoy.online/videos/demo-tour.mp4",
  uploadDate: "2026-09-17",
  duration: "PT1M32S",
};

const faqs = [
  ["Can I use InboxJoy from Claude or ChatGPT?", "Yes. InboxJoy is a remote MCP server: add https://inboxjoy.online/mcp as a connector in Claude or ChatGPT, approve access once, and you can import leads, launch campaigns, and pull reports straight from the chat."],
  ["Will InboxJoy send too much too quickly?", "InboxJoy uses per-mailbox daily and hourly limits, a warm-up ramp for connected inboxes, and the sending windows you configure before campaigns run."],
  ["Do I approve emails before they send?", "Yes. You can review the AI-drafted sequence, edit the steps, preview merge-tag personalization for a contact, and approve the campaign before enrollment."],
  ["What does it work with?", "Gmail, Google Workspace, and Outlook inboxes. You can also upload a spreadsheet to import contacts."],
  ["How much does it cost?", "Two ways to run InboxJoy, same features in both. Self-host it free: it is open source (AGPL-3.0), and you run it on your own server with your own SMTP/IMAP or Composio key and AI key. Or let us host it: the managed lifetime license is $79, paid once, with no subscription or renewals. It includes one-click Gmail and Outlook connection, AI drafting, updates and backups, unlimited team seats, email support, and a 30-day money-back guarantee."],
] as const;

export default function Home() {
  return <main className="v2-page">
    <AnnouncementBanner />
    <StickyNav />
    <GuideCallout source="home" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link href="https://fonts.googleapis.com/css2?family=Google+Sans+Flex:wght@400..800&display=swap" rel="stylesheet" />
    <section className="v2-hero-panel">
      <div className="v2-stripes" />
      <div className="v2-hero-glow" />
      <nav className="v2-nav" aria-label="Primary navigation">
        <Logo className="v2-brand" href="/" variant="white" />
        <div className="v2-nav-links"><a href="#features">Features</a><a href="#how-it-works">How it works</a><Link href="/pricing">Pricing</Link><Link href="/blog/">Blog</Link><a href="#questions">FAQs</a><NavAuthLink /></div>
        <div className="v2-nav-end"><GithubNavLink /><Link className="v2-nav-cta" href={PRIMARY_CTA_HREF}>{PRIMARY_CTA_LABEL}</Link></div>
        <details className="v2-nav-menu"><summary aria-label="Open menu"><span /><span /><span /></summary><div className="v2-nav-menu-panel"><a href="#features">Features</a><a href="#how-it-works">How it works</a><Link href="/pricing">Pricing</Link><Link href="/blog/">Blog</Link><a href="#questions">FAQs</a><GithubNavLink variant="menu" /><NavAuthLink /><Link href={PRIMARY_CTA_HREF}>{PRIMARY_CTA_LABEL}</Link></div></details>
      </nav>
      <div className="v2-hero-content">
        <div className="v2-hero-badges">
          <HeroGithubPill />
          <div className="v2-kicker v2-kicker--agents"><span>Works with Claude &amp; ChatGPT</span><i /><img src="/brand/claude-white.svg" alt="Claude" /><img src="/brand/openai-white.svg" alt="ChatGPT" /></div>
        </div>
        <h1><span className="v2-hero-underlined">Stupidly Simple<svg aria-hidden="true" viewBox="0 0 300 24" preserveAspectRatio="none"><path d="M7 12 C58 5, 112 17, 158 11 S248 5, 293 12" /></svg></span>{" "}Email Outreach</h1>
        <p className="v2-hero-copy">Cold email automation with unlimited mailboxes, automatic inbox rotation, and bounce intelligence that pauses bouncing inboxes before they hurt your email deliverability.</p>
        <HeroCta note="$79 once, we host it · or self-host free, open source · 30-day money-back guarantee" />
        <div className="v2-connection-stack">
          <div className="v2-connections"><span>Connects in one click with</span><b><img src={gmailIcon} alt="Gmail" />Gmail</b><i /><b><img src={outlookIcon} alt="Outlook" />Outlook</b></div>
        </div>
        <div className="v2-hero-video-wrap">
          <div className="v2-video"><HeroVideo src="/videos/demo-tour.mp4" poster="/videos/demo-tour-poster.jpg" title="InboxJoy product tour" /></div>
        </div>
      </div>
    </section>

    <Reveal className="v2-section v2-showcase-pair">
      <article className="v2-showcase-card">
        <div className="v2-showcase-copy">
          <header className="v2-section-heading"><h2>Cold email outreach<br />at scale</h2><p>Enroll a whole list and let InboxJoy handle the pacing. Caps, windows, and warm-up are enforced on every send — and a reply stops that thread instantly.</p></header>
          <ul className="v2-showcase-list">
            <li><i><Check aria-hidden="true" size={11} strokeWidth={3} /></i>Bulk-enroll thousands of contacts from a list or CSV</li>
            <li><i><Check aria-hidden="true" size={11} strokeWidth={3} /></i>Daily caps, sending windows, and warm-up applied automatically</li>
            <li><i><Check aria-hidden="true" size={11} strokeWidth={3} /></i>Replies and bounces stop follow-ups on their own</li>
          </ul>
        </div>
        <div className="v2-showcase-media"><video autoPlay muted loop playsInline preload="metadata" poster="/videos/outreach-poster.jpg"><source src="/videos/outreach.mp4" type="video/mp4" /></video></div>
      </article>
      <article className="v2-showcase-card v2-showcase-card--flip">
        <div className="v2-showcase-copy">
          <header className="v2-section-heading"><h2>Unlimited mailboxes,<br />automatic inbox rotation</h2><p>Connect every inbox you own and InboxJoy spreads sends across them by capacity — each contact keeps the same sender for every follow-up.</p></header>
          <ul className="v2-showcase-list">
            <li><i><Check aria-hidden="true" size={11} strokeWidth={3} /></i>Unlimited Gmail and Outlook inboxes at one flat price</li>
            <li><i><Check aria-hidden="true" size={11} strokeWidth={3} /></i>Capacity-weighted rotation across healthy inboxes</li>
            <li><i><Check aria-hidden="true" size={11} strokeWidth={3} /></i>Sticky senders — every follow-up comes from the same address</li>
          </ul>
        </div>
        <div className="v2-showcase-media"><video autoPlay muted loop playsInline preload="metadata" poster="/videos/rotation-poster.jpg"><source src="/videos/rotation.mp4" type="video/mp4" /></video></div>
      </article>
    </Reveal>

    <Reveal className="v2-section v4-outreach-section" id="features">
      <div className="v4-outreach-copy"><header className="v2-section-heading"><h2>Powerful deliverability features,<br />simple UI</h2><p>Everything you need to launch, control, and improve your outreach.</p></header><div className="v4-feature-list">{simpleFeatures.map((feature) => <article key={feature.title}><FeatureIcon name={feature.icon} /><div><h3>{feature.title}</h3><p>{feature.body}</p></div></article>)}</div></div>
    </Reveal>

    <Reveal className="v2-mcp-section" id="agents">
      <div className="v2-mcp-inner">
        <div className="v2-stripes" />
        <div className="v2-mcp-chat">
          <div className="v2-mcp-msg v2-mcp-msg--user">Import my new Apollo leads and launch the Q4 founders sequence.</div>
          <div className="v2-mcp-msg v2-mcp-msg--agent">
            <span className="v2-mcp-tool">✓ leads.import — 214 imported, 3 suppressed skipped</span>
            <span className="v2-mcp-tool">✓ sequences.launch — 214 enrolled across 2 inboxes</span>
            <p>Done — Q4 founders is live. First sends go out in your 9am–5pm window. Want the reply report on Friday?</p>
          </div>
          <div className="v2-mcp-msg v2-mcp-msg--user">Yes, and pause it if bounce rate passes 2%.</div>
        </div>
        <div className="v2-mcp-copy">
          <span className="v2-ai-badge"><img src="/brand/claude-white.svg" alt="" /><img src="/brand/openai-white.svg" alt="" /> Works with AI agents</span>
          <h2>Run your outreach<br />from Claude or ChatGPT</h2>
          <p>InboxJoy is a remote MCP server. Paste one URL into Claude or ChatGPT, approve access once, and your agent can import leads, launch campaigns, and pull reports — no tab-switching.</p>
          <ul>
            <li><i>1</i>Add <code>inboxjoy.online/mcp</code> as a connector</li>
            <li><i>2</i>Approve access to your workspace — scoped, revocable anytime</li>
            <li><i>3</i>Ask for anything: import, launch, pause, report</li>
          </ul>
          <Link className="v2-mcp-cta" href={PRIMARY_CTA_HREF}>{PRIMARY_CTA_LABEL}</Link>
        </div>
      </div>
    </Reveal>

    <Reveal className="v2-section v4-steps-section" id="how-it-works"><header className="v2-section-heading"><h2>Three steps to your<br />first campaign</h2><p>Connect, upload, launch. Most people send their first sequence the same day.</p></header><div className="v2-flow">{steps.map((step) => <article className="v2-flow-card" key={step.num}><span className="v2-flow-num">{step.num}</span><FeatureIcon name={step.icon} /><h3>{step.title}</h3><p>{step.body}</p><footer>{step.num === "01" ? <span className="v4-provider-icons"><img src={gmailIcon} alt="Gmail" /><img src={outlookIcon} alt="Outlook" /><span><Mail aria-hidden="true" size={16} /></span></span> : step.hint}</footer></article>)}</div></Reveal>

    <Reveal className="v2-section" id="who-its-for"><header className="v2-section-heading"><h2>Who it&apos;s for</h2><p>Built for people who send outbound themselves, not for teams with a sales ops department.</p></header><div className="v2-audience">{audiences.map((audience) => <article className="v2-audience-card" key={audience.title}><div className="v2-audience-media"><img src={audience.image} alt="" /><span>{audience.line}</span></div><div className="v2-audience-body"><h3>{audience.title}</h3><p>{audience.body}</p></div></article>)}</div></Reveal>

    <Reveal className="v2-section"><figure className="mkt-quote"><blockquote>&ldquo;The easiest email sequence tool, went from plan to campaign launch in 10 minutes.&rdquo;</blockquote><figcaption><img className="mkt-quote-photo" src="/people/vamshi.jpg" alt="Vamshi Velmajala" width={42} height={42} /><span><b>Vamshi Velmajala</b><small>CEO, Snapsight</small></span></figcaption></figure></Reveal>

    <Reveal className="v2-section v2-comparison"><header className="v2-section-heading"><h2>All cold email software essentials,<br />one flat price</h2><p>AI writing, inbox controls, warm-up, and unlimited sequences—without a complicated plan.</p></header><div className="v2-compare-table"><div className="v2-compare-row v2-compare-head"><span>Area</span><span><b><img alt="" className="v2-logo-mark" height={18} src="/brand/icon-64x64.png" width={18} />InboxJoy</b></span><span>Mailshake</span><span>Instantly</span></div>{comparisonRows.map((row) => <div className="v2-compare-row" key={row[0]}>{row.map((cell, index) => <span key={`${row[0]}-${index}`} className={index === 1 ? "v2-compare-us" : ""}>{cell}</span>)}</div>)}<div className="v2-compare-row v2-compare-footer"><span>Competitor details from their public pricing pages; verify before relying on them.</span><span><Link href={PRIMARY_CTA_HREF}>{PRIMARY_CTA_LABEL}</Link></span><span /><span /></div></div></Reveal>

    <Reveal className="v2-section" id="pricing"><header className="v2-section-heading"><h2>Simple pricing</h2><p>Self-host it free, or pay $79 once and we run it for you.</p></header><PlanCards /></Reveal>

    <JsonLd data={[faqPageJsonLd(faqs), productTourJsonLd]} />
    <section className="v2-faq pages-faq" id="questions"><h2>Common questions</h2><div>{faqs.map(([question, answer], index) => <details key={question} open={index === 0}><summary><b>{question}</b><span aria-hidden="true">+</span></summary><p>{answer}</p></details>)}</div></section>

    <FinalCta title="Send your first campaign today" description="Get the $79 lifetime license and we run it for you, or self-host it free on your own server." />
    {/* Hidden directory backlink (TinyHunt). Present for crawlers, not shown. */}
    <a hidden aria-hidden="true" href="https://tinyhunt.dev/projects/inboxjoy?utm_source=badge" target="_blank" rel="noopener noreferrer"><img src="https://r2.direasy-multi-tenant.focusapps.app/uploads/616d0b1a-3979-4b8c-94d1-b4f1fedd3ead/1783232956807/nynif7cioz/featured-on-light.svg" alt="Featured on TinyHunt" width={130} height={44} /></a>
    {/* Hidden directory backlink (Nick Launches). Present for crawlers, not shown. */}
    <a hidden aria-hidden="true" href="https://nicklaunches.com/products/inboxjoy/?utm_source=inboxjoy.online&amp;utm_medium=badge&amp;utm_campaign=featured" target="_blank" rel="noopener noreferrer"><img src="https://nicklaunches.com/badges/featured.png" alt="InboxJoy on Nick Launches" width={244} height={56} /></a>
    <SiteFooter />
  </main>;
}
