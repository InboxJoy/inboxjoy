import type { Metadata } from "next";
import { FinalCta, MarketingPage, PageHero, RouteCard, SiteFooter } from "../_pages/site";
import { Breadcrumbs } from "../_pages/seo";
import "../pages.css";

const title = "InboxJoy Alternatives | Compare Email Sequence Tools";
const description =
  "Compare InboxJoy with Instantly, Smartlead, Lemlist, Apollo, Woodpecker, and Mailshake: pricing, rotation, bounce protection, and honest fit.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: "/alternatives" },
};

export default function AlternativesPage() {
  return (
    <MarketingPage>
      <PageHero kicker="InboxJoy alternatives" title={<>Choose the workflow<br />that fits your outbound.</>} description="A fair comparison starts with what you actually need: a focused email sequence tool, a larger sales-engagement stack, or infrastructure for broader outbound operations.">
        <div className="pages-hero-links"><a href="#comparisons">See comparisons</a><a href="/pricing">View InboxJoy pricing</a></div>
      </PageHero>

      <Breadcrumbs crumbs={[["Home", "/"], ["Alternatives", "/alternatives"]]} />

      <section className="v2-section" id="comparisons">
        <header className="v2-section-heading"><h2>Compare before you commit</h2><p>Real numbers for InboxJoy, flagged wherever competitor plans change.</p></header>
        <div className="pages-card-grid">
          <RouteCard href="/alternatives/mailshake" label="Comparison" title="InboxJoy vs Mailshake" description="Compare a focused Gmail and Outlook sequence workflow with a per-user sales engagement option." cta="Read the comparison" />
          <RouteCard href="/alternatives/instantly" label="Comparison" title="InboxJoy vs Instantly" description="Compare InboxJoy's simple mailbox controls with a platform aimed at broader outbound operations." cta="Read the comparison" />
          <RouteCard href="/alternatives/smartlead" label="Comparison" title="InboxJoy vs Smartlead" description="Both rotate across unlimited mailboxes. See how bounce protection, setup, and pricing compare." cta="Read the comparison" />
          <RouteCard href="/alternatives/lemlist" label="Comparison" title="InboxJoy vs Lemlist" description="Weigh a focused email engine with automatic mailbox protection against a multichannel outreach suite." cta="Read the comparison" />
          <RouteCard href="/alternatives/apollo" label="Comparison" title="InboxJoy vs Apollo" description="Pair Apollo's contact data with a dedicated sending engine, or run everything in one platform." cta="Read the comparison" />
          <RouteCard href="/alternatives/woodpecker" label="Comparison" title="InboxJoy vs Woodpecker" description="Compare two deliverability-minded cold email tools on rotation, bounce handling, and price." cta="Read the comparison" />
        </div>
      </section>

      <section className="v2-section">
        <header className="v2-section-heading"><h2>What InboxJoy is built for</h2><p>A straightforward path from a real inbox to a reviewed, controlled email sequence.</p></header>
        <div className="pages-card-grid">
          <article className="pages-info-card"><span>01</span><h3>Fast setup</h3><p>Connect Gmail or Outlook in one click, import contacts from CSV, and use AI to draft a sequence.</p></article>
          <article className="pages-info-card"><span>02</span><h3>Practical controls</h3><p>Set daily and hourly caps and sending windows for each mailbox, with a warm-up ramp starting at 8 sends per day or skipped for warmed inboxes.</p></article>
          <article className="pages-info-card"><span>03</span><h3>Focused automation</h3><p>Use AI-drafted steps and merge tags, then let detected replies stop follow-ups automatically.</p></article>
        </div>
      </section>

      <FinalCta title="Prefer the simpler path?" description="Self-host it free or get the lifetime license, and decide from the actual workflow." />
      <SiteFooter />
    </MarketingPage>
  );
}
