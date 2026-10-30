import type { Metadata } from "next";
import Link from "next/link";
import { FaqSection, FinalCta, HeroCta, MarketingPage, PageHero, SectionHeading, SiteFooter } from "../../_pages/site";
import { CompareTable, DecisionCards, FitCheck } from "../../_pages/compare";
import { Breadcrumbs, JsonLd, RelatedPages, faqPageJsonLd } from "../../_pages/seo";
import "../../pages.css";

const title = "Best Woodpecker Alternative in 2026";
const description =
  "Comparing InboxJoy vs Woodpecker? See pricing, deliverability tools, and built-in mailbox rotation to find the right cold email alternative for 2026.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: "/alternatives/woodpecker" },
};

const rows = [
  ["Manage from Claude & ChatGPT (MCP)", "Built in", "Verify current integrations"],
  ["Self-host option", "Free, open source (AGPL-3.0)", "Verify current offer"],
  ["Mailbox rotation across inboxes", "Automatic, built into every plan", "Confirm current rotation setup"],
  ["Bounce intelligence", "Tracks 7-day bounce rate per mailbox, auto-throttles at 2%+, stops at 5%+", "Verify current deliverability tooling"],
  ["Warm-up behavior", "Automatic ramp from 8/day, skippable, built in", "Available as an add-on; confirm current mechanics and cost"],
  ["Campaign logic", "AI-drafted sequences with merge tags", "Condition-based branching (opens, clicks, replies)"],
  ["Agency / multi-client management", "Not a dedicated feature", "Dedicated agency panel"],
  ["Mailbox connection", "Gmail + Outlook, one click", "Verify current setup requirements"],
  ["Team seats", "Unlimited on every plan", "Verify current plan"],
] as const;

const price = ["$79 once (lifetime)", "$7 per 100 prospects/month"] as const;

const fit = {
  ours: {
    title: "Where InboxJoy is strong",
    intro: "InboxJoy treats mailbox protection as core product, so the deliverability safety net is active from the first mailbox you connect.",
    items: ["Automatic rotation across every connected mailbox", "Bounce intelligence auto-throttles before damage happens", "One-click Gmail, Workspace, or Outlook connection", "Automatic warm-up ramp included on every plan", "AI-drafted sequences with merge tags", "MCP access from Claude or ChatGPT, unlimited seats"],
  },
  theirs: {
    title: "Condition-based logic and agency management",
    intro: "A fit when branching campaigns or managing many client accounts matters more than a bundled, single-workspace setup.",
    items: ["Condition-based branching on opens, clicks, replies", "A dedicated agency panel for multiple client accounts", "Warm-up and rotation available as configurable add-ons", "An established setup if it's already configured and working"],
  },
} as const;

const decision = {
  ours: { title: "You want deliverability protection built in", items: ["Rotation, warm-up, and bounce protection by default", "Nothing to assemble from separate add-ons", "Trigger or monitor sequences via remote MCP"] },
  theirs: { title: "You need branching logic or agency tooling", items: ["Campaigns depend on open/click/reply branching", "You manage several client accounts as an agency", "You want a dedicated multi-client panel"] },
  undecided: { title: "Test both before committing", items: ["Self-host InboxJoy free, or try managed with the 30-day guarantee", "Use a real, small list", "Weigh built-in protection against Woodpecker's trial"] },
} as const;

const faqs = [
  ["Does InboxJoy offer the same condition-based branching as Woodpecker?", "Not in the same way. InboxJoy sequences run on timed follow-up steps that stop automatically when someone replies, with AI-drafted copy and merge tags. Woodpecker is known for condition-based logic that branches a campaign based on opens, clicks, or replies. If branching logic is the deciding factor, Woodpecker's current campaign builder is worth testing directly."],
  ["Is mailbox rotation included on InboxJoy, or is it an add-on?", "Rotation is built into every InboxJoy plan. Sends distribute automatically across your connected inboxes, and bounce intelligence tracks each mailbox's 7-day bounce rate, flags it as degraded at 2%+, and drops its daily limit to zero at 5%+ to protect your domains. Confirm on Woodpecker's current pricing page whether rotation and warm-up ship standard or as paid add-ons."],
  ["Does InboxJoy have anything like Woodpecker's agency panel?", "No. InboxJoy is built around a single workspace with unlimited team seats. Agencies managing many separate client accounts from one login should check whether Woodpecker's current agency tooling fits that workflow better."],
  ["Which product is less expensive to start?", "Using InboxJoy's public pricing, you can self-host it for free (open source), and the managed lifetime license is $79 paid once, with unlimited team seats included. Woodpecker's current pricing should be checked on its own pricing page, since plans, add-on costs, and agency tiers can change."],
  ["Can InboxJoy stop a sequence automatically when someone replies?", "Yes. Replies are detected automatically and stop later follow-up steps for that contact, so no one keeps receiving emails after they've already responded."],
  ["Does InboxJoy require a separate sending domain or DNS setup?", "No. InboxJoy connects directly to the Gmail, Google Workspace, or Outlook mailbox you already use, in one click, with no domain or DNS configuration required."],
  ["Can I manage InboxJoy campaigns from Claude or ChatGPT?", "Yes. InboxJoy includes a remote MCP server, so you can review sequences, check bounce rates, and manage campaigns from Claude or ChatGPT in addition to the InboxJoy dashboard. Confirm whether Woodpecker offers an equivalent integration."],
  ["How does warm-up work on InboxJoy?", "New mailboxes start warm-up at 8 sends per day and increase by roughly 15% per day automatically, and warm-up can be skipped for mailboxes that are already warmed up elsewhere. This is included on every plan, with no separate warm-up product to configure."],
  ["Is there a refund if InboxJoy isn't the right fit?", "Yes. The managed lifetime license comes with a 30-day money-back guarantee, and you can self-host for free to test bounce intelligence and mailbox rotation on a real mailbox first."],
] as const;

