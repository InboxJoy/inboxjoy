import type { Metadata } from "next";
import Link from "next/link";
import { CheckList, FaqSection, FinalCta, HeroCta, MarketingPage, PageHero, SectionHeading, SiteFooter } from "../../_pages/site";
import { Breadcrumbs, JsonLd, RelatedPages, faqPageJsonLd, webApplicationJsonLd } from "../../_pages/seo";
import "../../pages.css";

const title = "Cold Email for Consultants | Win Clients With Expertise-Led Outreach";
const description =
  "InboxJoy helps independent consultants and boutique firms run expertise-led cold email — AI-drafted sequences, mailbox rotation, and bounce intelligence protecting deliverability from day one.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: "/use-cases/consulting" },
};

const faqs = [
  [
    "Do I need a separate outreach inbox, or can I send from my own consulting address?",
    "You send from the address you already use. InboxJoy connects Gmail, Google Workspace, or Outlook in one click, with no DNS record to add and no domain to configure before your first sequence goes out — the same inbox your clients already recognize.",
  ],
  [
    "We're a small partner-led firm — can we connect more than one mailbox?",
    "Yes. Mailboxes are unlimited, so every partner can connect their own address — including a mailbox used only for a specific fractional engagement — and InboxJoy rotates sends across all of them automatically, spreading volume evenly.",
  ],
  [
    "What is bounce intelligence, and why does it matter for a consulting practice?",
    "InboxJoy tracks each connected mailbox's bounce rate on a rolling 7-day window. A mailbox is flagged degraded at 2% and has its sending limit cut to zero at 5%, so a stale list segment gets caught and contained before it damages a reputation you've spent years building or quietly drags down every mailbox in the workspace.",
  ],
  [
    "Will the AI-drafted sequence actually sound like my own voice?",
    "AI drafts the sequence from your brief as a starting point, and you review and edit it before anything sends — trimming jargon, adding a specific detail, or tightening the ask to match how you actually talk to a client. Merge tags like {{firstName}}, {{company}}, and {{title}} carry the specifics you provide through every step, so the finished draft still reflects your own read on the prospect.",
  ],
  [
    "What happens when a prospect replies partway through a sequence?",
    "InboxJoy stops the remaining scheduled follow-ups for that contact automatically the moment a reply lands, so a real conversation can start right away, without a scheduled nudge arriving on top of it a day later and making the outreach look automated.",
  ],
  [
    "Can I see which angle is actually landing with prospects?",
    "Per-step analytics show opens and performance at each stage of a sequence, along with bounce rate and unsubscribe rate, so you can tell whether the trigger-event angle is outperforming the case-study follow-up before you commit a full quarter's list to one approach.",
  ],
  [
    "Can I import a list segmented by trigger event, like a recent leadership hire?",
    "Yes. Upload a CSV, or bring leads in through the API or the remote MCP server if your research already lives in another tool — InboxJoy maps the fields into your sequence and keeps each segment as its own list, without manual re-entry.",
  ],
  [
    "What does InboxJoy cost?",
    "InboxJoy is free to self-host (open source). The managed lifetime license is $79, paid once, with no subscription. Team seats are unlimited, so adding a partner or associate doesn't change the price.",
  ],
  [
    "Can I check on a campaign without opening a dashboard between client calls?",
    "Yes. InboxJoy runs a remote MCP server, so you can check a sequence's status, review analytics, or adjust a step from inside Claude or ChatGPT between meetings, with no separate tab to keep open during a busy week.",
  ],
  [
    "Are there compliance rules I need to follow for cold email outreach?",
    "Cold email to business contacts is common practice under CAN-SPAM in the US, and InboxJoy suppresses hard bounces and honors unsubscribes workspace-wide to support that. If you're emailing contacts in the EU/UK or other regulated jurisdictions, GDPR and similar rules may apply to how you collect and use contact data — this isn't legal advice, so check your own obligations before running a campaign, especially across borders.",
  ],
] as const;

