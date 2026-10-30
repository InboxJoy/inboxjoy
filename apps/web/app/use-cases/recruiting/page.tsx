import type { Metadata } from "next";
import Link from "next/link";
import { CheckList, FaqSection, FinalCta, HeroCta, MarketingPage, PageHero, SectionHeading, SiteFooter } from "../../_pages/site";
import { Breadcrumbs, JsonLd, RelatedPages, faqPageJsonLd, webApplicationJsonLd } from "../../_pages/seo";
import "../../pages.css";

const title = "Cold Email for Recruiters | Candidate & Client Outreach";
const description =
  "InboxJoy helps recruiters run cold email for candidate sourcing and client business development from real connected mailboxes, with rotation and bounce intelligence.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: "/use-cases/recruiting" },
};

const faqs = [
  [
    "How does mailbox rotation help a recruiting desk running multiple searches?",
    "Connect as many mailboxes as your desk uses — there's no limit — and InboxJoy rotates sends across all of them automatically. A busy week with several open searches and a client-pitch push at the same time doesn't have to load onto one inbox alone, and no single mailbox becomes the bottleneck for the whole desk.",
  ],
  [
    "What is bounce intelligence, and why does it matter for candidate sourcing?",
    "Candidate contact data goes stale quickly as people change roles and email addresses. InboxJoy tracks a rolling 7-day bounce rate per mailbox, flags it degraded at 2%, and drops the daily sending limit to zero at 5%, so an outdated sourcing list can't quietly damage a mailbox you also use for client outreach later the same week.",
  ],
  [
    "Can we keep candidate sequences and client BD sequences separate?",
    "Yes. Each sequence runs independently with its own imported list and its own AI-drafted copy, so a passive-candidate sourcing sequence and a hiring-manager pitch sequence never share a thread, a merge-tag set, or a sending schedule.",
  ],
  [
    "How much can we personalize at the volume a search requires?",
    "Merge tags like {{firstName}}, {{company}}, and {{title}} pull from your imported list, so a sourcing sequence built around dozens of candidates in the same niche still reads as written for each person and their specific role.",
  ],
  [
    "What happens when a candidate or a hiring manager replies?",
    "InboxJoy stops the remaining scheduled follow-ups for that contact automatically the moment they reply, so a recruiter can move straight into a screening call or a client conversation without a leftover step landing in the same thread days later.",
  ],
  [
    "Can we re-import a candidate list we already have from another source?",
    "Yes. Upload a CSV, or pull candidates in through the API or InboxJoy's MCP server, whatever tool the list came from — a sourcing platform export, a referral spreadsheet, or a past search's silver-medalist list you kept on file.",
  ],
  [
    "Do we need an ATS integration to run outreach through InboxJoy?",
    "No integration is required. InboxJoy handles the outreach layer — sequencing, sending, and reply tracking — from a CSV, API, or MCP import, independent of whatever system you track candidates or clients in day to day.",
  ],
  [
    "What does InboxJoy cost for a recruiting desk or agency?",
    "InboxJoy is free to self-host (open source). The managed lifetime license is $79, paid once, with unlimited team seats included, so adding another recruiter to the workspace doesn't add a per-seat cost. It carries a 30-day money-back guarantee.",
  ],
  [
    "Is candidate and client cold email compliant with CAN-SPAM and GDPR?",
    "InboxJoy includes the mechanics responsible outreach depends on — a real sender mailbox, working reply handling, and hard bounces suppressed workspace-wide — but compliance depends on how you sourced contact data, your opt-out handling, and the jurisdictions you're emailing into. CAN-SPAM and GDPR obligations, and any recruiting-specific rules in your region, vary by circumstance, so check your own requirements with counsel before a large sourcing or BD push.",
  ],
  [
    "Can we manage searches from tools we already use, like Claude or ChatGPT?",
    "Yes. InboxJoy runs a remote MCP server, so a recruiter can check sequence status, review bounce rates per mailbox, or launch a new sourcing list from inside Claude or ChatGPT without switching to a separate dashboard between calls.",
  ],
] as const;

