import type { Metadata } from "next";
import Link from "next/link";
import { CheckList, FaqSection, FinalCta, HeroCta, MarketingPage, PageHero, SectionHeading, SiteFooter } from "../../_pages/site";
import { Breadcrumbs, JsonLd, RelatedPages, faqPageJsonLd, webApplicationJsonLd } from "../../_pages/seo";
import "../../pages.css";

const title = "Cold Email Sequences for Founders | InboxJoy";
const description =
  "InboxJoy helps founders turn product knowledge into controlled Gmail or Outlook sequences with AI drafts, merge tags, reply stops, and simple analytics.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: "/use-cases/founders" },
};

const faqs = [
  [
    "Do I need a domain or DNS setup to start sending?",
    "No. InboxJoy connects to Gmail, Google Workspace, or Outlook in one click, using the inbox you already send from. There is no DNS record to add or domain to configure before you can launch a sequence.",
  ],
  [
    "How much can I realistically send from a single inbox as a solo founder?",
    "New inboxes start on an automatic warm-up ramp of 8 sends a day, rising about 15% a day until it reaches full pace, with a daily and hourly cap you set. If your inbox already sends regularly, you can skip warm-up and start at your chosen cap.",
  ],
  [
    "Will InboxJoy write the whole email for me?",
    "AI drafts the sequence as a starting point. You review and edit it, and merge tags like {{firstName}}, {{company}}, and {{title}} personalize each send automatically from your imported contact list.",
  ],
  [
    "What happens when a prospect replies?",
    "InboxJoy stops the remaining scheduled follow-ups for that contact automatically, so you can move straight into a real conversation, with no automated nudge landing on top of your reply.",
  ],
  [
    "Can I manage sequences without living in a dashboard?",
    "Yes. InboxJoy runs a remote MCP server, so you can check status, review analytics, or adjust a sequence from inside Claude or ChatGPT, with no separate tab to open.",
  ],
  [
    "What does it cost to get started?",
    "Self-hosting is free: InboxJoy is open source (AGPL-3.0), and you run it on your own server. If you would rather we run it, the managed lifetime license is $79, paid once, with a 30-day money-back guarantee.",
  ],
  [
    "Do I need a team to use InboxJoy?",
    "No. It works for a single founder sending from one inbox, and team seats are unlimited if you bring in a co-founder or first hire later without paying more per seat.",
  ],
  [
    "How do I know if a sequence is actually working?",
    "Per-step analytics show opens and performance at each stage of the sequence, plus unsubscribe rate per campaign, so you can see exactly where attention drops across each sequence step.",
  ],
  [
    "Can I import the list I already have?",
    "Yes. Upload a CSV of your contacts and InboxJoy maps the fields you need for merge tags and sequencing — no manual re-entry.",
  ],
  [
    "Can I set specific hours for outreach to go out?",
    "Yes. Sending windows let you define the hours each mailbox is allowed to send, so a sequence you scheduled Monday morning doesn't send emails at 2am on a Saturday.",
  ],
  [
    "Do I need engineering help to set any of this up?",
    "No. Connecting Gmail, Google Workspace, or Outlook, importing a CSV, and launching a sequence are all done from the InboxJoy interface — there's no code, webhook, or DNS change to hand off to an engineer.",
  ],
] as const;

