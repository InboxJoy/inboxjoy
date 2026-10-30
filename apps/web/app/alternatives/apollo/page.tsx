import type { Metadata } from "next";
import Link from "next/link";
import { FaqSection, FinalCta, HeroCta, MarketingPage, PageHero, SectionHeading, SiteFooter } from "../../_pages/site";
import { CompareTable, DecisionCards, FitCheck } from "../../_pages/compare";
import { Breadcrumbs, JsonLd, RelatedPages, faqPageJsonLd } from "../../_pages/seo";
import "../../pages.css";

const title = "Best Apollo Alternative in 2026";
const description =
  "Comparing InboxJoy vs Apollo.io? See pricing, sending features, and how the two pair together to find the right outreach setup for 2026.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: "/alternatives/apollo" },
};

const rows = [
  ["Core focus", "Sending intelligence & mailbox protection", "B2B contact database & enrichment"],
  ["Contact database & enrichment", "Not offered", "Core feature"],
  ["Dialer", "Not offered", "Included"],
  ["CRM / deal pipeline", "Not offered", "Included"],
  ["Mailbox rotation & bounce intelligence", "Automatic, built into every plan", "Verify current sending features"],
  ["CSV, API & MCP lead import", "Included, from any source including Apollo exports", "Verify current export options"],
  ["AI sequence drafting", "Included with merge tags", "Included"],
  ["Manage from Claude & ChatGPT (MCP)", "Built in", "Verify current integrations"],
  ["Team seats", "Unlimited on every plan", "Verify current plan"],
] as const;

const price = ["$79 once (lifetime)", "$59/user/month"] as const;

const fit = {
  ours: {
    title: "Where InboxJoy is strong",
    intro: "InboxJoy is built entirely around getting email delivered safely once you already have a list, whether it came from Apollo, a CSV, or anywhere else.",
    items: ["Unlimited mailboxes with automatic rotation", "Bounce intelligence auto-throttles before damage happens", "CSV, API, and MCP import for any list", "One-click Gmail, Workspace, or Outlook connection", "AI-drafted sequences with merge tags", "Manage campaigns from Claude or ChatGPT"],
  },
  theirs: {
    title: "Finding contacts and running your whole motion in one place",
    intro: "Apollo's searchable database and enrichment can be the faster starting point when you don't have a list yet, with calling and light CRM in the same platform.",
    items: ["Searchable B2B contact database and enrichment", "Sequencing built directly on the database", "Built-in dialer and CRM-style deal tracking", "Broad integrations and a browser extension"],
  },
} as const;

const decision = {
  ours: { title: "You already have leads and need to send safely", items: ["You already have a lead list", "Want mailbox rotation and bounce protection", "Manage sequences from Claude or ChatGPT"] },
  theirs: { title: "You need to build the list first", items: ["No contact list yet, need to build one", "Want database, enrichment, dialer, and CRM", "Compare Apollo's credit and seat pricing"] },
  undecided: { title: "Data from one, sending from the other", items: ["Build and enrich your list in Apollo", "Export via CSV, API, or MCP", "Run sequences through InboxJoy at scale"] },
} as const;

const faqs = [
  ["Does InboxJoy have a contact database like Apollo?", "No. InboxJoy does not include a contact database, enrichment, or a prospecting search tool. It imports leads you already have, or that you find elsewhere, through CSV upload, API, or its remote MCP server. If you need to build a list from scratch, Apollo's database is built for that."],
  ["Can I import my Apollo leads into InboxJoy?", "Yes. Export your Apollo contacts to CSV and import them into InboxJoy, or push them in through the API or MCP server if you're managing lists programmatically. Many teams use Apollo to find and enrich contacts, then run the actual sending through a dedicated tool like InboxJoy."],
  ["Does InboxJoy include a dialer or CRM like Apollo?", "No. InboxJoy is focused on email sequences and mailbox management. If your workflow depends on a dialer or CRM-style pipeline in the same tool as your email sending, Apollo's bundled feature set is built for that."],
  ["Which product is less expensive to start?", "Using InboxJoy's public pricing, you can self-host it for free (open source), and the managed lifetime license is $79 paid once, with unlimited team seats. Apollo's plans are generally structured around database credits, seats, and feature tiers, so check their pricing page for current plans before comparing totals."],
  ["Why would a team use both Apollo and InboxJoy?", "Apollo's core value is data: finding and enriching contacts. InboxJoy's core value is sending intelligence: mailbox rotation and bounce protection that keep deliverability healthy as volume grows. Some teams use Apollo to build and enrich a list, then export it into InboxJoy to run the actual outreach with dedicated mailbox protection."],
  ["Does InboxJoy protect mailbox reputation the way a dedicated sending tool should?", "Yes. InboxJoy tracks each connected mailbox's 7-day bounce rate, flags it as degraded at 2%+, and drops its daily sending limit to zero at 5%+, so a bad list or a bad mailbox doesn't put your whole domain at risk. Confirm what deliverability safeguards, if any, apply to Apollo's own sending feature."],
  ["Can InboxJoy stop a sequence automatically when someone replies?", "Yes. Replies are detected automatically and stop later follow-up steps for that contact, so no one keeps receiving emails after they've already responded."],
  ["Does InboxJoy require a separate sending domain or DNS setup?", "No. InboxJoy connects directly to the Gmail, Google Workspace, or Outlook mailbox you already use, in one click, with no domain or DNS configuration required."],
  ["Can I manage InboxJoy campaigns from Claude or ChatGPT?", "Yes. InboxJoy includes a remote MCP server, so you can review sequences, check bounce rates, and manage campaigns from Claude or ChatGPT in addition to the InboxJoy dashboard. Verify whether Apollo offers an equivalent integration for its sending feature."],
] as const;

