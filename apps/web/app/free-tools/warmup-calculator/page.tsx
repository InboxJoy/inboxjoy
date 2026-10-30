import type { Metadata } from "next";
import { Breadcrumbs, JsonLd, RelatedPages, faqPageJsonLd, webApplicationJsonLd } from "../../_pages/seo";
import { CheckList, FaqSection, FinalCta, MarketingPage, PageHero, SectionHeading, SiteFooter } from "../../_pages/site";
import { WarmupCalculator } from "./warmup-calculator";
import "../../pages.css";

const title = "Free Email Warmup Calculator | Ramp Schedule & Daily Limits";
const description =
  "Calculate your email warm-up ramp: days to full speed, a day-by-day schedule, and how many mailboxes you need to hit your target volume.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: "/free-tools/warmup-calculator" },
};

const faqs = [
  [
    "What is email warm-up, in plain terms?",
    "Warm-up is sending a small number of emails from a mailbox on day one, then increasing that number a little each day on the way to full volume. A brand-new or recently reconnected mailbox has no sending history that mailbox providers can use to judge it, and a sudden burst of outbound email is one of the patterns spam filters watch for. A gradual ramp gives the mailbox a sending history to build on.",
  ],
  [
    "What ramp does this calculator use by default?",
    "The default inputs — 8 emails on day one and about 15% daily growth — match the ramp InboxJoy applies automatically to every newly connected mailbox. You can change either number to model a faster, slower, or higher-volume plan; the day-by-day table updates instantly.",
  ],
  [
    "How is each day's allowed volume actually calculated?",
    "Day 0 starts at your starting volume. Each following day multiplies the previous allowed volume by (1 + growth rate), then rounds to the nearest whole email. That number is capped at your target daily sends per mailbox, so growth levels off the moment the mailbox reaches full speed.",
  ],
  [
    "Does a completed ramp guarantee inbox placement?",
    "No calculator can promise that. A finished ramp gives the mailbox a sending history and a reasonable pace, both of which are common practice for protecting sender reputation. Inbox placement after that still depends on domain authentication (SPF, DKIM, DMARC), list quality, content, and recipient engagement over time.",
  ],
  [
    "Can I skip warm-up for a mailbox that already sends email?",
    "Often yes. A mailbox with an established sending history and a low bounce rate has less to prove than a brand-new one. InboxJoy lets you mark a connected mailbox as already warmed up so it sends at its full configured daily limit immediately, while a fresh or dormant mailbox still starts the ramp.",
  ],
  [
    "What happens to the ramp if a mailbox starts bouncing?",
    "InboxJoy pauses the ramp's day-count whenever a mailbox's 7-day bounce rate crosses into a degraded or critical state, so a bad day doesn't count as ramp progress. Once the mailbox's health recovers, the countdown resumes from where it left off.",
  ],
  [
    "How does the \"mailboxes needed\" number get calculated?",
    "Divide your desired total daily sends by the safe per-mailbox cap you're planning to use, then round up. Ten mailboxes each capped at 35 sends a day cover a 340-send target with room to spare; nine would fall short. This only covers volume at full speed — each mailbox still ramps up individually before contributing its full share.",
  ],
  [
    "Is the daily limit per mailbox or shared across my whole account?",
    "In InboxJoy, the daily and hourly limits you set apply per mailbox, and a separate workspace-wide daily send cap applies across every connected mailbox combined. This calculator's \"combined daily capacity\" figure is the sum of each mailbox's full-speed cap, which is the ceiling once every mailbox has finished ramping.",
  ],
  [
    "Does this calculator store or send my numbers anywhere?",
    "No. Every calculation runs in your browser with plain JavaScript. Nothing you type here is transmitted, logged, or saved — refresh the page and the inputs reset to their defaults.",
  ],
] as const;

