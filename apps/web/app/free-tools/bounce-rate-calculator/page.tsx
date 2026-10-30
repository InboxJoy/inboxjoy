import type { Metadata } from "next";
import { Breadcrumbs, JsonLd, RelatedPages, faqPageJsonLd, webApplicationJsonLd } from "../../_pages/seo";
import { CheckList, FaqSection, FinalCta, MarketingPage, PageHero, SectionHeading, SiteFooter } from "../../_pages/site";
import { BounceRateCalculator } from "./bounce-rate-calculator";
import "../../pages.css";

const title = "Email Bounce Rate Calculator | Free Deliverability Check";
const description =
  "Calculate hard, soft, and total bounce rate against InboxJoy's 2% and 5% mailbox health thresholds, free and entirely in your browser.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: "/free-tools/bounce-rate-calculator" },
};

const faqs = [
  [
    "What's the difference between a hard bounce and a soft bounce?",
    "A hard bounce is permanent — the address doesn't exist, the domain is invalid, or the recipient's server has rejected mail from your sender outright. A soft bounce is temporary — a full inbox, an oversized message, or a receiving server that's briefly unavailable. Hard bounces should be suppressed immediately; soft bounces are worth a retry before treating them the same way.",
  ],
  [
    "Why does bounce rate affect sender reputation?",
    "Mailbox providers read a high bounce rate as a sign the sender isn't managing their list carefully, which is a pattern shared with spam operations that blast unverified addresses. A rising bounce rate can lower deliverability across every email from that sender, including messages that never bounced.",
  ],
  [
    "What counts as a good bounce rate?",
    "Under roughly 2% is generally considered healthy for cold outreach and typical for a well-verified list. Between 2% and 5% is a warning sign worth investigating. 5% and above is treated as a real problem by most mailbox providers and by InboxJoy's own health monitoring.",
  ],
  [
    "Where do InboxJoy's 2% and 5% thresholds come from?",
    "They're the exact thresholds InboxJoy's mailbox health monitoring uses. A mailbox's 7-day hard bounce rate (permanent failures such as invalid addresses and blocks) reaching 2% flags it as degraded, which halves its effective daily sending cap. Reaching 5% stops sending from that mailbox entirely until the rate recovers. This calculator applies the same two numbers.",
  ],
  [
    "Does InboxJoy check bounce rate account-wide or per mailbox?",
    "Per mailbox. Each connected mailbox has its own rolling 7-day bounce rate, so one struggling mailbox gets flagged and slowed without holding back every other mailbox in the workspace.",
  ],
  [
    "How do I lower a high bounce rate?",
    "Run new leads through a list verification step before the first send, remove role-based addresses like info@ or support@ that bounce or complain at higher rates, suppress every hard bounce immediately so it's never emailed again, and pace sends so a spike in volume doesn't outrun what a mailbox can absorb. Each of these targets a different source of bad addresses.",
  ],
  [
    "Should I keep emailing an address after it soft bounces?",
    "A single soft bounce is usually fine to retry on the next scheduled send. Several soft bounces in a row from the same address behave like a hard bounce in practice, and treating it as one — suppressing it — avoids repeatedly hitting a mailbox that isn't going to accept the message.",
  ],
  [
    "Does removing role addresses really help?",
    "Yes, for two reasons. Role addresses bounce more often as inboxes get retired or filtered, and the ones that do accept mail are frequently behind aggressive spam filtering since they receive high volumes of outreach. Targeting a named contact tends to lower both bounce rate and spam complaints.",
  ],
  [
    "Does this calculator store or send my numbers anywhere?",
    "No. The math runs entirely in your browser using plain JavaScript. Nothing you enter is transmitted, logged, or saved — refresh the page and the inputs reset to their defaults.",
  ],
] as const;

