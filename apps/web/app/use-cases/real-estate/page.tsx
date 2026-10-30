import type { Metadata } from "next";
import Link from "next/link";
import { CheckList, FaqSection, FinalCta, HeroCta, MarketingPage, PageHero, SectionHeading, SiteFooter } from "../../_pages/site";
import { Breadcrumbs, JsonLd, RelatedPages, faqPageJsonLd, webApplicationJsonLd } from "../../_pages/seo";
import "../../pages.css";

const title = "Real Estate Cold Email | Commercial, Investor & Partner Outreach";
const description =
  "InboxJoy powers B2B real estate outreach — commercial brokers, investors, and property managers reach owners and partners with rotated mailboxes, bounce intelligence, and AI-drafted sequences.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: "/use-cases/real-estate" },
};

const faqs = [
  [
    "Do I need a dedicated domain to send this kind of outreach?",
    "No. InboxJoy connects the Gmail, Google Workspace, or Outlook address you already use in one click, with no DNS record to add and no domain to configure before your first sequence sends to an owner or investor list.",
  ],
  [
    "Our brokerage has several agents — can each one send from their own address?",
    "Yes. Mailboxes are unlimited, so every agent or associate connects their own inbox, and InboxJoy rotates sends across all of them automatically, spreading volume evenly across the team so no single address carries the whole team's send count.",
  ],
  [
    "What is bounce intelligence, and why does it matter for owner and investor lists?",
    "Owner and investor contact records go stale — a title changes hands, an LLC's registered contact updates, an email gets abandoned. InboxJoy tracks each mailbox's bounce rate on a rolling 7-day window, flags it degraded at 2%, and cuts its sending limit to zero at 5%, so a dated list gets caught and contained before it damages a mailbox the rest of the team still relies on for active deals.",
  ],
  [
    "Can I send different sequences to owners, investors, and property managers at once?",
    "Yes. Each sequence is drafted and launched on its own, so an off-market acquisition pitch to owners and a service-partnership outreach to property managers can run in parallel, each with its own list, its own angle, and its own analytics.",
  ],
  [
    "What happens when an owner or partner replies mid-sequence?",
    "InboxJoy stops the remaining scheduled follow-ups for that contact automatically the moment a reply lands, which matters most on time-sensitive deals where a stray follow-up landing after a reply undercuts the conversation just as it's starting.",
  ],
  [
    "Can I control what hours outreach goes out?",
    "Yes. Sending windows are set per mailbox, so outreach to owners or partners in a specific market can follow that market's business hours, even when the sender is working from a different time zone entirely.",
  ],
  [
    "Where does the contact list come from — does InboxJoy pull from the MLS or a CRM?",
    "No. You bring the list. InboxJoy handles sending, rotation, and tracking — import the owners, investors, tenants, or partners you've already researched as a CSV, or bring the list in through the API or MCP server if it lives in another system.",
  ],
  [
    "Can I see which outreach angle is actually getting replies?",
    "Per-step analytics show opens and performance at each stage of a sequence, along with bounce rate and unsubscribe rate, so you can tell whether the lease-expiry angle is outperforming the off-market inquiry before committing a full list to either one.",
  ],
  [
    "What does InboxJoy cost?",
    "InboxJoy is free to self-host (open source). The managed lifetime license is $79, paid once, with no renewals. Team seats are unlimited, so adding another agent to the workspace doesn't add to the bill.",
  ],
  [
    "Are there compliance rules to know before emailing property owners or investors?",
    "Cold email to business and investment contacts is common practice under CAN-SPAM in the US, and InboxJoy suppresses hard bounces and honors unsubscribes workspace-wide to support that. If you're contacting owners, investors, or partners in the EU/UK or another regulated jurisdiction, GDPR and similar rules may govern how that contact data was collected and used — this isn't legal advice, so check your own obligations before a campaign goes out, especially across state or national lines.",
  ],
] as const;