export default function ApolloAlternativePage() {
  return (
    <MarketingPage>
      <PageHero kicker="InboxJoy vs Apollo" title={<>Best Apollo<br />Alternative in 2026</>} description="Looking for an Apollo alternative for sending, or a way to pair the two? Apollo centers on a B2B contact database with sequencing built on top. InboxJoy centers on sending intelligence — mailbox rotation and bounce protection — for whatever list you bring it.">
        <HeroCta />
      </PageHero>

      <Breadcrumbs crumbs={[["Home", "/"], ["Alternatives", "/alternatives"], ["Apollo alternative", "/alternatives/apollo"]]} />

      <section className="v2-section">
        <SectionHeading eyebrow="Apollo overview" title="Key features of Apollo" description="A quick look at what Apollo.io is generally built around, before comparing it feature by feature with InboxJoy below." />
        <div className="pages-card-grid">
          <article className="pages-info-card"><span>01</span><h3>B2B contact database</h3><p>Apollo's core product is a large, searchable database of B2B contacts and companies, letting teams find and filter prospects by role, industry, company size, and other firmographic data before ever drafting an email.</p></article>
          <article className="pages-info-card"><span>02</span><h3>Contact & company enrichment</h3><p>Beyond search, Apollo enriches existing records with additional firmographic and contact data, which helps teams fill gaps in a list they already have.</p></article>
          <article className="pages-info-card"><span>03</span><h3>Sequencing built on the database</h3><p>Apollo layers email sequencing on top of its contact data, so teams can move from finding a prospect to emailing them inside the same platform, without exporting to a separate sending tool.</p></article>
          <article className="pages-info-card"><span>04</span><h3>Dialer & CRM-style features</h3><p>Apollo also includes a built-in dialer and deal or pipeline tracking, aimed at teams that want prospecting, calling, and light CRM functionality bundled with their outreach in one place.</p></article>
          <article className="pages-info-card"><span>05</span><h3>Broad integrations</h3><p>Apollo connects with common CRMs and sales tools, and offers a browser extension for capturing contact data while prospecting elsewhere on the web. Confirm current integration depth on its site for your stack.</p></article>
        </div>
        <p className="pages-compare-footnote">None of this makes Apollo better or worse on its own — it's a different starting point: data-first with sending attached, versus sending-first with your own data imported. The comparison below shows how that trade-off plays out feature by feature.</p>
      </section>

      <section className="v2-section v2-comparison pages-compare-three">
        <SectionHeading eyebrow="Feature comparison" title="InboxJoy and Apollo, side by side" description="This table keeps InboxJoy claims specific and flags competitor details that require a current plan check." />
        <CompareTable competitor="Apollo" rows={rows} price={price} footer="Decide whether you need a database, a sending tool, or both." />
        <p className="pages-compare-footnote">Apollo pricing and product details are drawn from its public pricing and product pages and should be verified before purchase because plans and credit structures change.</p>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Honest fit check" title="Where each tool is strong" description="These tools solve different problems more than they compete head-on. Here's where each one genuinely earns its place." />
        <FitCheck competitor="Apollo" ours={fit.ours} theirs={fit.theirs} />
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Decision" title="Which one should you pick?" description="For many teams, this isn't strictly either-or. Here's how to think about it." />
        <DecisionCards competitor="Apollo" ours={decision.ours} theirs={decision.theirs} undecided={decision.undecided} />
      </section>

      <FaqSection items={faqs} title="Apollo comparison questions" />
      <JsonLd data={faqPageJsonLd(faqs)} />

      <RelatedPages
        eyebrow="Compare more tools"
        title="Compare more tools"
        description="See how InboxJoy stacks up elsewhere, and where it fits into a real outbound workflow."
        links={[
          { href: "/alternatives/woodpecker", label: "Comparison", title: "InboxJoy vs Woodpecker", description: "See how InboxJoy's built-in deliverability compares with Woodpecker's condition-based campaigns and add-ons.", cta: "Read the comparison" },
          { href: "/alternatives/mailshake", label: "Comparison", title: "InboxJoy vs Mailshake", description: "See how InboxJoy compares with Mailshake's per-user sales engagement pricing and workflow.", cta: "Read the comparison" },
          { href: "/pricing", label: "Pricing", title: "InboxJoy pricing", description: "See the free self-hosted edition, the $79 managed lifetime license, and the 30-day money-back guarantee.", cta: "View pricing" },
        ]}
      />

      <FinalCta title="Bring your list, send it safely" description="Import from Apollo, CSV, API, or MCP, and let InboxJoy's mailbox rotation and bounce intelligence protect your domains." />
      <SiteFooter />
    </MarketingPage>
  );
}