export default function RecruitingUseCasePage() {
  return (
    <MarketingPage>
      <PageHero kicker="InboxJoy for recruiters" title={<>Cold email for recruiters<br />candidates and clients, one system.</>} description="A recruiting desk runs two outreach motions at once — sourcing passive candidates and pitching hiring managers on new business. InboxJoy rotates sends across every connected mailbox and tracks bounce rate on each one, so a fast-aging sourcing list or a heavy BD push never quietly wrecks the mailbox the other motion depends on.">
        <HeroCta />
      </PageHero>

      <Breadcrumbs crumbs={[["Home", "/"], ["Use cases", "/use-cases"], ["Recruiting", "/use-cases/recruiting"]]} />
      <JsonLd data={webApplicationJsonLd({ name: "InboxJoy for Recruiting", path: "/use-cases/recruiting", description })} />

      <section className="v2-section">
        <SectionHeading eyebrow="The recruiting outreach reality" title="Sourcing and business development compete for the same mailbox" description="Most recruiting outreach is really two jobs running in parallel: reaching passive candidates who aren't actively looking, and reaching hiring managers who might become the next client. Both depend on the same sender reputation, and both suffer when contact data goes stale faster than almost any other list a business sends to." />
        <div className="pages-card-grid">
          <article className="pages-info-card"><span>01</span><h3>Two motions, one inbox</h3><p>Candidate sourcing and client BD often run from the same one or two mailboxes, so a heavy sourcing week and a client-pitch push can stack sending volume past what a single inbox should carry for either motion.</p></article>
          <article className="pages-info-card"><span>02</span><h3>Candidate data goes stale fast</h3><p>People change jobs and email addresses constantly. A sourcing list that was accurate three months ago can carry enough dead addresses to affect deliverability on every other campaign sharing that mailbox, including client BD.</p></article>
          <article className="pages-info-card"><span>03</span><h3>Passive candidates need a different opener</h3><p>Someone who isn't job-hunting reads a generic "exciting opportunity" email as noise. Reaching them takes a specific, low-pressure hook tied to their actual work, tailored for someone who isn't actively applying to postings.</p></article>
        </div>
        <div className="v2-section-heading"><p>None of this is a copywriting problem on its own. It's a capacity and protection problem — one mailbox trying to carry two very different kinds of outreach without any system watching how each one is aging that mailbox's reputation.</p></div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Feature fit" title="Rotation and bounce intelligence, built for two motions at once" description="InboxJoy is built around what a recruiting desk actually needs: enough mailbox capacity for sourcing and BD to run side by side, and a system that protects that capacity automatically as candidate data ages." />
        <div className="pages-split">
          <div className="pages-split-copy"><div className="v2-stripes" /><h3>Spread the load, automatically</h3><p>Connect as many mailboxes as your desk uses — there's no limit — and InboxJoy rotates sends across all of them on its own. Every mailbox carries its own rolling 7-day bounce rate: flagged degraded at 2%, and cut to a zero daily limit at 5%, so a stale sourcing list can't take down the mailbox you also use for client BD. A candidate search and a BD push can share the same pool of mailboxes without sharing risk.</p><CheckList items={["Unlimited connected Gmail, Google Workspace, or Outlook mailboxes", "Automatic send rotation across every connected inbox", "Per-mailbox 7-day bounce rate, flagged degraded at 2%", "Sending automatically stopped at a 5% bounce rate"]} /></div>
          <article className="pages-fair-card"><span>Everything else stays in place</span><h3>The mechanics a desk already expects</h3><p>AI drafts each sequence, and merge tags like {"{{firstName}}"}, {"{{company}}"}, and {"{{title}}"} personalize sourcing and BD sends across lists built for very different audiences and very different tones.</p><p>Daily and hourly caps, sending windows, and an 8-send warm-up ramp rising about 15% a day protect a newly connected mailbox, and replies stop the remaining sequence steps automatically so a recruiter never sends a follow-up over a candidate's answer.</p></article>
        </div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Recruiting playbook" title="Cold email for recruiters that works" description="Candidate sourcing and client BD need different angles, but both depend on the same idea: a specific reason the timing is right, addressed to a specific person. Here are the angles that hold up on both sides of a recruiting desk, each with a sample subject line to start from." />
        <div className="pages-card-grid">
          <article className="pages-info-card"><span>01</span><h3>Passive-candidate opener</h3><p>Skip "exciting opportunity." Reference something specific about their actual work — a project, a talk, a piece of public work — before mentioning the role at all, so the email reads as personal research.</p><p><b>Sample subject:</b> "Question about your work at {"{{company}}"}"</p></article>
          <article className="pages-info-card"><span>02</span><h3>Role-specific hook</h3><p>Tie the opener to the exact skill or project the role needs, using {"{{title}}"} so the message reads as built for their specific background.</p><p><b>Sample subject:</b> "A {"{{title}}"} role that matches what you're already doing"</p></article>
          <article className="pages-info-card"><span>03</span><h3>Hiring-manager BD after a funding round</h3><p>A funding announcement usually means a hiring plan follows soon after. Reach the hiring manager or founder directly, referencing the round and the roles most likely to open next as the team scales.</p><p><b>Sample subject:</b> "Congrats on the round — planning ahead for the hires?"</p></article>
          <article className="pages-info-card"><span>04</span><h3>Re-engaging silver-medalist candidates</h3><p>A strong runner-up from a past search is a warmer lead than a cold one. Reference the earlier process directly and ask whether their situation or interest has changed since then.</p><p><b>Sample subject:</b> "Checking back in after our conversation last year"</p></article>
          <article className="pages-info-card"><span>05</span><h3>Compensation-transparent outreach</h3><p>For hard-to-fill roles, stating a real compensation range up front earns a reply from candidates who'd otherwise ignore a vague pitch with no concrete detail to react to.</p><p><b>Sample subject:</b> "{"{{title}}"} role, [range] — worth 10 minutes?"</p></article>
          <article className="pages-info-card"><span>06</span><h3>Referral-network outreach</h3><p>Even a candidate who says no can point you to someone else. Ask directly for a referral in the same message, without making it feel like a fallback or an afterthought.</p><p><b>Sample subject:</b> "Not the right fit? A quick favor either way"</p></article>
          <article className="pages-info-card"><span>07</span><h3>BD after a hiring-spike signal</h3><p>A company posting several roles in the same function fast is a signal they need sourcing help. Reference the specific postings you noticed, by name.</p><p><b>Sample subject:</b> "Noticed the [function] postings at {"{{company}}"}"</p></article>
          <article className="pages-info-card"><span>08</span><h3>Talent-pool outreach after a layoff signal</h3><p>Reach hiring managers at companies that could use fast access to a strong, suddenly available talent pool, offering to help backfill roles quickly.</p><p><b>Sample subject:</b> "Fast access to [niche] talent right now"</p></article>
          <article className="pages-info-card"><span>09</span><h3>Dormant-client reactivation</h3><p>A past client who hasn't hired through you in a while is warmer than a cold BD target. Reference the last placement by name and ask what's changed on their team since.</p><p><b>Sample subject:</b> "It's been a while since [placement] — how's the team now?"</p></article>
          <article className="pages-info-card"><span>10</span><h3>Niche-specialization outreach</h3><p>Lead with the specific niche your desk places into, so a hiring manager in a candidate-scarce category sees the fit immediately and understands why you're different.</p><p><b>Sample subject:</b> "Specialized in [niche] hiring — quick intro?"</p></article>
        </div>
        <div className="v2-section-heading"><p>Every one of these angles works because it's tied to a real signal or a real relationship. The sequence mechanics below — drafting, rotation, and reply handling — exist so that both motions can run at the volume a busy desk actually needs.</p></div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Sample sequence" title="A 3-step candidate sourcing sequence you can adapt" description="A short, specific sequence built around a passive candidate's actual work, using merge tags so it reads as written for that person. The same three-step shape works for a client BD sequence — swap the hook for a hiring signal and turn the ask into a call." />
        <div className="pages-usecase-band">
          <article><b>Step 1 — Day 1</b><h3>Subject: Question about your work at {"{{company}}"}</h3><p>Hi {"{{firstName}}"}, I came across your work as {"{{title}}"} at {"{{company}}"} and wanted to reach out directly. I'm working on a search that lines up closely with your background — not asking you to apply, just curious if it's worth a short conversation.</p></article>
          <article><b>Step 2 — Day 5</b><h3>Subject: A bit more on the role</h3><p>Following up, {"{{firstName}}"}. The part of this role that seems closest to what you're already doing is [specific responsibility]. Happy to share more detail, or point you to someone on your team who might be a better fit if it's not the right time for you.</p></article>
          <article><b>Step 3 — Day 10</b><h3>Subject: Should I check back later?</h3><p>No pressure either way, {"{{firstName}}"}. If your situation changes or you'd rather I circle back down the line, just say the word and I'll follow up when the timing is better, or reach out first whenever it suits you.</p></article>
        </div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="How it works" title="Get sourcing and BD sequences live" description="Enough setup to protect both motions on shared mailbox capacity, without adding a new tool the desk has to babysit every week." />
        <div className="pages-usecase-band">
          <article><b>Step 1</b><h3>Connect every mailbox</h3><p>Link each Gmail, Google Workspace, or Outlook address your desk sends from — there's no cap on how many, and each gets its own warm-up ramp and bounce tracking from day one.</p></article>
          <article><b>Step 2</b><h3>Import by motion</h3><p>Upload a CSV, or pull contacts through the API or MCP server — a candidate sourcing list kept separate from a client BD list, each with its own merge tags and tone.</p></article>
          <article><b>Step 3</b><h3>Draft and launch</h3><p>Use AI to draft each sequence, set sending windows and caps, and let rotation spread sourcing and BD volume across every connected mailbox automatically as lists grow.</p></article>
        </div>
      </section>

      <FaqSection title="Recruiting outreach questions" items={faqs} />
      <JsonLd data={faqPageJsonLd(faqs)} />

      <RelatedPages
        eyebrow="More ways teams use InboxJoy"
        title="See the guide built for your outreach"
        links={[
          { href: "/use-cases/saas", label: "Use case", title: "For SaaS teams", description: "Run trial follow-up, demo booking, and expansion outreach from rotated, protected mailboxes.", cta: "Explore SaaS outreach" },
          { href: "/use-cases/founders", label: "Use case", title: "For founders", description: "Turn founder-led insight into concise outreach without becoming a full-time sales operator.", cta: "Explore founder outreach" },
          { href: "/free-tools/spam-word-checker", label: "Free tool", title: "Spam word checker", description: "Check a sourcing or BD subject line for phrasing that tends to trip spam filters.", cta: "Check your copy" },
        ]}
      />

      <FinalCta title="Give sourcing and BD room to run together" description="Connect every mailbox your desk sends from and let rotation and bounce intelligence protect both motions." />
      <SiteFooter />
    </MarketingPage>
  );
}