export default function FoundersUseCasePage() {
  return (
    <MarketingPage>
      <PageHero kicker="InboxJoy for founders" title={<>Founder-led outbound<br />without the sales-ops tax.</>} description="You know the customer problem better than anyone. InboxJoy helps you turn that knowledge into a short, reviewed cold outreach sequence without spending the day managing follow-up spreadsheets.">
        <HeroCta />
      </PageHero>

      <Breadcrumbs crumbs={[["Home", "/"], ["Use cases", "/use-cases"], ["Founders", "/use-cases/founders"]]} />
      <JsonLd data={webApplicationJsonLd({ name: "InboxJoy for Founders", path: "/use-cases/founders", description })} />

      <section className="v2-section">
        <SectionHeading eyebrow="The founder reality" title="Good outreach competes with everything else" description="Most cold email tools are built for a sales team: multiple reps, an admin console, a CRM to sync. A solo founder or a two-person founding team doesn't need that. You need one connected inbox, a sequence you trust enough to send while you're heads-down on product, and a way to know the moment someone replies — without hiring anyone to own outbound. The hardest part is rarely knowing what to say. It is creating a repeatable system while product, hiring, support, and fundraising keep moving." />
        <div className="pages-card-grid">
          <article className="pages-info-card"><span>01</span><h3>The blank-page problem</h3><p>You can explain the product on a call, but turning that into a concise subject, opener, ask, and follow-up takes time — time that competes directly with product, hiring, and fundraising work due this week. AI drafting exists specifically to remove that first-draft tax.</p></article>
          <article className="pages-info-card"><span>02</span><h3>Follow-up gets forgotten</h3><p>A promising first email is wasted when the next touch depends on remembering another task three days later, especially when the whole sequence lives in your head.</p></article>
          <article className="pages-info-card"><span>03</span><h3>Your real inbox matters</h3><p>You want direct conversations from the address prospects will recognize, with controls that prevent a sudden sending spike that could get a personal inbox flagged as spam right when you need it most.</p></article>
        </div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Feature fit" title="Turn your knowledge into a controlled sequence" description="InboxJoy handles the repeatable mechanics while you keep control of the message." />
        <div className="pages-split">
          <div className="pages-split-copy"><div className="v2-stripes" /><h3>Write from real context</h3><p>AI drafts the sequence, then merge tags help tailor the opener to the person and company you selected — so a list of fifty contacts still reads like fifty individual notes.</p><CheckList items={["Use {{firstName}}, {{company}}, and {{title}} in drafts", "Import a focused contact list from CSV", "Keep personalization fields consistent across the sequence", "Track opens and performance by sequence step"]} /></div>
          <article className="pages-fair-card"><span>Protect your attention</span><h3>Let the sequence remember the follow-up</h3><p>Sending windows keep outreach inside the schedule you choose, so nothing goes out while you're heads-down or asleep. Daily and hourly mailbox caps define the pace, and the automatic warm-up ramp starts at 8 sends per day, rising gradually toward full volume. Already-warmed inboxes can skip it entirely.</p><p>When a prospect replies, InboxJoy stops later follow-ups automatically so you can focus on the conversation between meetings.</p></article>
        </div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Founder outreach playbook" title="A founder cold email playbook built for solo-founder time" description="Founder-led outreach works because the list is small and the read on the market is sharp. Here is what actually moves the needle at this stage, broken into who to email, what to say, and how much to expect to send." />
        <div className="pages-card-grid">
          <article className="pages-info-card">
            <span>Who</span>
            <h3>Who to target</h3>
            <p>Keep the list narrow and specific — a founder's credibility comes from relevance.</p>
            <CheckList items={[
              "Design partners in your exact niche who feel the problem today",
              "Early adopters who've complained publicly about the gap you're closing — forums, reviews, X threads",
              "People who already follow your build-in-public updates or launch posts (warm-adjacent)",
              "Companies one stage ahead of yours with the budget and urgency to act now",
            ]} />
          </article>
          <article className="pages-info-card">
            <span>What</span>
            <h3>Sequence angles that work</h3>
            <p>For founder-led outbound, the angle matters more than the copywriting polish, because the reader is judging your read on the problem.</p>
            <CheckList items={[
              "Open with a specific observation about their situation",
              "Ask for a reaction or opinion in step one",
              "Frame it as building with them, a design-partner ask",
              "Keep it to 3-4 steps; a small list doesn't need a long sequence to feel thorough",
            ]} />
          </article>
          <article className="pages-info-card">
            <span>How much</span>
            <h3>Volume expectations for one inbox</h3>
            <p>A single connected inbox keeps outreach focused, and that constraint is a feature at this stage. Daily caps and the warm-up ramp keep that one inbox safe.</p>
            <CheckList items={[
              "Warm-up starts at 8 sends a day, rising about 15% a day toward full pace",
              "A newly connected inbox nets a modest, steady send count each month once ramped — enough for a targeted list",
              "Reply rate on a 50-150 contact list matters more than raw send count",
              "Skip warm-up only if the inbox already sends regularly; otherwise let the ramp protect deliverability",
            ]} />
          </article>
        </div>
      </section>

      <section className="v2-section">
        <div className="v2-section-heading"><p>The common thread across who to target, what to say, and how much to send: a founder's outbound advantage is specificity. InboxJoy is built so the mechanics — drafting, pacing, follow-up, and reading the results — never get in the way of that advantage.</p></div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Why InboxJoy" title="Built for a single connected inbox" description="Founders usually reach for one of two extremes: a manual spreadsheet, or an enterprise sequencer built for a revenue team. Neither fits a single connected inbox and a founder's schedule." />
        <div className="pages-card-grid">
          <article className="pages-info-card"><span>1</span><h3>No SDR team required</h3><p>AI drafting fills the role an SDR usually plays — turning your product knowledge into a first draft — without adding headcount or a hiring process before you have a sales motion worth staffing.</p></article>
          <article className="pages-info-card"><span>2</span><h3>No enterprise sequencer overhead</h3><p>Heavier platforms assume multiple reps, territories, and a CRM integration project. InboxJoy needs one connected inbox, a CSV, and sending caps — set up in minutes.</p></article>
          <article className="pages-info-card"><span>3</span><h3>No spreadsheet follow-up</h3><p>Replace a manually tracked follow-up column with automatic reply stops and per-step analytics, so nothing depends on remembering to check a tab you haven't opened since Tuesday.</p></article>
        </div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="How it works" title="From idea to first conversations" description="A compact workflow for founders who need signal quickly without skipping review." />
        <div className="pages-usecase-band">
          <article><b>Step 1</b><h3>Connect your inbox</h3><p>Link the Gmail, Google Workspace, or Outlook address you already use in one click — no domain or DNS setup required.</p></article>
          <article><b>Step 2</b><h3>Import and draft</h3><p>Upload a CSV of your target list and use AI to draft the steps with first name, company, and title merge tags.</p></article>
          <article><b>Step 3</b><h3>Launch and listen</h3><p>Set your sending windows and caps, then use replies and per-step analytics to shape the next iteration of the sequence.</p></article>
        </div>
      </section>

      <FaqSection title="Founder outreach questions" items={faqs} />
      <JsonLd data={faqPageJsonLd(faqs)} />

      <RelatedPages
        eyebrow="More ways teams use InboxJoy"
        title="See the guide built for your team shape"
        links={[
          { href: "/use-cases/sales-teams", label: "Use case", title: "For small sales teams", description: "Give each connected mailbox clear sending limits and a repeatable follow-up rhythm.", cta: "Explore team outreach" },
          { href: "/use-cases/agencies", label: "Use case", title: "For agencies", description: "Keep new-business follow-up moving while delivery work still takes most of the week.", cta: "Explore agency outreach" },
          { href: "/use-cases", label: "Overview", title: "All use cases", description: "Compare every InboxJoy use case guide from a single hub page.", cta: "See all use cases" },
        ]}
      />

      <FinalCta title="Start the conversations only you can have" description="Bring your founder insight. InboxJoy will help with the sequence mechanics." />
      <SiteFooter />
    </MarketingPage>
  );
}
