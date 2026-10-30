import type { Metadata } from "next";
import Link from "next/link";
import { CheckList, FaqSection, FinalCta, HeroCta, MarketingPage, PageHero, SectionHeading, SiteFooter } from "../../_pages/site";
import { Breadcrumbs, JsonLd, RelatedPages, faqPageJsonLd, webApplicationJsonLd } from "../../_pages/seo";
import "../../pages.css";

const title = "New-Business Email Sequences for Agencies | InboxJoy";
const description =
  "InboxJoy keeps agency cold outreach moving with AI-drafted sequences, CSV import, sending controls, automatic reply stops, and analytics.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: "/use-cases/agencies" },
};

const faqs = [
  [
    "Can we connect a client's mailbox as well as our own?",
    "Yes. InboxJoy connects any Gmail, Google Workspace, or Outlook mailbox in one click — your agency's own inbox or a client's, with no DNS setup required either way, and no engineering time from the client's side.",
  ],
  [
    "How do we warm up a client mailbox before a new campaign?",
    "New or inactive mailboxes start on the automatic warm-up ramp — 8 sends a day, rising about 15% a day until it reaches full pace. Skip it only for a mailbox you know is already sending regularly, so onboarding a fresh client inbox doesn't put their deliverability at risk in week one.",
  ],
  [
    "Can we run separate sequences for different clients or services?",
    "Yes. Each sequence is drafted and personalized on its own, with merge tags like {{firstName}}, {{company}}, and {{title}} keeping every send specific to that list, so client pitches don't blur together even when they're launched the same week.",
  ],
  [
    "How do we report new-business results to a client or partner?",
    "Per-step analytics show opens and performance at each stage of a sequence, and InboxJoy tracks unsubscribe rate per campaign, so a weekly or monthly report can show list health alongside raw send activity.",
  ],
  [
    "What happens when a prospect replies mid-sequence?",
    "InboxJoy stops the remaining scheduled follow-ups automatically the moment a reply comes in, so the conversation becomes personal right away, with no extra automated nudge landing on top of it — important when a partner or client contact is the one who replied.",
  ],
  [
    "Do we need a separate InboxJoy login for every team member?",
    "No extra cost either way — team seats are unlimited, so account managers and new-business leads can all work from the same InboxJoy workspace without the agency paying more as it adds people to the pitch.",
  ],
  [
    "Can we import a fresh prospect list for each engagement?",
    "Yes. Upload a CSV for each list — a client vertical, a partner referral batch, or your own pipeline — and InboxJoy maps it into the sequence you're running, with no manual re-entry between lists.",
  ],
  [
    "What does InboxJoy cost for an agency?",
    "InboxJoy is free to self-host (open source, AGPL-3.0). The managed lifetime license is $79, paid once, and carries a 30-day money-back guarantee.",
  ],
  [
    "Can we manage campaigns from tools we already use day to day?",
    "Yes. InboxJoy runs a remote MCP server, so an account manager can check a campaign's status or analytics from inside Claude or ChatGPT between client calls, with no separate dashboard required.",
  ],
  [
    "Do we need to set specific sending hours for each client mailbox?",
    "Yes, and you should. Sending windows are configurable per mailbox, so a client's outreach can follow their own business hours or time zone.",
  ],
] as const;

