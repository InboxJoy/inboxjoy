import type { Metadata } from "next";
import Link from "next/link";
import { CheckList, FaqSection, FinalCta, HeroCta, MarketingPage, PageHero, SectionHeading, SiteFooter } from "../../_pages/site";
import { Breadcrumbs, JsonLd, RelatedPages, faqPageJsonLd, webApplicationJsonLd } from "../../_pages/seo";
import "../../pages.css";

const title = "Email Sequences for Small Sales Teams | InboxJoy";
const description =
  "InboxJoy helps small sales teams run controlled Gmail and Outlook sequences with mailbox caps, sending windows, reply stops, CSV import, and step analytics.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: "/use-cases/sales-teams" },
};

const faqs = [
  [
    "Can each rep have their own sending caps and windows?",
    "Yes. Every connected mailbox gets its own daily and hourly cap and sending window, so one rep's pace never depends on an informal team rule or another rep's inbox, and a manager can tune each one independently as territories change.",
  ],
  [
    "Does every rep need a separate InboxJoy account?",
    "No. Team seats are unlimited, so the whole team can log in and manage their own mailbox and sequences without an extra per-seat cost — a useful difference from tools that charge per user as the team grows.",
  ],
  [
    "How do we onboard a new rep's mailbox without hurting deliverability?",
    "Connect the new mailbox in one click and let the automatic warm-up ramp handle it — starting at 8 sends a day and rising about 15% a day until it reaches full pace. Skip the ramp only if that inbox already sends regularly, so a brand-new hire doesn't put an unproven mailbox at risk on day one.",
  ],
  [
    "What happens when a lead replies to one rep's sequence?",
    "InboxJoy stops the remaining follow-up steps for that lead automatically, so the rep who owns the reply can respond directly without a scheduled nudge going out on top of the conversation, and without another rep accidentally reaching the same lead.",
  ],
  [
    "Can we see which step of a sequence is actually working?",
    "Yes. Per-step analytics show opens and performance at each stage, plus unsubscribe rate per campaign, so a manager can tell whether step one or step three needs work — useful in a coaching conversation or a pipeline review.",
  ],
  [
    "Do reps need their own domain or DNS setup?",
    "No. Each rep connects their Gmail, Google Workspace, or Outlook mailbox in one click — there is no DNS record to configure before sending.",
  ],
  [
    "Can we import the lead list we already have?",
    "Yes. Upload a CSV and InboxJoy maps it to the merge tags and sequence you're launching, so the handoff from an existing list stays simple whether it came from a spreadsheet, an event, or a partner referral batch.",
  ],
  [
    "What does InboxJoy cost for a small team?",
    "InboxJoy is free to self-host (open source). The managed lifetime license is $79, paid once, with unlimited seats included and no renewals, and it has a 30-day money-back guarantee.",
  ],
  [
    "Can reps use InboxJoy from tools they already have open, like Claude or ChatGPT?",
    "Yes. InboxJoy runs a remote MCP server, so a rep or manager can check sequence status, review analytics, or make an adjustment from inside Claude or ChatGPT, with no separate dashboard tab to switch to.",
  ],
  [
    "Do we need to set individual sending hours for each rep?",
    "You can. Sending windows are configurable per mailbox, so a rep working different hours than the rest of the team can have their sequence follow their own schedule.",
  ],
] as const;