export default function WoodpeckerAlternativePage() {
  return (
    <MarketingPage>
      <PageHero kicker="InboxJoy vs Woodpecker" title={<>Best Woodpecker<br />Alternative in 2026</>} description="Looking for a Woodpecker alternative? InboxJoy builds mailbox rotation and bounce intelligence into every plan, so you get deliverability protection without assembling separate warm-up and rotation add-ons.">
        <HeroCta />
      </PageHero>

      <Breadcrumbs crumbs={[["Home", "/"], ["Alternatives", "/alternatives"], ["Woodpecker alternative", "/alternatives/woodpecker"]]} />

      <section className="v2-section">
        <SectionHeading eyebrow="Woodpecker overview" title="Key features of Woodpecker" description="A quick look at what Woodpecker is generally built around, before comparing it feature by feature with InboxJoy below." />
        <div className="pages-card-grid">
          <article className="pages-info-card"><span>01</span><h3>Condition-based campaigns</h3><p>Woodpecker is known for campaign logic that branches based on whether a prospect opened, clicked, or replied, letting a sequence adapt its path depending on how someone engages with each step.</p></article>
          <article className="pages-info-card"><span>02</span><h3>Deliverability focus</h3><p>Woodpecker has built a reputation around deliverability, with tools aimed at keeping sending patterns healthy for small B2B teams and agencies running cold outreach on a regular basis.</p></article>
          <article className="pages-info-card"><span>03</span><h3>Agency panel</h3><p>A dedicated agency view lets teams manage multiple client accounts from one login, which matters for agencies running outbound on behalf of several clients at once.</p></article>
          <article className="pages-info-card"><span>04</span><h3>Warm-up & rotation add-ons</h3><p>Warm-up and inbox rotation are commonly offered as separate add-ons alongside the core plan. Confirm current pricing and mechanics for these on Woodpecker's site, since add-on structures tend to change more often than base plans.</p></article>
          <article className="pages-info-card"><span>05</span><h3>Integrations & reporting</h3><p>Woodpecker connects to common CRMs and reports on campaign performance. Confirm what level of per-step and deliverability reporting is included on your intended plan before relying on it for optimization decisions.</p></article>
        </div>
        <p className="pages-compare-footnote">None of this makes Woodpecker better or worse on its own — it's a different bet on where deliverability tooling should live: bundled in, or added on. The comparison below shows how that trade-off plays out feature by feature.</p>
      </section>

      <section className="v2-section v2-comparison pages-compare-three">
        <SectionHeading eyebrow="Feature comparison" title="InboxJoy and Woodpecker, side by side" description="This table keeps InboxJoy claims specific and flags competitor details that require a current plan check." />
        <CompareTable competitor="Woodpecker" rows={rows} price={price} footer="Evaluate the deliverability setup you'll actually maintain long-term." />
        <p className="pages-compare-footnote">Woodpecker pricing and product details are drawn from its public pricing and product pages and should be verified before purchase because plans and add-ons change.</p>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Honest fit check" title="Where each tool is strong" description="Neither tool is right for everyone. Here's where InboxJoy tends to win, and where Woodpecker's approach may be worth considering." />
        <FitCheck competitor="Woodpecker" ours={fit.ours} theirs={fit.theirs} />
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Decision" title="Which one should you pick?" description="A quick way to decide without reading every feature row twice." />
        <DecisionCards competitor="Woodpecker" ours={decision.ours} theirs={decision.theirs} undecided={decision.undecided} />
      </section>

      <FaqSection items={faqs} title="Woodpecker comparison questions" />
      <JsonLd data={faqPageJsonLd(faqs)} />

      <RelatedPages
        eyebrow="Compare more tools"
        title="Compare more tools"
        description="See how InboxJoy stacks up elsewhere, and where it fits into a real outbound workflow."
        links={[
          { href: "/alternatives/apollo", label: "Comparison", title: "InboxJoy vs Apollo", description: "See how InboxJoy's sending intelligence compares with Apollo's contact database and sales tooling.", cta: "Read the comparison" },
          { href: "/alternatives/mailshake", label: "Comparison", title: "InboxJoy vs Mailshake", description: "See how InboxJoy compares with Mailshake's per-user sales engagement pricing and workflow.", cta: "Read the comparison" },
          { href: "/pricing", label: "Pricing", title: "InboxJoy pricing", description: "See the free self-hosted edition, the $79 managed lifetime license, and the 30-day money-back guarantee.", cta: "View pricing" },
        ]}
      />

      <FinalCta title="Start with deliverability built in" description="Get the lifetime license, or self-host free, and see automatic rotation and bounce intelligence protect your mailboxes from day one." />
      <SiteFooter />
    </MarketingPage>
  );
}
