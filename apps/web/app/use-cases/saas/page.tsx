import type { Metadata } from "next";
import Link from "next/link";
import { CheckList, FaqSection, FinalCta, HeroCta, MarketingPage, PageHero, SectionHeading, SiteFooter } from "../../_pages/site";
import { Breadcrumbs, JsonLd, RelatedPages, faqPageJsonLd, webApplicationJsonLd } from "../../_pages/seo";
import "../../pages.css";

const title = "Cold Email for SaaS | Trials, Demos & Expansion Outreach";
const description =
  "InboxJoy helps B2B SaaS teams run cold email for SaaS outbound — trial follow-up, demo booking, and expansion outreach — with mailbox rotation and bounce intelligence.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: "/use-cases/saas" },
};

const faqs = [
  [
    "How does mailbox rotation help a SaaS team sending a lot of outbound?",
    "Connect as many mailboxes as you need — there is no cap on how many you link — and InboxJoy rotates sends across all of them automatically. The load spreads across every connected mailbox on its own schedule, so an entire quarter's outbound volume across new-logo prospecting, trial follow-up, and expansion never lands on one inbox, and no single inbox becomes a single point of failure.",
  ],
  [
    "What is bounce intelligence, exactly?",
    "Every connected mailbox gets a rolling 7-day bounce rate. InboxJoy flags a mailbox as degraded once that rate reaches 2%, and if it climbs to 5% the mailbox's daily sending limit drops to zero automatically, so a list with bad data on one inbox cannot quietly damage the domain's sending reputation while other campaigns keep running from healthier mailboxes.",
  ],
  [
    "Can we run separate sequences for trial follow-up versus cold outbound to new logos?",
    "Yes. Each sequence is its own AI-drafted flow with its own merge tags and its own imported list, so a trial-activation sequence and a net-new outbound sequence to a completely different segment can run side by side without overlapping copy, timing, or sending caps.",
  ],
  [
    "How do we personalize at the volume a SaaS pipeline needs?",
    "Merge tags like {{firstName}}, {{company}}, and {{title}} pull from your imported CSV so each send reads as written for that person and that account, even across a list built for a specific trigger like a funding round, a job posting, or a review-site signal.",
  ],
  [
    "What happens when a prospect books a demo or replies mid-sequence?",
    "InboxJoy stops the remaining scheduled follow-ups for that contact automatically the moment they reply, so a sales rep can move straight into the demo conversation without a leftover automated step landing in the same thread a few days later.",
  ],
  [
    "Can we multi-thread a buying committee without manually tracking who got which email?",
    "Yes. Each contact runs through their own sequence enrollment, so a technical champion and an economic buyer at the same account can each be on a role-specific sequence, personalized by their own {{title}}, without cross-wiring who received what or when.",
  ],
  [
    "Do we need a CRM or lead database connected to use InboxJoy?",
    "No integration is required to start. Import your list by CSV, through the API, or through InboxJoy's MCP server, and the sequence runs from there — useful for a list built from a signal like a job posting or a funding announcement, whatever tool you sourced it in.",
  ],
  [
    "What does InboxJoy cost for a SaaS team scaling outbound?",
    "InboxJoy is free to self-host (open source). The managed lifetime license is $79, paid once, and includes unlimited team seats, so adding an SDR or AE to the workspace does not add a per-seat cost. It carries a 30-day money-back guarantee.",
  ],
  [
    "Is cold email to business contacts compliant with CAN-SPAM and GDPR?",
    "InboxJoy includes the mechanics that responsible outbound depends on — a real sender address, working reply handling, and hard bounces suppressed workspace-wide — but compliance depends on your own list sourcing, opt-out handling, and the jurisdictions you email into. CAN-SPAM and GDPR obligations vary by how you collected contact data and who you're emailing, so check your specific requirements with your own counsel before a large campaign.",
  ],
  [
    "Can we manage SaaS outbound from tools we already use, like Claude or ChatGPT?",
    "Yes. InboxJoy runs a remote MCP server, so a growth or sales-ops person can check campaign status, review bounce rates per mailbox, or launch a sequence from inside Claude or ChatGPT without switching to a separate dashboard between other work.",
  ],
] as const;