export default function SalesTeamsUseCasePage() {
  return (
    <MarketingPage>
      <PageHero kicker="InboxJoy for small sales teams" title={<>A repeatable outbound rhythm<br />for every connected inbox.</>} description="Keep cold outreach consistent without adding a heavyweight operations layer. Each mailbox gets clear limits, planned sending windows, and follow-ups that stop when a reply arrives.">
        <HeroCta />
      </PageHero>

      <Breadcrumbs crumbs={[["Home", "/"], ["Use cases", "/use-cases"], ["Sales teams", "/use-cases/sales-teams"]]} />
      <JsonLd data={webApplicationJsonLd({ name: "InboxJoy for Sales Teams", path: "/use-cases/sales-teams", description })} />

      <section className="v2-section">
        <SectionHeading eyebrow="The team challenge" title="Consistency without unnecessary process" description="A two- or three-person sales team is too small to justify a heavyweight sales-engagement platform, but too big to run outbound on memory and a shared spreadsheet. Small teams need enough structure to repeat what works, without a platform that creates a new operations job." />
        <div className="pages-card-grid">
          <article className="pages-info-card"><span>01</span><h3>Uneven sending habits</h3><p>One mailbox sends in bursts while another goes quiet, making the team&apos;s weekly pipeline activity hard to reason about or forecast from, and harder still to explain in a pipeline review.</p></article>
          <article className="pages-info-card"><span>02</span><h3>Follow-ups drift</h3><p>Reps write good first messages, then timing varies because each next step depends on personal reminders.</p></article>
          <article className="pages-info-card"><span>03</span><h3>Results lack context</h3><p>A total open count is not enough. The team needs to see which sequence step is attracting attention and which one is quietly losing people before the next list goes out.</p></article>
        </div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Feature fit" title="Put guardrails around the sending motion" description="InboxJoy makes the repeatable parts explicit at the mailbox and sequence level." />
        <div className="pages-split">
          <div className="pages-split-copy"><div className="v2-stripes" /><h3>Control the pace per mailbox</h3><p>Set daily and hourly caps and sending windows for each connected mailbox, so pace never depends on an informal team rule that only lives in someone's head and gets forgotten the day that person is out.</p><CheckList items={["Connect Gmail and Outlook mailboxes in one click", "Use an automatic warm-up ramp starting at 8 sends per day, or skip it for warmed inboxes", "Keep messages within configured sending windows", "Stop future steps automatically when a lead replies"]} /></div>
          <article className="pages-fair-card"><span>Improve the sequence</span><h3>Give the team a clearer feedback loop</h3><p>Start from an AI-drafted sequence with consistent merge tags, then review performance at each step. Open tracking and unsubscribe rate per campaign help show where attention drops or improves, campaign by campaign.</p><p>CSV import keeps the handoff from an existing lead list simple without requiring a new data workflow or a CRM migration project.</p></article>
        </div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Sales team playbook" title="A sales team cold email playbook for coordinated outbound" description="The moment a second or third rep starts sending, coordination matters more than any single rep's copywriting. Here is how teams keep every mailbox pulling in the same direction, from setting limits to closing the loop on what's working." />
        <div className="pages-card-grid">
          <article className="pages-info-card">
            <span>Caps</span>
            <h3>Multi-mailbox cap coordination</h3>
            <p>Treat every connected mailbox as its own sender with its own limits.</p>
            <CheckList items={[
              "Give each rep's mailbox its own daily and hourly cap and sending window",
              "Keep aggregate team volume proportional to headcount, so no single mailbox absorbs the load",
              "Start any newly connected rep mailbox on warm-up even if the rest of the team is already ramped",
              "Review caps when a rep's territory or list size changes materially",
            ]} />
          </article>
          <article className="pages-info-card">
            <span>Handoff</span>
            <h3>Reply and handoff workflows</h3>
            <p>Replies should route to a person.</p>
            <CheckList items={[
              "InboxJoy auto-stops the remaining follow-up steps the moment a lead replies",
              "The owning rep responds directly from their own connected inbox",
              "Unlimited seats mean every rep works from their own login and their own sequence view",
              "Use the remote MCP server to check sequence status from Claude or ChatGPT between calls",
            ]} />
          </article>
          <article className="pages-info-card">
            <span>Coaching</span>
            <h3>Per-step analytics for coaching</h3>
            <p>Compare performance step by step across reps to see exactly where the sequence actually breaks down.</p>
            <CheckList items={[
              "Compare open and reply patterns at each sequence step across every rep",
              "Spot a rep whose step one opens fine but whose step three follow-up underperforms",
              "Standardize the best-performing subject lines and openers across the team's sequences",
              "Watch unsubscribe rate per campaign as an early flag before it affects deliverability",
            ]} />
          </article>
        </div>
        <div className="v2-section-heading"><p>Coordination is the whole point once a second mailbox joins the first. InboxJoy makes the caps, the handoff, and the coaching data explicit at the mailbox level, so growing the team doesn't mean growing the chaos.</p></div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Why InboxJoy" title="Why teams outgrow a shared spreadsheet" description="A tracking sheet works for one sender. It breaks down the moment a second or third rep starts sending from their own inbox." />
        <div className="pages-card-grid">
          <article className="pages-info-card"><span>1</span><h3>No unclear lead ownership</h3><p>A shared sheet doesn't show who owns a lead or when they were last touched. Per-mailbox sequences make ownership explicit, since each lead lives inside the sending rep's own sequence.</p></article>
          <article className="pages-info-card"><span>2</span><h3>No invisible sending pace</h3><p>Manual tracking can't show whether one rep is quietly bursting sends. Per-mailbox caps and sending windows make pace visible and controlled without a manager having to ask.</p></article>
          <article className="pages-info-card"><span>3</span><h3>No guessing on what worked</h3><p>A spreadsheet can log that a call happened. Per-step analytics shows which subject line or follow-up step earned the reply, automatically, for every rep.</p></article>
        </div>
        <div className="v2-section-heading"><p>None of this requires a dedicated sales-ops hire or a multi-week CRM rollout. A manager sets caps and windows once per mailbox, and the team's existing prospecting habits — who to call, what list to work next — stay exactly the same.</p></div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="How it works" title="A lightweight operating cadence" description="Use InboxJoy as the repeatable sending layer around the team's existing prospecting process." />
        <div className="pages-usecase-band">
          <article><b>Prepare</b><h3>Set mailbox rules</h3><p>Connect each rep's Gmail or Outlook inbox and define the caps and windows that match their territory.</p></article>
          <article><b>Launch</b><h3>Import and draft</h3><p>Upload contacts per rep and use AI to draft the sequence with consistent merge tags across the team.</p></article>
          <article><b>Review</b><h3>Read step-level signals</h3><p>Watch opens and per-step performance across reps, while replies remove leads from later follow-ups automatically.</p></article>
        </div>
      </section>

      <FaqSection title="Sales team outreach questions" items={faqs} />
      <JsonLd data={faqPageJsonLd(faqs)} />

      <RelatedPages
        eyebrow="More ways teams use InboxJoy"
        title="See the guide built for your team shape"
        links={[
          { href: "/use-cases/founders", label: "Use case", title: "For founders", description: "Turn founder-led insight into concise outreach without becoming a full-time sales operator.", cta: "Explore founder outreach" },
          { href: "/use-cases/agencies", label: "Use case", title: "For agencies", description: "Keep new-business follow-up moving while delivery work still takes most of the week.", cta: "Explore agency outreach" },
          { href: "/use-cases", label: "Overview", title: "All use cases", description: "Compare every InboxJoy use case guide from a single hub page.", cta: "See all use cases" },
        ]}
      />

      <FinalCta title="Give the team a steadier sending rhythm" description="Run the full InboxJoy workflow — one of the simplest email outreach tools for small teams — on the lifetime license or your own server." />
      <SiteFooter />
    </MarketingPage>
  );
}