export default function BounceRateCalculatorPage() {
  return (
    <MarketingPage>
      <PageHero
        kicker="Free bounce rate calculator"
        title={<>Know your bounce rate<br />before it costs you.</>}
        description="Enter emails sent, hard bounces, and soft bounces to see your rate against the exact thresholds InboxJoy uses to protect mailbox health."
      />
      <Breadcrumbs crumbs={[["Home", "/"], ["Free tools", "/free-tools"], ["Bounce rate calculator", "/free-tools/bounce-rate-calculator"]]} />
      <JsonLd data={webApplicationJsonLd({ name: "Email Bounce Rate Calculator", path: "/free-tools/bounce-rate-calculator", description })} />

      <section className="v2-section">
        <SectionHeading eyebrow="Bounce rate calculator" title="Check your rate against real thresholds" description="Enter your send volume and bounce counts for hard, soft, and total bounce rate, plus how close you are to InboxJoy's 2% and 5% marks." />
        <BounceRateCalculator />
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Three steps" title="How to use the bounce rate calculator" description="Pull the three numbers from your sending platform's report and enter them here." />
        <div className="pages-card-grid">
          <article className="pages-step-card"><span>01</span><h3>Enter emails sent</h3><p>Use the total number of emails a mailbox or campaign successfully attempted to send over the period you're checking — commonly a 7-day window, since that's what InboxJoy's health monitoring uses.</p></article>
          <article className="pages-step-card"><span>02</span><h3>Enter hard and soft bounces separately</h3><p>Most sending platforms report these separately already. Keeping them apart matters because a hard bounce calls for permanent suppression while a soft bounce may just need a retry.</p></article>
          <article className="pages-step-card"><span>03</span><h3>Read the status and the headroom</h3><p>The result shows your total rate, a healthy/degraded/critical status, and exactly how many more bounces would push you into the next band.</p></article>
        </div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Why it matters" title="Why bounce rate damages sender reputation" description="A bounce carries more weight than a missed message — it's a signal mailbox providers use to score every future email from that sender." />
        <div className="pages-card-grid">
          <article className="pages-info-card"><span>1</span><h3>Bounces signal list quality</h3><p>A high bounce rate tells a mailbox provider the sender is emailing addresses they haven't verified, which is the same pattern seen in low-quality bulk mail. The provider responds by scrutinizing that sender's mail more closely going forward.</p></article>
          <article className="pages-info-card"><span>2</span><h3>The damage compounds across sends</h3><p>Reputation isn't scored per email — it's tracked per sender over time. A bounce-heavy campaign can lower inbox placement for the next campaign from the same mailbox, even if that next list is clean.</p></article>
          <article className="pages-info-card"><span>3</span><h3>Recency matters as much as the total</h3><p>A rolling window like InboxJoy's 7-day bounce rate weighs recent sends more heavily than a lifetime average would. A mailbox that cleans up its list sees its rate recover within days.</p></article>
          <article className="pages-info-card"><span>4</span><h3>Thresholds exist to catch problems early</h3><p>Waiting until a bounce rate is severe before reacting risks the mailbox's long-term reputation. Two clear bands — a warning level and a stop level — catch the problem while it's still cheap to fix.</p></article>
          <article className="pages-info-card"><span>5</span><h3>A high rate can trigger spam filtering directly</h3><p>Beyond the reputation effect, some mailbox providers use bounce rate as a direct signal in their spam-filtering decisions. A sender that crosses their internal threshold can see healthy, well-targeted emails routed to the spam folder alongside the bounced ones, which is why catching the rate early protects messages that would otherwise land fine.</p></article>
        </div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Fixing it" title="How to lower your bounce rate" description="Each fix targets a different source of bad addresses. Most lists benefit from all four." />
        <div className="pages-split">
          <div className="pages-split-copy">
            <div className="v2-stripes" />
            <h3>Four levers that work together</h3>
            <p>Verification stops bad addresses from entering your list. Suppression stops you from emailing the ones that slip through. Pacing keeps volume from outrunning a mailbox's trust.</p>
            <CheckList items={[
              "Verify new leads before the first send with a list verification step, catching invalid or risky addresses upfront",
              "Remove role-based addresses like info@, support@, or sales@, which bounce and get filtered more than named contacts",
              "Suppress every hard bounce workspace-wide so it's never emailed again from any mailbox or sequence",
              "Pace sends within safe per-mailbox and hourly caps so a spike in volume doesn't outrun what a mailbox can absorb",
            ]} />
          </div>
          <article className="pages-fair-card">
            <span>What InboxJoy automates</span>
            <h3>Suppression and pacing, handled for you</h3>
            <p>InboxJoy suppresses every hard bounce workspace-wide the moment it's detected, so no other mailbox or sequence can email that address again.</p>
            <p>Per-mailbox daily and hourly caps and sending windows keep volume paced, and the warm-up ramp — starting at 8 sends a day and growing about 15% a day, skippable for mailboxes that already have history — keeps new mailboxes from taking on more than they can handle too soon.</p>
            <p>A mailbox's 7-day hard bounce rate is tracked automatically: degraded at 2% and above, stopped at 5% and above, exactly as this calculator shows.</p>
          </article>
        </div>
      </section>

      <FaqSection items={faqs} title="Bounce rate calculator questions" />
      <JsonLd data={faqPageJsonLd(faqs)} />

      <RelatedPages
        eyebrow="More free tools"
        title="Check the rest of your sending setup"
        description="A healthy bounce rate is one piece. Plan your warm-up ramp and check your domain authentication too."
        links={[
          { href: "/free-tools/warmup-calculator", label: "Calculator", title: "Email warmup calculator", description: "See the day-by-day ramp to your target volume and how many mailboxes you need to hit it.", cta: "Plan a warm-up" },
          { href: "/free-tools/spf-dkim-dmarc-checker", label: "Interactive tool", title: "SPF, DKIM & DMARC checker", description: "Look up a domain's email authentication records and get plain-English fixes for anything missing or weak.", cta: "Check a domain" },
          { href: "/docs/warmup-and-limits", label: "Docs", title: "Manage warm-up and sending limits", description: "See how InboxJoy's ramp, per-mailbox caps, and bounce-triggered pauses work together to protect mailbox health.", cta: "Read the guide" },
        ]}
      />

      <FinalCta title="Ready to let InboxJoy watch bounce rate for you?" description="Get the $79 lifetime license, or self-host InboxJoy free." />
      <SiteFooter />
    </MarketingPage>
  );
}
