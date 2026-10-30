import type { Metadata } from "next";
import Link from "next/link";
import { FaqSection, FinalCta, HeroCta, MarketingPage, PageHero, SectionHeading, SiteFooter } from "../../_pages/site";
import { CompareTable, DecisionCards, FitCheck } from "../../_pages/compare";
import { Breadcrumbs, JsonLd, RelatedPages, faqPageJsonLd } from "../../_pages/seo";
import "../../pages.css";

const title = "Best Mailshake Alternative in 2026";
const description =
  "Comparing InboxJoy vs Mailshake? See pricing, mailbox setup, sending controls, and sequence automation to find the right Mailshake alternative.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: "/alternatives/mailshake" },
};

const rows = [
  ["Manage from Claude & ChatGPT (MCP)", "Built in", "Verify current integrations"],
  ["Self-host option", "Free, open source (AGPL-3.0)", "Verify current offer"],
  ["Mailbox connection", "Gmail + Outlook, one click", "Gmail + Outlook"],
  ["AI sequence drafting", "Included with merge tags", "Included"],
  ["Sending controls", "Daily/hourly caps + windows", "You set them"],
  ["Warm-up behavior", "Automatic ramp from 8/day, skippable", "Add-on"],
  ["Reply handling", "Stops follow-ups automatically", "Automatic"],
  ["Reporting", "Per-step analytics + opens + unsubscribe rate", "Verify current plan"],
  ["Team seats", "Unlimited on every plan", "Priced per user"],
] as const;

const price = ["$79 once (lifetime)", "$29/user/month"] as const;

const fit = {
  ours: {
    title: "Where InboxJoy is strong",
    intro: "A short path from connected mailbox to controlled campaign, with nothing to configure before your first real sequence.",
    items: ["One-click Gmail or Outlook, no domain or DNS setup", "AI-drafted sequences with merge tags", "Per-mailbox daily and hourly caps, plus sending windows", "Automatic warm-up ramp on every plan", "Replies stop follow-ups automatically", "Unlimited team seats at one flat price"],
  },
  theirs: {
    title: "Built for multi-channel sales engagement",
    intro: "A fit when phone, LinkedIn, or CRM-heavy workflows matter more than a focused email tool.",
    items: ["Phone and social tasks alongside email steps", "CRM integrations that sync activity back", "Team dashboards for sends, replies, and deliverability", "Per-rep reporting for sales managers", "An established workflow if your team already uses it"],
  },
} as const;

const decision = {
  ours: { title: "You want focused, affordable email sequencing", items: ["You send from Gmail or Outlook", "Email-only sequences are enough", "Caps, warm-up, and reply-stop built in", "Flat price as your team grows", "Manage campaigns from Claude or ChatGPT"] },
  theirs: { title: "You need a broader sales-engagement stack", items: ["Phone or LinkedIn steps are essential", "You rely on a specific CRM integration", "Your team already runs on Mailshake", "Per-seat cost fits your headcount"] },
  undecided: { title: "Test both before committing", items: ["Self-host InboxJoy free, or try managed with the 30-day guarantee", "Use a small, real list", "Compare setup time and total cost", "Check Mailshake's current trial offer"] },
} as const;

const faqs = [
  ["Is InboxJoy a full Mailshake replacement?", "Not for every team. InboxJoy is focused on email sequences from Gmail and Outlook. If a capability outside that scope — like phone or LinkedIn tasks — is essential, evaluate Mailshake's current plan before switching."],
  ["Which option has the lower starting price?", "Using the public prices cited here, InboxJoy is free to self-host (open source) and has a $79 managed lifetime license paid once, while Mailshake starts at about $29 per user per month. Because Mailshake prices per seat, the gap widens as your team grows. Verify Mailshake's current pricing before purchasing."],
  ["Does InboxJoy support personalization?", "Yes. AI can draft sequences using {{firstName}}, {{company}}, and {{title}} merge tags, so each message reads as written for that specific contact."],
  ["Does InboxJoy charge extra per team member like Mailshake does?", "No. InboxJoy includes unlimited team seats on every plan, so the price stays the same as your team grows. Mailshake is typically priced per user, so confirm its current per-seat cost and any minimum seat requirements before comparing totals."],
  ["Does InboxJoy require a separate sending domain to get started?", "No. InboxJoy connects directly to the Gmail or Outlook mailbox you already use, in one click, with no domain or DNS setup required. Confirm Mailshake's current mailbox setup requirements for your plan."],
  ["Can I manage InboxJoy from Claude or ChatGPT?", "Yes. InboxJoy includes a remote MCP server, so you can review and manage sequences from Claude or ChatGPT in addition to the InboxJoy dashboard. Check Mailshake's current integrations directly if an MCP workflow matters to your team."],
  ["How does InboxJoy's warm-up compare to Mailshake's?", "InboxJoy's warm-up ramp is built in and automatic: new mailboxes start at 8 sends per day and increase by roughly 15% per day, and it can be skipped for mailboxes that are already warmed up. Mailshake commonly offers warm-up as an add-on, so verify its current mechanics and cost."],
  ["Is there a refund if InboxJoy isn't the right fit?", "Yes. The managed lifetime license comes with a 30-day money-back guarantee, and you can self-host for free to test the real workflow first."],
  ["Does InboxJoy support CSV import if I'm moving from Mailshake?", "Yes. Upload a CSV of your existing contact list and InboxJoy maps the fields you need for merge tags and sequencing, so switching doesn't mean re-entering your leads by hand."],
] as const;