export default function AgenciesUseCasePage() {
  return (
    <MarketingPage>
      <PageHero kicker="InboxJoy for agencies" title={<>Keep new business moving<br />between client deadlines.</>} description="Agency cold outreach often stops the moment delivery gets busy. InboxJoy keeps your own prospect follow-up moving from a real Gmail or Outlook inbox while you stay focused on client work.">
        <HeroCta />
      </PageHero>

      <Breadcrumbs crumbs={[["Home", "/"], ["Use cases", "/use-cases"], ["Agencies", "/use-cases/agencies"]]} />
      <JsonLd data={webApplicationJsonLd({ name: "InboxJoy for Agencies", path: "/use-cases/agencies", description })} />

      <section className="v2-section">
        <SectionHeading eyebrow="The agency pattern" title="Pipeline work loses to paid work" description="An agency's own new-business outreach is the easiest thing to drop when client delivery gets loud, and the most expensive thing to rebuild from nothing three months later. The team can describe its value clearly, but outbound becomes inconsistent when active projects demand immediate attention." />
        <div className="pages-card-grid">
          <article className="pages-info-card"><span>01</span><h3>Prospecting happens in sprints</h3><p>A quiet week triggers a burst of outreach, then follow-up disappears as soon as client delivery fills the calendar again, and the pipeline goes cold until the next lull.</p></article>
          <article className="pages-info-card"><span>02</span><h3>Every pitch starts over</h3><p>The core offer is stable, but subject lines, openers, and asks get rewritten from scratch for each new list.</p></article>
          <article className="pages-info-card"><span>03</span><h3>Replies need a clean handoff</h3><p>Once a prospect responds, automated nudges must stop so the conversation can become personal immediately, without a stray follow-up landing in the same thread and undercutting the account lead.</p></article>
        </div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Feature fit" title="Build a dependable new-business loop" description="Use repeatable sequence mechanics without pretending every prospect should receive the same pitch." />
        <div className="pages-split">
          <div className="pages-split-copy"><div className="v2-stripes" /><h3>Start from a reusable structure</h3><p>AI drafts the sequence framework, while merge tags make room for the person, company, and role details that give an agency pitch context — so the same structure still reads as researched for each client.</p><CheckList items={["Import a curated prospect list from CSV", "Draft with {{firstName}}, {{company}}, and {{title}}", "Carry the same positioning through each sequence step", "Use per-step analytics and open tracking to refine the next pass"]} /></div>
          <article className="pages-fair-card"><span>Stay responsive</span><h3>Automate persistence. Protect the relationship.</h3><p>Daily and hourly caps and defined sending windows keep the mailbox cadence controlled, whether it's the agency's own inbox or a client's. The warm-up ramp begins at 8 sends a day unless the inbox is already warmed up.</p><p>As soon as a prospect replies, InboxJoy stops the remaining follow-ups so a real person can take over the conversation.</p></article>
        </div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Agency playbook" title="An agency cold email playbook for running client campaigns" description="Agencies run outreach for themselves and, often, for the clients they're pitching or onboarding. That means the mechanics have to hold up across more than one mailbox and more than one story, without any single campaign borrowing another client's reputation." />
        <div className="pages-card-grid">
          <article className="pages-info-card">
            <span>Run</span>
            <h3>Running client campaigns</h3>
            <p>Keep each engagement's pitch distinct, even when the mechanics behind it are the same across every account and every client sees a version tailored to their own audience.</p>
            <CheckList items={[
              "Run a separate sequence per client or per service line instead of one catch-all pitch",
              "Import a segmented CSV list per client vertical so targeting stays sharp",
              "Keep merge tags consistent so a mass-drafted sequence still reads personalized per contact",
              "Reuse a proven sequence structure across engagements, and adjust only the angle and offer",
            ]} />
          </article>
          <article className="pages-info-card">
            <span>Report</span>
            <h3>Reporting with unsubscribe rates</h3>
            <p>Show list health alongside raw send activity, so a client can see whether the list is holding up as well as whether it's moving.</p>
            <CheckList items={[
              "Pull per-campaign unsubscribe rate alongside opens for every client report",
              "Share step-level analytics as part of a weekly or monthly new-business update",
              "Treat a rising unsubscribe rate as a signal to refresh the angle before it spreads",
              "Compare unsubscribe rate across campaigns to catch a weak list before it burns a mailbox's reputation",
            ]} />
          </article>
          <article className="pages-info-card">
            <span>Warm up</span>
            <h3>Warm-up when onboarding client mailboxes</h3>
            <p>Treat a newly connected client inbox with the same care as a brand-new one, even if the client has been sending email for years on their own — InboxJoy has no history with that inbox's sending pattern yet.</p>
            <CheckList items={[
              "Run the automatic warm-up ramp — starting at 8 sends a day — for any client mailbox you don't already know is active",
              "Skip warm-up only when the agency can confirm the mailbox already sends regularly",
              "Stagger onboarding across multiple client mailboxes so ramps don't all mature in the same week",
              "Keep each client mailbox's caps and windows independent so one account's pace doesn't affect another",
            ]} />
          </article>
        </div>
        <div className="v2-section-heading"><p>Every one of these habits exists to protect the agency's sender reputation as much as any single client's results — a mailbox burned on one engagement is harder to use on the next.</p></div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Why InboxJoy" title="Why agencies run new business from their own connected inbox" description="A generic marketing platform or a manually tracked outreach sheet both make it harder to show a client — or your own partners — what's actually working." />
        <div className="pages-card-grid">
          <article className="pages-info-card"><span>1</span><h3>No lookalike client pitches</h3><p>Separate sequences per client or service line keep pitches distinct even when they're all run from one InboxJoy workspace with the same team behind them.</p></article>
          <article className="pages-info-card"><span>2</span><h3>No manual reputation tracking</h3><p>The warm-up ramp and per-mailbox caps protect deliverability automatically, so nobody has to remember to watch a newly connected client inbox closely.</p></article>
          <article className="pages-info-card"><span>3</span><h3>No guessing on client reporting</h3><p>Unsubscribe rate and per-step opens give a real, specific report for the next check-in.</p></article>
        </div>
        <div className="v2-section-heading"><p>None of this requires the agency to become an email-infrastructure team. Connecting a mailbox, importing a list, and reading a report are the same three actions whether the inbox belongs to the agency or a client that just signed the engagement.</p></div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="How it works" title="A weekly new-business habit" description="A simple loop that can keep running even when project work gets unpredictable." />
        <div className="pages-usecase-band">
          <article><b>Monday</b><h3>Refresh the prospect list</h3><p>Export the contacts you researched over the week and import the CSV into InboxJoy for the next campaign.</p></article>
          <article><b>Review</b><h3>Tune the sequence</h3><p>Shape the AI draft around one service, one audience, and one clear next step — reusing the structure that's already working.</p></article>
          <article><b>During the week</b><h3>Work the replies</h3><p>Let scheduled follow-ups continue for quiet prospects while replies stop automatically and become direct conversations.</p></article>
        </div>
      </section>

      <FaqSection title="Agency outreach questions" items={faqs} />
      <JsonLd data={faqPageJsonLd(faqs)} />

      <RelatedPages
        eyebrow="More ways teams use InboxJoy"
        title="See the guide built for your team shape"
        links={[
          { href: "/use-cases/founders", label: "Use case", title: "For founders", description: "Turn founder-led insight into concise outreach without becoming a full-time sales operator.", cta: "Explore founder outreach" },
          { href: "/use-cases/sales-teams", label: "Use case", title: "For small sales teams", description: "Give each connected mailbox clear sending limits and a repeatable follow-up rhythm.", cta: "Explore team outreach" },
          { href: "/use-cases", label: "Overview", title: "All use cases", description: "Compare every InboxJoy use case guide from a single hub page.", cta: "See all use cases" },
        ]}
      />

      <FinalCta title="Make new business survive the busy weeks" description="Turn your agency's best pitch into a consistent sequence, on the managed license or your own server." />
      <SiteFooter />
    </MarketingPage>
  );
}