export default function SaasUseCasePage() {
  return (
    <MarketingPage>
      <PageHero kicker="InboxJoy for SaaS" title={<>Cold email for SaaS<br />that survives past the first send.</>} description="B2B SaaS outbound lives or dies on inbox health as much as copy. InboxJoy rotates sends across every connected mailbox and watches bounce rate per mailbox, so trial follow-up, demo booking, competitor-switch outreach, and expansion into existing accounts keep landing, protecting the domain the whole team relies on.">
        <HeroCta />
      </PageHero>

      <Breadcrumbs crumbs={[["Home", "/"], ["Use cases", "/use-cases"], ["SaaS", "/use-cases/saas"]]} />
      <JsonLd data={webApplicationJsonLd({ name: "InboxJoy for SaaS", path: "/use-cases/saas", description })} />

      <section className="v2-section">
        <SectionHeading eyebrow="The SaaS outreach reality" title="B2B SaaS outbound runs on more mailboxes than most teams plan for" description="A single SaaS team is usually running several outbound motions at once — new-logo prospecting, trial follow-up, partner co-marketing, and expansion into accounts that already pay. Each motion wants its own list and its own angle, and every one of them depends on a sender reputation that a single bad list or a single overloaded inbox can quietly wreck for the rest of the team." />
        <div className="pages-card-grid">
          <article className="pages-info-card"><span>01</span><h3>One inbox, too many motions</h3><p>New-logo outbound, trial nudges, partner outreach, and expansion emails often get crammed into the same one or two mailboxes, so sending volume climbs past what a single inbox can carry without risking deliverability for every motion sharing it.</p></article>
          <article className="pages-info-card"><span>02</span><h3>Bad list data hides until it's a problem</h3><p>A purchased list, an old export, or a scraped set of leads can carry a meaningful share of dead addresses. Without per-mailbox bounce visibility, that damage accumulates quietly until the whole domain's sending reputation is already affected, and every campaign pays for it.</p></article>
          <article className="pages-info-card"><span>03</span><h3>Buying committees need more than one thread</h3><p>A SaaS deal rarely closes on one contact. Reaching a technical champion and an economic buyer at the same account, each with a role-appropriate message and its own timing, takes more coordination than a single generic sequence can offer.</p></article>
        </div>
        <div className="v2-section-heading"><p>None of these problems come from a weak product or weak copy. They come from treating outbound volume as a single-mailbox problem long after it stopped being one — which is exactly where mailbox rotation and bounce visibility start to matter.</p></div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Feature fit" title="Rotation and bounce intelligence, built for outbound volume" description="InboxJoy is built around the two things SaaS outbound volume actually needs: enough sending capacity, and a system that protects that capacity automatically as more motions run at once." />
        <div className="pages-split">
          <div className="pages-split-copy"><div className="v2-stripes" /><h3>Spread the load, automatically</h3><p>Connect as many mailboxes as your team has — there's no limit — and InboxJoy rotates sends across all of them on its own. Every mailbox carries its own rolling 7-day bounce rate: flagged degraded at 2%, and cut to a zero daily limit at 5%, so one bad list segment can't take down the mailboxes carrying your other campaigns. A trial-follow-up sequence and a cold new-logo list can share the same pool of mailboxes without ever sharing risk.</p><CheckList items={["Unlimited connected Gmail, Google Workspace, or Outlook mailboxes", "Automatic send rotation across every connected inbox", "Per-mailbox 7-day bounce rate, flagged degraded at 2%", "Sending automatically stopped at a 5% bounce rate"]} /></div>
          <article className="pages-fair-card"><span>Everything else stays in place</span><h3>The mechanics teams already expect</h3><p>AI drafts each sequence, and merge tags like {"{{firstName}}"}, {"{{company}}"}, and {"{{title}}"} personalize sends across a list built from any trigger — a funding round, a job posting, or a trial signup that stalled at a specific step.</p><p>Daily and hourly caps, sending windows, and an 8-send warm-up ramp rising about 15% a day protect a newly connected mailbox, and replies stop the remaining sequence steps automatically so a rep never sends a nudge over the top of a real reply.</p></article>
        </div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="SaaS playbook" title="SaaS cold email ideas that work" description="The strongest SaaS outbound rarely opens with a generic pitch. It opens with a specific trigger — something changed at the account that makes the timing right. Here are the angles that hold up across trial follow-up, new-logo prospecting, partner outreach, and expansion, each with a sample subject line to start from." />
        <div className="pages-card-grid">
          <article className="pages-info-card"><span>01</span><h3>Trial-activation nudge</h3><p>A trial signup stalled before a key step. Reach the original signup's teammates too, with a message about the specific setup step they haven't reached and why it usually matters.</p><p><b>Sample subject:</b> "Quick unblock for {"{{company}}"}'s setup?"</p></article>
          <article className="pages-info-card"><span>02</span><h3>Competitor-switch timing</h3><p>A competitor raised prices, had a public outage, or is getting called out in reviews. Reach accounts that use that tool with a specific, low-pressure, informational comparison ask.</p><p><b>Sample subject:</b> "Saw the {"{{company}}"} team mentioned [competitor]"</p></article>
          <article className="pages-info-card"><span>03</span><h3>Integration-partner outreach</h3><p>A complementary tool's user base overlaps with yours. Lead with a co-marketing angle or a joint workflow, and suggest a specific shared use case up front.</p><p><b>Sample subject:</b> "{"{{company}}"} + us — worth a short call?"</p></article>
          <article className="pages-info-card"><span>04</span><h3>Expansion to an adjacent team</h3><p>One team at an account already pays. Reach an adjacent department using the first team's context as social proof, without overstating results or naming numbers you can't back up.</p><p><b>Sample subject:</b> "Since [team] is already using this at {"{{company}}"}"</p></article>
          <article className="pages-info-card"><span>05</span><h3>Hiring-signal outreach</h3><p>A job posting implies a gap your product closes — a role built around a manual process, for instance. Reference the posting directly and specifically, going beyond a generic "noticed you're hiring" line.</p><p><b>Sample subject:</b> "Saw the [role] posting at {"{{company}}"}"</p></article>
          <article className="pages-info-card"><span>06</span><h3>Renewal-window outreach</h3><p>Time outreach to when a competitor's typical contract cycle renews, or to your prospect's fiscal year start, so a switch conversation lands with real timing behind it, arriving at a moment that actually matters.</p><p><b>Sample subject:</b> "Timing this before your next renewal window"</p></article>
          <article className="pages-info-card"><span>07</span><h3>Review-site signal</h3><p>A prospect requested pricing or left a comparison note on a review site. Reference the specific category they were researching, so the message reads as informed and personal.</p><p><b>Sample subject:</b> "Following up on the [category] research at {"{{company}}"}"</p></article>
          <article className="pages-info-card"><span>08</span><h3>Multi-thread to the economic buyer</h3><p>After a champion goes quiet, reach a second stakeholder with a message framed around their role, using {"{{title}}"} to keep the ask relevant to what they own, adding something new beyond the first email.</p><p><b>Sample subject:</b> "Looping in on {"{{company}}"}'s [initiative]"</p></article>
          <article className="pages-info-card"><span>09</span><h3>Content re-engagement</h3><p>Someone downloaded a guide, used a free tool, or attended a webinar, then went quiet. Reference the specific piece of content by name, so the follow-up feels earned.</p><p><b>Sample subject:</b> "Following up on the [resource] you grabbed"</p></article>
          <article className="pages-info-card"><span>10</span><h3>Funding-signal outreach</h3><p>A prospect account just raised. New budget and new headcount plans often follow — reach the right buyer with a message tied to what usually comes next after a raise.</p><p><b>Sample subject:</b> "Congrats on the round — one thing worth planning for"</p></article>
        </div>
        <div className="v2-section-heading"><p>Every one of these angles works because it's tied to a real signal. The sequence mechanics below — drafting, rotation, and reply handling — exist so that signal-driven outreach can run at the volume a SaaS pipeline actually needs.</p></div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Sample sequence" title="A 3-step SaaS sequence you can adapt" description="A short, specific sequence tied to one trigger — here, a job posting that signals the gap your product closes — built with merge tags so it reads as written for that specific account." />
        <div className="pages-usecase-band">
          <article><b>Step 1 — Day 1</b><h3>Subject: Saw the [role] posting at {"{{company}}"}</h3><p>Hi {"{{firstName}}"}, noticed {"{{company}}"} is hiring for [role] — usually a sign the current process around [pain point] is stretched. We built a way to close that gap without the extra headcount. Worth a 15-minute look?</p></article>
          <article><b>Step 2 — Day 4</b><h3>Subject: One detail on the {"{{company}}"} setup</h3><p>Following up, {"{{firstName}}"}. The part that usually matters most for a team your size is [specific capability] — teams switch mainly to get that piece working without adding a full-time hire. Happy to walk through it whenever it's useful.</p></article>
          <article><b>Step 3 — Day 9</b><h3>Subject: Should I check back later?</h3><p>No worries if now isn't right, {"{{firstName}}"}. If [role] gets filled or priorities shift at {"{{company}}"}, just let me know and I'll follow up when it's better timing, or feel free to reach out first.</p></article>
        </div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="How it works" title="Get a SaaS sequence live" description="Enough setup to protect deliverability at volume, without turning outbound into an infrastructure project the team has to babysit." />
        <div className="pages-usecase-band">
          <article><b>Step 1</b><h3>Connect every mailbox</h3><p>Link each Gmail, Google Workspace, or Outlook address your team sends from — there's no cap on how many, and each one gets its own warm-up ramp and bounce tracking from day one.</p></article>
          <article><b>Step 2</b><h3>Import by trigger</h3><p>Upload a CSV, or pull leads through the API or MCP server, segmented by the signal driving the campaign — a job posting, a funding round, or a stalled trial signup.</p></article>
          <article><b>Step 3</b><h3>Draft and launch</h3><p>Use AI to draft the sequence with merge tags, set sending windows and caps, and let rotation spread the volume across every connected mailbox automatically as the list grows.</p></article>
        </div>
      </section>

      <FaqSection title="SaaS outreach questions" items={faqs} />
      <JsonLd data={faqPageJsonLd(faqs)} />

      <RelatedPages
        eyebrow="More ways teams use InboxJoy"
        title="See the guide built for your outreach"
        links={[
          { href: "/use-cases/recruiting", label: "Use case", title: "For recruiters", description: "Run candidate sourcing and client business development from the same connected mailboxes.", cta: "Explore recruiting outreach" },
          { href: "/use-cases/sales-teams", label: "Use case", title: "For small sales teams", description: "Give each rep's mailbox clear sending limits and a repeatable follow-up rhythm.", cta: "Explore team outreach" },
          { href: "/free-tools/subject-line-checker", label: "Free tool", title: "Subject line checker", description: "Test a SaaS outbound subject line before it goes out to a whole segment.", cta: "Check a subject line" },
        ]}
      />

      <FinalCta title="Give SaaS outbound room to scale" description="Connect every mailbox your team sends from and let rotation and bounce intelligence protect the volume." />
      <SiteFooter />
    </MarketingPage>
  );
}
