import type { Metadata } from "next";
import Link from "next/link";
import { FaqSection, FinalCta, HeroCta, MarketingPage, PageHero, SectionHeading, SiteFooter } from "../../_pages/site";
import { CompareTable, DecisionCards, FitCheck } from "../../_pages/compare";
import { Breadcrumbs, JsonLd, RelatedPages, faqPageJsonLd } from "../../_pages/seo";
import "../../pages.css";

const title = "Best Instantly Alternative in 2026";
const description =
  "Comparing InboxJoy vs Instantly? See pricing, mailbox setup, sending controls, and automation to find the better Instantly alternative for cold outreach.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: "/alternatives/instantly" },
};

const rows = [
  ["Manage from Claude & ChatGPT (MCP)", "Built in", "Verify current integrations"],
  ["Self-host option", "Free, open source (AGPL-3.0)", "Verify current offer"],
  ["Mailbox connection", "Gmail + Outlook, one click", "Dedicated domains recommended"],
  ["AI sequence drafting", "Included with merge tags", "Included"],
  ["Sending controls", "Per-mailbox caps + windows", "Managed for you"],
  ["Warm-up behavior", "Automatic ramp from 8/day, skippable", "Included"],
  ["Reply handling", "Stops follow-ups automatically", "Automatic"],
  ["Reporting", "Per-step analytics + opens + unsubscribe rate", "Verify current plan"],
  ["Team seats", "Unlimited on every plan", "Verify current plan"],
] as const;

const price = ["$79 once (lifetime)", "$47/month"] as const;

const fit = {
  ours: {
    title: "Where InboxJoy is strong",
    intro: "A direct path from connected mailbox to controlled sending, with nothing extra to configure before launch.",
    items: ["One-click Gmail, Workspace, or Outlook connection", "Bring your own list via CSV import", "AI-drafted sequences with merge tags", "Per-mailbox caps, hourly limits, and sending windows", "Automatic warm-up ramp, skippable when already warm", "Replies stop follow-ups, unlimited team seats"],
  },
  theirs: {
    title: "Built for multi-account sending operations",
    intro: "A fit when running many accounts, sourcing leads in-platform, or coordinating client domains matters more than a single focused inbox.",
    items: ["Manages many sending accounts and domains", "Built-in lead database and email finder", "Unibox consolidates replies across accounts", "Warm-up network across its user base", "Helps agencies coordinate many client domains"],
  },
} as const;

const decision = {
  ours: { title: "You want a direct, controlled workflow", items: ["You send from Gmail or Outlook", "Setup measured in minutes", "Per-mailbox caps and automatic warm-up", "Reply-based stopping built in", "Manage sequences from Claude or ChatGPT"] },
  theirs: { title: "You're scaling multi-account outbound", items: ["You source leads inside the platform", "You run many sending accounts at once", "Your team already runs on Instantly", "Compare volume against current plan limits"] },
  undecided: { title: "Test both before committing", items: ["Self-host InboxJoy free, or try managed with the 30-day guarantee", "Use a small, real list", "Compare setup time and total cost", "Check Instantly's current trial or demo offer"] },
} as const;

const faqs = [
  ["Is InboxJoy designed for large sending infrastructures?", "InboxJoy is designed for controlled sequences from connected Gmail and Outlook mailboxes. Teams building a larger outbound infrastructure with many sending accounts should compare Instantly's current offering directly."],
  ["Which product is less expensive to start?", "Using the public prices cited here, InboxJoy is free to self-host (open source) and has a $79 managed lifetime license paid once, while Instantly starts at $47 per month on monthly billing. Instantly's current pricing should be verified before purchase, since plans and tiers change."],
  ["Can InboxJoy stop a sequence when someone replies?", "Yes. Replies are detected automatically and stop later follow-up steps for that contact, so nobody keeps getting emails after they've already responded."],
  ["Does InboxJoy require setting up a separate sending domain?", "No. InboxJoy connects directly to the Gmail, Google Workspace, or Outlook mailbox you already use, in one click, with no domain or DNS setup required. Instantly is commonly used with dedicated sending domains, so factor that setup time and cost into your comparison."],
  ["Can I manage InboxJoy from Claude or ChatGPT instead of the dashboard?", "Yes. InboxJoy includes a remote MCP server, so you can review sequences, check performance, and manage campaigns from Claude or ChatGPT in addition to the InboxJoy dashboard. Check Instantly's current integrations directly if an MCP workflow matters to your team."],
  ["Does InboxJoy charge per seat like some outbound tools?", "No. InboxJoy includes unlimited team seats on every plan, so adding teammates never increases your bill. Verify whether Instantly's current plans price by seat, by sending account, or by another metric, since that changes the real cost for a growing team."],
  ["How does warm-up work on InboxJoy versus Instantly?", "New InboxJoy mailboxes start warm-up at 8 sends per day and increase by roughly 15% per day automatically, and warm-up can be skipped entirely for mailboxes that are already warmed up elsewhere. Instantly also offers warm-up; confirm its current mechanics and any related costs on its site."],
  ["Is there a refund if InboxJoy turns out not to be the right fit?", "Yes. The managed lifetime license comes with a 30-day money-back guarantee, and you can self-host for free to test the real workflow first."],
  ["Can I try InboxJoy before paying anything?", "Yes, two ways. Self-hosting is free: it is open source, and you run it on your own server with your own mailboxes and AI key. Managed has no free tier, but you can set up your workspace before you buy, and the 30-day money-back guarantee covers the $79 lifetime license."],
] as const;