export default function RealEstateUseCasePage() {
  return (
    <MarketingPage>
      <PageHero kicker="InboxJoy for real estate" title={<>Real estate cold email<br />for commercial and investor outreach.</>} description="Commercial brokers, investors, and property managers all run the same core motion: reach an owner or partner directly, at the right moment, from an inbox they'll actually open. InboxJoy handles the sending mechanics — rotation, pacing, and bounce protection — while you bring the deal knowledge.">
        <HeroCta />
      </PageHero>

      <Breadcrumbs crumbs={[["Home", "/"], ["Use cases", "/use-cases"], ["Real estate", "/use-cases/real-estate"]]} />
      <JsonLd data={webApplicationJsonLd({ name: "InboxJoy for Real Estate", path: "/use-cases/real-estate", description })} />

      <section className="v2-section">
        <SectionHeading eyebrow="The real estate reality" title="Every deal starts with reaching one specific person" description="Commercial real estate outreach is rarely a mass campaign — it's a targeted list of owners, investors, or partners who each need a reason tied to their specific property, portfolio, or timeline. The work is finding that reason and getting the email in front of the right inbox before a competing broker does, without the sending mechanics turning into a second job that eats time better spent on the deal itself." />
        <div className="pages-card-grid">
          <article className="pages-info-card"><span>01</span><h3>The list is small and specific</h3><p>An off-market acquisition list or a lease-expiry list is often a few dozen or a few hundred names, each tied to a real, identifiable property and a real timeline.</p></article>
          <article className="pages-info-card"><span>02</span><h3>Timing carries the message</h3><p>A lease-expiry email sent six months early and one sent six months late use the same words but land completely differently. The trigger event matters as much as the copy, sometimes more.</p></article>
          <article className="pages-info-card"><span>03</span><h3>One inbox, several relationship types</h3><p>The same week can call for outreach to a property owner, a capital partner, and a lender or contractor, each expecting a different tone, a different level of detail, and a different ask.</p></article>
        </div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Feature fit" title="Built to protect the inbox your deal flow depends on" description="A broker's or investor's sender reputation is tied to their name and, often, their brokerage's domain. InboxJoy is built to spread volume across the team and catch problems automatically, before they affect that reputation on the deal that matters most." />
        <div className="pages-split">
          <div className="pages-split-copy"><div className="v2-stripes" /><h3>Rotate mailboxes, track bounce rate automatically</h3><p>Connect every mailbox your team sends from — each agent, each partner, each investor relations contact — and InboxJoy rotates sends across all of them automatically. Each mailbox's bounce rate is tracked on a rolling 7-day window: a mailbox is flagged degraded at 2% and has its sending limit cut to zero at 5%, so an outdated owner or investor list doesn't put the rest of the team's sending at risk. That check runs continuously in the background, with no one having to watch a spreadsheet of bounce counts by hand.</p><CheckList items={["Unlimited connected mailboxes across every agent or partner", "Automatic rotation spreads sends across the whole team", "Bounce rate tracked per mailbox on a rolling 7-day window", "Hard bounces suppressed across every connected mailbox, workspace-wide"]} /></div>
          <article className="pages-fair-card"><span>Write for the specific deal</span><h3>AI drafts, you add the property detail</h3><p>AI turns your list and a short brief into a sequence draft, and merge tags like {"{{firstName}}"}, {"{{company}}"}, and {"{{title}}"} carry owner, entity, or role detail through every step, so an outreach list of two hundred owners still reads like it was written property by property.</p><p>Sending windows and per-mailbox daily and hourly caps keep pace controlled, and a newly connected mailbox starts on the warm-up ramp — 8 sends a day, rising roughly 15% a day — unless it's already sending regularly and you skip it. Per-step analytics then show which list and which angle is actually converting into replies.</p></article>
        </div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Real estate outreach playbook" title="9 real estate cold email angles that work" description="B2B real estate outreach lands when the timing and the specifics are right. Each angle below is built around a concrete trigger — a lease, a filing, a portfolio move — the kind of specific detail that makes an owner read past the first line." />
        <div className="pages-card-grid">
          <article className="pages-info-card"><span>01</span><h3>Lease-expiry timing</h3><p>Reach a tenant or their broker several months ahead of a known lease expiration, when renewal, relocation, and renegotiation are all still open questions and no decision has locked in yet.</p><p><b>Sample subject:</b> "{"{{company}}"}'s lease options before renewal"</p></article>
          <article className="pages-info-card"><span>02</span><h3>Off-market acquisition inquiry</h3><p>Approach an owner directly about a property that isn't listed, framing the email around that specific property and its situation.</p><p><b>Sample subject:</b> "Interested in [property address], if you'd consider it"</p></article>
          <article className="pages-info-card"><span>03</span><h3>Investor deal-flow update</h3><p>Keep a standing investor list informed on new acquisition opportunities as they come up, so the first call on a fresh deal goes to someone who is already warmed up and paying attention.</p><p><b>Sample subject:</b> "A new opportunity for {"{{firstName}}"}'s portfolio"</p></article>
          <article className="pages-info-card"><span>04</span><h3>Property-manager service partnership</h3><p>Pitch a management, maintenance, or leasing service directly to a property manager handling a portfolio that matches your service area and property type.</p><p><b>Sample subject:</b> "A fit for {"{{company}}"}'s managed properties"</p></article>
          <article className="pages-info-card"><span>05</span><h3>Ownership-change trigger</h3><p>A recent transfer, refinance, or entity change on public record often means new decision-makers are actively reassessing a property's plan in the first few months of ownership.</p><p><b>Sample subject:</b> "Congrats on the {"{{company}}"} acquisition"</p></article>
          <article className="pages-info-card"><span>06</span><h3>Portfolio-expansion trigger</h3><p>An investor or fund that just closed on one property in a market is often actively looking for the next one — reach out while that search is still active.</p><p><b>Sample subject:</b> "Saw {"{{company}}"}'s latest acquisition"</p></article>
          <article className="pages-info-card"><span>07</span><h3>Lender or capital-partner outreach</h3><p>Introduce a deal or a lending relationship directly to a lender or capital partner whose stated focus matches the property type, market, and deal size.</p><p><b>Sample subject:</b> "A deal that fits {"{{company}}"}'s lending focus"</p></article>
          <article className="pages-info-card"><span>08</span><h3>Contractor or vendor partnership</h3><p>Propose a standing relationship to a contractor or vendor serving a property type you manage or broker regularly, framed around a recurring need.</p><p><b>Sample subject:</b> "A recurring fit for {"{{company}}"}'s crew"</p></article>
          <article className="pages-info-card"><span>09</span><h3>Vacancy or distress signal</h3><p>Public vacancy data, a distressed filing, or a stalled development are all signals that an owner may be more open to a conversation right now than they would be otherwise.</p><p><b>Sample subject:</b> "A thought on {"{{company}}"}'s vacant space"</p></article>
        </div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Sample sequence" title="A 3-step real estate sequence, written out" description="Built around the off-market acquisition angle above, moving from interest to a specific ask without pressure, and leaving room for the owner to come back on their own timeline." />
        <div className="pages-usecase-band">
          <article><b>Step 1 · Day 0</b><h3>Interested in [property address], if you'd consider it</h3><p>"Hi {"{{firstName}}"} — I work with buyers active in [submarket] and wanted to reach out directly about [property address]. I know it's not listed. If there's ever a point where {"{{company}}"} would consider an offer, I'd welcome the conversation."</p></article>
          <article><b>Step 2 · Day 4</b><h3>A number, if it helps the conversation</h3><p>"Following up, {"{{firstName}}"} — happy to share what similar properties in the area have traded for recently, no obligation either way. Just useful context if {"{{company}}"} is weighing options."</p></article>
          <article><b>Step 3 · Day 9</b><h3>Leaving the door open</h3><p>"I'll leave this here for now, {"{{firstName}}"}. If {"{{company}}"}'s plans for the property change down the line, I'd still welcome a conversation whenever the timing works."</p></article>
        </div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="How it works" title="From owner list to first replies" description="A short setup, built for a broker, investor, or property team with a specific list ready to go and little time to spend configuring a new tool." />
        <div className="pages-card-grid">
          <article className="pages-step-card"><span>01</span><h3>Connect your inbox</h3><p>Link the Gmail, Google Workspace, or Outlook address you already send from, and add each agent's or partner's mailbox the same way — one click, no DNS setup, no domain change to coordinate.</p></article>
          <article className="pages-step-card"><span>02</span><h3>Import your list</h3><p>Upload a CSV of owners, investors, tenants, or partners you've already researched, or bring the list in through the API or MCP server if it lives somewhere else.</p></article>
          <article className="pages-step-card"><span>03</span><h3>Draft, launch, and let rotation work</h3><p>AI drafts the sequence with your merge tags in place. Set sending windows and caps, then rotation and bounce intelligence manage delivery across every connected mailbox while replies stop the sequence automatically and analytics track which angle is working.</p></article>
        </div>
      </section>

      <FaqSection title="Real estate outreach questions" items={faqs} />
      <JsonLd data={faqPageJsonLd(faqs)} />

      <RelatedPages
        eyebrow="More ways teams use InboxJoy"
        title="See the guide built for your team shape"
        links={[
          { href: "/use-cases/consulting", label: "Use case", title: "For consulting", description: "Reach prospects with an insight-led sequence backed by the same rotation and bounce protection.", cta: "Explore consulting outreach" },
          { href: "/use-cases/founders", label: "Use case", title: "For founders", description: "Turn firsthand market knowledge into a focused sequence without becoming a full-time sales operator.", cta: "Explore founder outreach" },
          { href: "/free-tools/spam-word-checker", label: "Free tool", title: "Spam word checker", description: "Scan a draft for language that risks the spam folder before it reaches an owner's inbox.", cta: "Check your copy" },
        ]}
      />

      <FinalCta title="Reach the next owner or partner before another broker does" description="Connect your inbox and turn your target list into a sequence that runs itself." />
      <SiteFooter />
    </MarketingPage>
  );
}
