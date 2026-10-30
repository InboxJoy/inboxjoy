import type { Metadata } from "next";
import { Breadcrumbs } from "../_pages/seo";
import { FinalCta, MarketingPage, PageHero, RouteCard, SiteFooter } from "../_pages/site";
import "../pages.css";

const title = "Free Email Tools | InboxJoy";
const description =
  "Use free, browser-based tools from InboxJoy to check email subject lines and find common spam-trigger words without sending your copy anywhere.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: "/free-tools" },
};

export default function FreeToolsPage() {
  return (
    <MarketingPage>
      <PageHero kicker="Free email tools" title={<>Free email tools<br />for safer sending.</>} description="Check your copy, your domain authentication, your warm-up plan, and your bounce rate before you send. Every tool is free and needs no signup.">
        <div className="pages-hero-links"><a href="#tools">Open a tool</a><a href="/use-cases">Explore use cases</a></div>
      </PageHero>
      <Breadcrumbs crumbs={[["Home", "/"], ["Free tools", "/free-tools"]]} />

      <section className="v2-section" id="tools">
        <header className="v2-section-heading"><h2>Five quick pre-send checks</h2><p>Use each result as an editing prompt; inbox placement still depends on your sender reputation and list quality.</p></header>
        <div className="pages-route-grid">
          <RouteCard href="/free-tools/subject-line-checker" label="Interactive tool" title="Subject line checker" description="Score length, personalization, spam-trigger language, question usage, and urgency with immediate feedback." cta="Check a subject line" />
          <RouteCard href="/free-tools/spam-word-checker" label="Interactive tool" title="Spam word checker" description="Paste an email body to highlight known trigger phrases and see a low, medium, and high-severity count." cta="Scan email copy" />
          <RouteCard href="/free-tools/spf-dkim-dmarc-checker" label="Interactive tool" title="SPF, DKIM & DMARC checker" description="Look up a domain's email authentication records and get plain-English fixes for anything missing or weak." cta="Check a domain" />
          <RouteCard href="/free-tools/warmup-calculator" label="Calculator" title="Email warmup calculator" description="See the day-by-day ramp to your target volume and how many mailboxes you need to hit it." cta="Plan a warm-up" />
          <RouteCard href="/free-tools/bounce-rate-calculator" label="Calculator" title="Bounce rate calculator" description="Work out hard, soft, and total bounce rate and see how close you are to the thresholds that hurt sending." cta="Check a bounce rate" />
        </div>
      </section>

      <section className="v2-section">
        <header className="v2-section-heading"><h2>Useful before the sequence</h2><p>Copy checks help you edit. InboxJoy handles the next operational steps.</p></header>
        <div className="pages-usecase-band">
          <article><b>Draft</b><h3>Start with a clear idea</h3><p>Use the subject checker to remove avoidable friction before building the rest of the message.</p></article>
          <article><b>Review</b><h3>Scan the full body</h3><p>Use the spam-word checker to find loaded phrases and decide whether each one is necessary in context.</p></article>
          <article><b>Send</b><h3>Move into InboxJoy</h3><p>Connect Gmail or Outlook, add the copy to a sequence, and control sending by mailbox.</p></article>
        </div>
      </section>

      <FinalCta title="Ready to turn the copy into a sequence?" description="Get the $79 lifetime license, or self-host InboxJoy free." />
      <SiteFooter />
    </MarketingPage>
  );
}