export default function InstantlyAlternativePage() {
  return (
    <MarketingPage>
      <PageHero kicker="InboxJoy vs Instantly" title={<>Best Instantly<br />Alternative in 2026</>} description="Looking for an Instantly alternative? InboxJoy is built for people who want a direct Gmail or Outlook workflow, clear mailbox limits, and email sequences without assembling a larger outbound operation.">
        <HeroCta />
      </PageHero>

      <Breadcrumbs crumbs={[["Home", "/"], ["Alternatives", "/alternatives"], ["Instantly alternative", "/alternatives/instantly"]]} />

      <section className="v2-section">
        <SectionHeading eyebrow="Instantly overview" title="Key features of Instantly" description="A quick look at what Instantly is generally built around, before comparing it feature by feature with InboxJoy below." />
        <div className="pages-card-grid">
          <article className="pages-info-card"><span>01</span><h3>Many sending accounts</h3><p>Instantly is built around connecting a large number of sending mailboxes at once, aimed at teams that want to scale volume across multiple accounts and domains rather than send from a single inbox.</p></article>
          <article className="pages-info-card"><span>02</span><h3>Lead database & finder</h3><p>Instantly bundles a lead database and email finder, so some teams source contacts inside the platform rather than importing their own CSV list. That can save a step for cold prospecting, though it also means part of your list-building lives inside the tool itself.</p></article>
          <article className="pages-info-card"><span>03</span><h3>Unibox & campaign builder</h3><p>A shared inbox view consolidates replies across connected accounts, alongside a sequence builder for multi-step email campaigns, which helps when several mailboxes are running outreach in parallel.</p></article>
          <article className="pages-info-card"><span>04</span><h3>Warm-up network</h3><p>Instantly offers a warm-up network across its user base to help maintain inbox reputation. Confirm current warm-up mechanics, eligibility, and any related costs on its site before relying on it for a new domain.</p></article>
          <article className="pages-info-card"><span>05</span><h3>Analytics & reporting</h3><p>Instantly reports on sends, opens, and replies across campaigns, though the depth of per-step and unsubscribe reporting can vary by plan. Confirm what's included before relying on it for optimization decisions.</p></article>
        </div>
        <p className="pages-compare-footnote">None of this makes Instantly better or worse on its own — it's a different bet on where complexity should live. The comparison below shows how that trade-off plays out feature by feature.</p>
      </section>

      <section className="v2-section v2-comparison pages-compare-three">
        <SectionHeading eyebrow="Feature comparison" title="InboxJoy and Instantly, side by side" description="This table keeps InboxJoy claims specific and flags competitor details that require a current plan check." />
        <CompareTable competitor="Instantly" rows={rows} price={price} footer="Evaluate the setup and controls you will actually use." />
        <p className="pages-compare-footnote">Instantly pricing and product details are drawn from its public pricing and product pages and should be verified before purchase because plans change.</p>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Honest fit check" title="Where each tool is strong" description="Neither tool is right for everyone. Here's where InboxJoy tends to win, and where Instantly's broader platform may be worth the extra complexity." />
        <FitCheck competitor="Instantly" ours={fit.ours} theirs={fit.theirs} />
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Decision" title="Which one should you pick?" description="A quick way to decide without reading every feature row twice." />
        <DecisionCards competitor="Instantly" ours={decision.ours} theirs={decision.theirs} undecided={decision.undecided} />
      </section>

      <FaqSection items={faqs} title="Instantly comparison questions" />
      <JsonLd data={faqPageJsonLd(faqs)} />

      <RelatedPages
        eyebrow="Compare more tools"
        title="Compare more tools"
        description="See how InboxJoy stacks up elsewhere, and where it fits into a real outbound workflow."
        links={[
          { href: "/alternatives/mailshake", label: "Comparison", title: "InboxJoy vs Mailshake", description: "See how InboxJoy compares with Mailshake's per-user sales engagement pricing and workflow.", cta: "Read the comparison" },
          { href: "/pricing", label: "Pricing", title: "InboxJoy pricing", description: "See the free self-hosted edition, the $79 managed lifetime license, and the 30-day money-back guarantee.", cta: "View pricing" },
          { href: "/use-cases/sales-teams", label: "Use case", title: "InboxJoy for sales teams", description: "See how sales teams use InboxJoy to run controlled, personalized outbound sequences.", cta: "See the use case" },
        ]}
      />

      <FinalCta title="Start with the workflow you need" description="Get the lifetime license, or self-host free, and judge the connected-mailbox experience for yourself." />
      <SiteFooter />
    </MarketingPage>
  );
}