export default function WarmupCalculatorPage() {
  return (
    <MarketingPage>
      <PageHero
        kicker="Free warm-up calculator"
        title={<>Plan the ramp<br />before you send.</>}
        description="Model a mailbox's day-by-day warm-up ramp, see how many total emails it sends before reaching full speed, and work out how many mailboxes you need for a target volume."
      />
      <Breadcrumbs crumbs={[["Home", "/"], ["Free tools", "/free-tools"], ["Email warmup calculator", "/free-tools/warmup-calculator"]]} />
      <JsonLd data={webApplicationJsonLd({ name: "Email Warmup Calculator", path: "/free-tools/warmup-calculator", description })} />

      <section className="v2-section">
        <SectionHeading eyebrow="Warm-up ramp calculator" title="Build your ramp schedule" description="Enter a per-mailbox cap, a mailbox count, and a starting volume to see the full day-by-day plan." />
        <WarmupCalculator />
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Three steps" title="How to use the warm-up calculator" description="Model your own numbers, then read the ramp table for the exact daily allowance." />
        <div className="pages-card-grid">
          <article className="pages-step-card"><span>01</span><h3>Set your target cap and mailbox count</h3><p>Enter the daily sends per mailbox you want at full speed and how many mailboxes you're running the ramp across. These two numbers drive the combined daily capacity figure.</p></article>
          <article className="pages-step-card"><span>02</span><h3>Check the starting volume and growth rate</h3><p>The defaults — 8 emails on day one, growing about 15% a day — mirror InboxJoy's built-in ramp. Adjust either number to see a faster or more conservative plan.</p></article>
          <article className="pages-step-card"><span>03</span><h3>Read the ramp table and totals</h3><p>Scroll the day-by-day table for the exact allowance on any given day, or use the summary numbers for days to full speed, total sends during the ramp, and mailboxes needed for a bigger target.</p></article>
        </div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Why it matters" title="What warm-up is and why the ramp matters" description="A gradual increase in volume gives a mailbox provider a pattern to trust." />
        <div className="pages-card-grid">
          <article className="pages-info-card"><span>1</span><h3>New mailboxes have no track record</h3><p>Mailbox providers weigh sending history heavily when deciding where an email lands. A newly connected or recently dormant mailbox has nothing to point to yet, so a slow, steady start builds that history over time.</p></article>
          <article className="pages-info-card"><span>2</span><h3>Sudden volume looks like a red flag</h3><p>Zero-to-full-speed sending on day one is a pattern associated with compromised accounts and mass blasts. A ramp that compounds gradually avoids that shape entirely, which is common practice across cold outreach and deliverability guidance.</p></article>
          <article className="pages-info-card"><span>3</span><h3>Compounding growth reaches full speed fast</h3><p>Because each day's allowance multiplies by a percentage of the day before, a ramp that starts at 8 a day and grows 15% daily reaches a 50-per-day cap in under two weeks — slow enough to build trust, fast enough not to stall a launch.</p></article>
          <article className="pages-info-card"><span>4</span><h3>The ramp responds to what happens during it</h3><p>A ramp that ignores bounces along the way can push a struggling mailbox straight into a worse problem. Pausing the day-count when a mailbox's health dips, then resuming once it recovers, keeps the ramp aligned with what the mailbox can actually handle.</p></article>
        </div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Setting the cap" title="How to choose a safe per-mailbox daily cap" description="There's no single number that fits every mailbox — these are the factors that shape a reasonable one, reflecting common practice." />
        <div className="pages-split">
          <div className="pages-split-copy">
            <div className="v2-stripes" />
            <h3>Factors worth weighing</h3>
            <p>Start conservative and raise the cap as the mailbox's track record grows, revisiting the number over time.</p>
            <CheckList items={[
              "Mailbox age and history — an aged Google Workspace or Microsoft 365 mailbox with real inbound/outbound traffic can typically support a higher cap than a brand-new one",
              "Domain authentication — SPF, DKIM, and DMARC set up correctly reduce the risk a given volume gets flagged",
              "List quality — a cap that's safe for a verified, opted-in list is too aggressive for a cold, unverified one",
              "Provider guidance — Google and Microsoft publish their own sending guidelines, which are worth checking directly for the most current numbers",
              "Engagement signals — replies and opens support a higher cap; bounces and spam complaints argue for a lower one",
            ]} />
          </div>
          <article className="pages-fair-card">
            <span>Common starting points</span>
            <h3>A reasonable range to start from</h3>
            <p><b>20–50 sends a day per mailbox</b> is a common range for cold outreach once a mailbox has finished warming up, though many teams run higher or lower depending on the factors above.</p>
            <p>Running more mailboxes at a moderate cap each tends to be steadier than pushing one mailbox to a high cap, since it spreads volume and risk across several sending identities.</p>
            <p>Whatever cap you land on, treat it as a starting point to revisit — bounce rate and reply rate over the following weeks are the real signal for whether it's sustainable.</p>
          </article>
        </div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Once the ramp is planned" title="What InboxJoy handles automatically" description="This calculator plans the numbers. InboxJoy runs the ramp itself once mailboxes are connected." />
        <div className="pages-card-grid">
          <article className="pages-info-card"><span>1</span><h3>Automatic rotation across unlimited mailboxes</h3><p>Connect as many Gmail or Outlook mailboxes as you need. InboxJoy rotates sends across the healthy ones in proportion to each mailbox's remaining daily capacity, including its warm-up limit.</p></article>
          <article className="pages-info-card"><span>2</span><h3>A ramp that starts at 8/day and grows ~15%/day</h3><p>Every newly connected mailbox follows this ramp automatically, and it's skippable for mailboxes that already have a sending history.</p></article>
          <article className="pages-info-card"><span>3</span><h3>Bounce intelligence built in</h3><p>InboxJoy tracks each mailbox's 7-day bounce rate, flags it as degraded at 2% and above, and stops sending from it at 5% and above — the same thresholds the bounce rate calculator uses.</p></article>
          <article className="pages-info-card"><span>4</span><h3>Per-mailbox caps, sending windows, and auto-stop on reply</h3><p>Set daily and hourly caps and sending windows for every mailbox, with hard bounces suppressed workspace-wide and follow-ups stopping automatically the moment a lead replies.</p></article>
        </div>
      </section>

      <FaqSection items={faqs} title="Warm-up calculator questions" />
      <JsonLd data={faqPageJsonLd(faqs)} />

      <RelatedPages
        eyebrow="More free tools"
        title="Check the rest of your sending setup"
        description="A warm-up plan is one piece. Check your bounce rate and your domain authentication too."
        links={[
          { href: "/free-tools/bounce-rate-calculator", label: "Calculator", title: "Bounce rate calculator", description: "Work out hard, soft, and total bounce rate, and how many more bounces would push a mailbox past InboxJoy's health thresholds.", cta: "Check a bounce rate" },
          { href: "/free-tools/spf-dkim-dmarc-checker", label: "Interactive tool", title: "SPF, DKIM & DMARC checker", description: "Look up a domain's email authentication records and get plain-English fixes for anything missing or weak.", cta: "Check a domain" },
          { href: "/docs/warmup-and-limits", label: "Docs", title: "Manage warm-up and sending limits", description: "See exactly how InboxJoy's ramp, per-mailbox caps, sending windows, and bounce-triggered pauses work together.", cta: "Read the guide" },
        ]}
      />

      <FinalCta title="Ready to run this ramp automatically?" description="Get the $79 lifetime license, or self-host InboxJoy free." />
      <SiteFooter />
    </MarketingPage>
  );
}