export default function ConsultingUseCasePage() {
  return (
    <MarketingPage>
      <PageHero kicker="InboxJoy for consultants" title={<>Cold email for consultants<br />that leads with your expertise.</>} description="You've solved this exact problem before, more than once. InboxJoy helps independent consultants and boutique firms turn that track record into a focused cold email sequence, sent from your own inbox, with rotation and bounce intelligence protecting it as volume grows.">
        <HeroCta />
      </PageHero>

      <Breadcrumbs crumbs={[["Home", "/"], ["Use cases", "/use-cases"], ["Consulting", "/use-cases/consulting"]]} />
      <JsonLd data={webApplicationJsonLd({ name: "InboxJoy for Consulting", path: "/use-cases/consulting", description })} />

      <section className="v2-section">
        <SectionHeading eyebrow="The consulting reality" title="Your best marketing is a conversation you haven't started yet" description="A consultant's product is judgment, and judgment is hard to advertise. Referrals cover the quiet months when they come, but they leave gaps that only outbound can fill — and a consulting inbox gets read against a higher bar than most, because the entire pitch is 'trust my expertise,' and a generic opener undercuts that claim in the first line. The prospects who would benefit most from your read on their situation are often the ones who have never heard your name." />
        <div className="pages-card-grid">
          <article className="pages-info-card"><span>01</span><h3>Referrals only go so far</h3><p>Depending purely on referrals leaves the pipeline invisible in a slow month. A fractional exec, a boutique strategy shop, or a solo IT consultant still needs a way to proactively reach the prospect who has never heard of them.</p></article>
          <article className="pages-info-card"><span>02</span><h3>Generic outreach undersells expertise</h3><p>A templated pitch reads like the dozen other cold emails already in that inbox. A consultant's credibility depends on the first line proving real familiarity with the prospect's actual situation, and that proof has to show up before the ask does.</p></article>
          <article className="pages-info-card"><span>03</span><h3>One practice, several audiences</h3><p>A boutique firm might pitch a fractional-exec engagement to one company and a scoped audit to another in the same week, and each needs its own list, its own angle, and its own follow-up rhythm to stay credible.</p></article>
        </div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Feature fit" title="Built to protect a reputation you can't rebuild overnight" description="Most consultants send under a name people already associate with the work. InboxJoy is built around that: spreading volume across every connected mailbox and watching each one's health automatically, so growth in outreach volume never comes at the cost of deliverability." />
        <div className="pages-split">
          <div className="pages-split-copy"><div className="v2-stripes" /><h3>Rotate mailboxes, track bounce rate automatically</h3><p>InboxJoy connects every mailbox you and your partners send from — your own address, a partner's, a fractional identity for a specific engagement — and rotates sends across all of them. Each mailbox's 7-day bounce rate is tracked continuously: InboxJoy flags a mailbox degraded at 2% and cuts its sending limit to zero at 5%, so one outdated list segment never puts the whole practice's deliverability at risk. That protection runs in the background on every send, with no manual review required to catch a mailbox before it becomes a problem.</p><CheckList items={["Unlimited connected mailboxes, one click each", "Automatic rotation spreads sends across your whole team", "Bounce rate tracked per mailbox on a rolling 7-day window", "Hard bounces suppressed across every connected mailbox, workspace-wide"]} /></div>
          <article className="pages-fair-card"><span>Write like you already know them</span><h3>AI drafts, you add the expertise</h3><p>AI turns a target list and a short brief into a sequence draft, and merge tags like {"{{firstName}}"}, {"{{company}}"}, and {"{{title}}"} carry the specifics through every step, so fifty prospects each get a version that reads like it was written for them individually.</p><p>Sending windows and per-mailbox daily and hourly caps keep the pace controlled, and a newly connected mailbox starts on the warm-up ramp — 8 sends a day, rising roughly 15% a day — unless it's already sending regularly and you choose to skip it. Per-step analytics then show where a sequence gains or loses attention, so the next list benefits from what the last one taught you.</p></article>
        </div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Consulting outreach playbook" title="10 cold email angles for consultants" description="The subject line has to prove, in a handful of words, that this email started from something specific about the prospect — a hire, a case study, a stalled initiative — because that specificity is most of what a consultant is selling. Generic outreach reads like generic advice, and generic advice is the one thing prospects assume they can get for free." />
        <div className="pages-card-grid">
          <article className="pages-info-card"><span>01</span><h3>Insight-led teardown</h3><p>Open with one specific observation about something public — a pricing page, a recent job posting, a line from an earnings call — that shows you looked closely before asking for anything. The observation does the work a resume normally would.</p><p><b>Sample subject:</b> "One thing I noticed on {"{{company}}"}'s pricing page"</p></article>
          <article className="pages-info-card"><span>02</span><h3>New-hire trigger</h3><p>A new leader in your specialty area is actively re-evaluating priorities and vendors during their first 90 days. Reach out while the mandate is still forming and the budget for outside help hasn't been claimed yet.</p><p><b>Sample subject:</b> "Congrats on the {"{{title}}"} role at {"{{company}}"}"</p></article>
          <article className="pages-info-card"><span>03</span><h3>Case-study follow-up</h3><p>Reference a comparable engagement without naming the client, and let the prospect connect the dots to their own situation in the second line.</p><p><b>Sample subject:</b> "How a similar-sized team fixed [problem]"</p></article>
          <article className="pages-info-card"><span>04</span><h3>Fractional-role offer</h3><p>Position the fractional engagement as the practical middle step between an unfilled role and a full-time hire — a real option when the need is current but headcount approval is months away.</p><p><b>Sample subject:</b> "A fractional option for {"{{company}}"}'s {"{{title}}"} gap"</p></article>
          <article className="pages-info-card"><span>05</span><h3>Diagnostic or audit offer</h3><p>Offer a short, scoped read of one process or system as the first deliverable, so the prospect can evaluate the work and the working relationship before committing to anything larger.</p><p><b>Sample subject:</b> "A 20-minute read on {"{{company}}"}'s [process]"</p></article>
          <article className="pages-info-card"><span>06</span><h3>Budget-cycle trigger</h3><p>Reach out a quarter ahead of budget season, when a director is actively building next year's plan and still deciding which initiatives make the final list and which get cut.</p><p><b>Sample subject:</b> "Getting ahead of {"{{company}}"}'s planning cycle"</p></article>
          <article className="pages-info-card"><span>07</span><h3>Mutual-connection reference</h3><p>Name the shared context plainly in the first line — a mutual contact, a conference, a shared group — so the email reads like a continuation of something already underway.</p><p><b>Sample subject:</b> "{"{{firstName}}"}, following up from [shared context]"</p></article>
          <article className="pages-info-card"><span>08</span><h3>Thought-leadership follow-up</h3><p>If you've written or spoken on the exact problem {"{{company}}"} is facing, the follow-up's whole job is linking that existing proof to their specific situation, with the published piece doing the credibility work for you.</p><p><b>Sample subject:</b> "Following up on what I wrote about [topic]"</p></article>
          <article className="pages-info-card"><span>09</span><h3>Growth or expansion trigger</h3><p>Funding, a new office, or a leadership expansion all signal a company is about to outgrow its current process. Reach out while the gap between growth and process is still forming.</p><p><b>Sample subject:</b> "Saw the news about {"{{company}}"}'s expansion"</p></article>
          <article className="pages-info-card"><span>10</span><h3>Second-opinion offer</h3><p>When an initiative has visibly stalled internally, offer a second opinion as a low-commitment first step, giving the prospect a lighter way to bring in outside judgment before a full engagement is on the table.</p><p><b>Sample subject:</b> "A second opinion on {"{{company}}"}'s [initiative]"</p></article>
        </div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Sample sequence" title="A 3-step consulting sequence, written out" description="Built around the insight-led teardown angle above, with each step earning the next one. Three steps is usually enough for a narrow, well-researched consulting list — a longer sequence tends to dilute the specificity that made the first email worth opening." />
        <div className="pages-usecase-band">
          <article><b>Step 1 · Day 0</b><h3>One thing I noticed on {"{{company}}"}'s pricing page</h3><p>"Hi {"{{firstName}}"} — I was looking at {"{{company}}"}'s pricing page and noticed [specific detail]. I've helped a few similarly sized {"{{title}}"} teams work through that exact tradeoff. Worth a 15-minute call to compare notes?"</p></article>
          <article><b>Step 2 · Day 3</b><h3>How a similar team solved this</h3><p>"Following up, {"{{firstName}}"} — a comparable team I worked with ran into the same issue last year and fixed it by [approach]. Happy to walk through what changed and whether it applies to {"{{company}}"}."</p></article>
          <article><b>Step 3 · Day 8</b><h3>Last note — a fractional option, if useful</h3><p>"I'll leave this here, {"{{firstName}}"}. If a full engagement isn't the right scope yet, a fractional {"{{title}}"} arrangement is worth considering too — happy to outline what that could look like for {"{{company}}"} whenever it's useful."</p></article>
        </div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="How it works" title="From target list to first replies" description="A short setup, built for a practice with limited time to spend on tooling and no interest in becoming an email-infrastructure project on the side." />
        <div className="pages-card-grid">
          <article className="pages-step-card"><span>01</span><h3>Connect your inbox</h3><p>Link the Gmail, Google Workspace, or Outlook address you already send from, and add each partner's mailbox the same way — one click, no DNS setup, and no domain change to plan around.</p></article>
          <article className="pages-step-card"><span>02</span><h3>Import your list</h3><p>Upload a CSV of the prospects you've researched, or bring leads in through the API or MCP server if your research already lives somewhere else, so the list you built stays intact.</p></article>
          <article className="pages-step-card"><span>03</span><h3>Draft, launch, and let rotation work</h3><p>AI drafts the sequence with your merge tags in place. Set sending windows and caps, then rotation and bounce intelligence manage delivery across every connected mailbox while replies stop the sequence automatically and per-step analytics track what's working.</p></article>
        </div>
      </section>

      <FaqSection title="Consulting outreach questions" items={faqs} />
      <JsonLd data={faqPageJsonLd(faqs)} />

      <RelatedPages
        eyebrow="More ways teams use InboxJoy"
        title="See the guide built for your team shape"
        links={[
          { href: "/use-cases/real-estate", label: "Use case", title: "For real estate", description: "Reach commercial owners, investors, and partners with the same rotation and bounce protection.", cta: "Explore real estate outreach" },
          { href: "/use-cases/agencies", label: "Use case", title: "For agencies", description: "Keep new-business follow-up moving while delivery work still takes most of the week.", cta: "Explore agency outreach" },
          { href: "/free-tools/subject-line-checker", label: "Free tool", title: "Subject line checker", description: "Score a subject line for length, spam language, and personalization before you send it.", cta: "Check a subject line" },
        ]}
      />

      <FinalCta title="Turn your expertise into a sequence prospects actually read" description="Connect your inbox and start reaching the companies who haven't found you yet." />
      <SiteFooter />
    </MarketingPage>
  );
}