export default function MailshakeAlternativePage() {
  return (
    <MarketingPage>
      <PageHero kicker="InboxJoy vs Mailshake" title={<>Best Mailshake<br />Alternative in 2026</>} description="Looking for a Mailshake alternative? InboxJoy is the simpler choice when you want to connect Gmail or Outlook, control sending, and launch sequences without adding a larger sales-engagement workflow.">
        <HeroCta />
      </PageHero>

      <Breadcrumbs crumbs={[["Home", "/"], ["Alternatives", "/alternatives"], ["Mailshake alternative", "/alternatives/mailshake"]]} />

      <section className="v2-section">
        <SectionHeading eyebrow="Mailshake overview" title="Key features of Mailshake" description="A quick look at what Mailshake is generally built around, before comparing it feature by feature with InboxJoy below." />
        <div className="pages-card-grid">
          <article className="pages-info-card"><span>01</span><h3>Multi-channel sequences</h3><p>Mailshake sequences can include phone and social tasks alongside email steps, aimed at teams running a blended outbound motion rather than email alone. That breadth suits reps who already work a call list alongside their inbox.</p></article>
          <article className="pages-info-card"><span>02</span><h3>Per-user pricing</h3><p>Mailshake is typically priced per user rather than per workspace. Verify current per-seat pricing and any minimum seat requirements for your team size, since per-seat models can change the total faster than a flat plan.</p></article>
          <article className="pages-info-card"><span>03</span><h3>Deliverability & analytics dashboards</h3><p>Mailshake includes dashboards for tracking sends, replies, and deliverability signals across a team's sequences, which helps a manager spot a struggling sender before it affects the whole team's reputation.</p></article>
          <article className="pages-info-card"><span>04</span><h3>Sales engagement integrations</h3><p>Mailshake connects to common CRMs so outreach activity can sync back into an existing sales stack. Confirm which integrations are included on your plan before assuming a specific CRM is covered.</p></article>
          <article className="pages-info-card"><span>05</span><h3>Team performance reporting</h3><p>Mailshake includes reporting aimed at sales managers tracking rep activity and results across a team, which can matter more as headcount and channels grow. Verify current reporting depth on your plan tier.</p></article>
        </div>
        <p className="pages-compare-footnote">None of this makes Mailshake better or worse on its own — it's a different bet on where complexity should live. The comparison below shows how that trade-off plays out feature by feature.</p>
      </section>

      <section className="v2-section v2-comparison pages-compare-three">
        <SectionHeading eyebrow="Feature comparison" title="InboxJoy and Mailshake, side by side" description="InboxJoy details below are based on the product today. Competitor plans and packaging can change." />
        <CompareTable competitor="Mailshake" rows={rows} price={price} footer="Start with the workflow you can evaluate directly." />
        <p className="pages-compare-footnote">Mailshake pricing and product details are drawn from its public pricing and product pages and should be verified before purchase because plans change.</p>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Honest fit check" title="Where each tool is strong" description="Neither tool is right for everyone. Here's where InboxJoy tends to win, and where Mailshake's broader sales-engagement workflow may be worth it." />
        <FitCheck competitor="Mailshake" ours={fit.ours} theirs={fit.theirs} />
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Decision" title="Which one should you pick?" description="A quick way to decide without reading every feature row twice." />
        <DecisionCards competitor="Mailshake" ours={decision.ours} theirs={decision.theirs} undecided={decision.undecided} />
      </section>

      <FaqSection items={faqs} title="Mailshake comparison questions" />
      <JsonLd data={faqPageJsonLd(faqs)} />

      <RelatedPages
        eyebrow="Compare more tools"
        title="Compare more tools"
        description="See how InboxJoy stacks up elsewhere, and where it fits into a real outbound workflow."
        links={[
          { href: "/alternatives/instantly", label: "Comparison", title: "InboxJoy vs Instantly", description: "See how InboxJoy compares with Instantly's multi-account, infrastructure-first approach.", cta: "Read the comparison" },
          { href: "/pricing", label: "Pricing", title: "InboxJoy pricing", description: "See the free self-hosted edition, the $79 managed lifetime license, and the 30-day money-back guarantee.", cta: "View pricing" },
          { href: "/use-cases/agencies", label: "Use case", title: "InboxJoy for agencies", description: "See how agencies use InboxJoy to run client outreach without per-seat pricing.", cta: "See the use case" },
        ]}
      />

      <FinalCta title="Try the focused option first" description="Self-host free or get the lifetime license, and assess InboxJoy on a real mailbox." />
      <SiteFooter />
    </MarketingPage>
  );
}
