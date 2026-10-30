import type { Metadata } from "next";
import { FinalCta, MarketingPage, PageHero, RouteCard, SiteFooter } from "../_pages/site";
import { Breadcrumbs } from "../_pages/seo";
import "../pages.css";

const title = "InboxJoy Use Cases | Founders, Sales Teams, and Agencies";
const description =
  "See how founders, small sales teams, and agencies use InboxJoy to draft, control, send, and measure email follow-up sequences.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: "/use-cases" },
};

export default function UseCasesPage() {
  return (
    <MarketingPage>
      <PageHero kicker="Built around the sender" title={<>Outbound workflows<br />for lean teams.</>} description="InboxJoy gives people who send their own cold outreach a focused way to connect an inbox, import contacts, draft follow-ups, control delivery, and act on replies.">
        <div className="pages-hero-links"><a href="#audiences">Find your use case</a><a href="/pricing">See pricing</a></div>
      </PageHero>

      <Breadcrumbs crumbs={[["Home", "/"], ["Use cases", "/use-cases"]]} />

      <section className="v2-section" id="audiences">
        <header className="v2-section-heading"><h2>Different teams, different jobs</h2><p>Each guide focuses on the real constraints that audience faces.</p></header>
        <div className="pages-route-grid">
          <RouteCard href="/use-cases/founders" label="Use case" title="For founders" description="Turn founder-led insight into concise outreach without becoming a full-time sales operator." cta="Explore founder outreach" />
          <RouteCard href="/use-cases/sales-teams" label="Use case" title="For small sales teams" description="Give each connected mailbox clear sending limits and a repeatable follow-up rhythm." cta="Explore team outreach" />
          <RouteCard href="/use-cases/agencies" label="Use case" title="For agencies" description="Keep new-business follow-up moving while delivery work still takes most of the week." cta="Explore agency outreach" />
        </div>
      </section>

      <section className="v2-section" id="industries">
        <header className="v2-section-heading"><h2>Cold email playbooks by industry</h2><p>Sequence angles, sample subject lines, and setup steps written for how each industry actually sells.</p></header>
        <div className="pages-card-grid pages-card-grid--two">
          <RouteCard href="/use-cases/saas" label="Industry" title="Cold email for SaaS" description="Trial activation, competitor-switch timing, and expansion outreach from rotating mailboxes." cta="Explore SaaS outreach" />
          <RouteCard href="/use-cases/recruiting" label="Industry" title="Cold email for recruiters" description="Passive-candidate openers and hiring-manager business development with protected sender domains." cta="Explore recruiting outreach" />
          <RouteCard href="/use-cases/consulting" label="Industry" title="Cold email for consultants" description="Expertise-led outreach built on trigger events, insight offers, and patient follow-up." cta="Explore consulting outreach" />
          <RouteCard href="/use-cases/real-estate" label="Industry" title="Real estate cold email" description="Commercial, investor, and partner outreach timed around leases, deals, and portfolio moves." cta="Explore real estate outreach" />
        </div>
      </section>

      <section className="v2-section">
        <header className="v2-section-heading"><h2>The shared foundation</h2><p>Every use case runs on the same verified InboxJoy features.</p></header>
        <div className="pages-usecase-band">
          <article><b>Prepare</b><h3>Connect and import</h3><p>Link Gmail or Outlook in one click, then bring in contacts from a CSV.</p></article>
          <article><b>Compose</b><h3>Draft and personalize</h3><p>Use AI-drafted sequences with first name, company, and title merge tags.</p></article>
          <article><b>Control</b><h3>Send and learn</h3><p>Set mailbox caps and windows, stop on reply, and review per-step analytics and opens.</p></article>
        </div>
      </section>

      <FinalCta title="Build the workflow around your inbox" description="Get the lifetime license, or self-host free, and see how InboxJoy fits the way you already sell." />
      <SiteFooter />
    </MarketingPage>
  );
}
