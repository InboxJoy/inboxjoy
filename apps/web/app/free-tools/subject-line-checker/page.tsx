import type { Metadata } from "next";
import { Breadcrumbs, JsonLd, RelatedPages, faqPageJsonLd, webApplicationJsonLd } from "../../_pages/seo";
import { CheckList, FaqSection, FinalCta, MarketingPage, PageHero, SectionHeading, SiteFooter } from "../../_pages/site";
import { SubjectLineChecker } from "./subject-line-checker";
import "../../pages.css";

const title = "Free Email Subject Line Checker | InboxJoy";
const description =
  "Score an email subject line for length, spam-trigger words, personalization, question usage, and urgency with a free browser-based checker.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: "/free-tools/subject-line-checker" },
};

const faqs = [
  ["Does this tool send my subject line to a server?", "No. The subject line checker and the spam word checker both run entirely in your browser using JavaScript. Nothing you type is transmitted, logged, or stored anywhere — refresh the page and it's gone."],
  ["Does a high score guarantee my email will land in the inbox?", "No. These are rules-based editing checks; actual inbox placement still depends on sender reputation, mailbox warm-up, recipient engagement, and other factors no static checklist can fully predict."],
  ["Why did a normal-sounding word get flagged as a spam trigger?", "The checker matches a fixed list of commonly abused promotional phrases, like \"act now\" or \"risk free.\" A flagged word can still be the right choice — judge it in context. \"Free\" inside \"free trial\" reads very differently than \"free money.\""],
  ["What subject line length works best?", "The checker rewards 25–50 characters as a concise, scannable range. Under 15 characters often reads as too vague to earn an open, and past 60 characters the line is likely to truncate on phones and some inbox previews."],
  ["Do merge tags like {{firstName}} or {{company}} actually help?", "Personalization tends to earn attention because it signals a real, specific message. The checker looks for {{firstName}}, {{company}}, or {{title}} tags — the same tags InboxJoy uses when AI drafts a sequence for you."],
  ["How is the subject line score calculated?", "It starts at 100 and subtracts points for risk factors: length outside the ideal range, spam-trigger phrases, missing personalization, multiple question marks, and forced urgency language. It's a transparent rules engine, with every deduction traceable to one of the checks above."],
  ["How often are the trigger word lists updated?", "The lists cover well-known, persistently abused phrases and are reviewed periodically. They're intentionally conservative — a short, high-confidence list beats a bloated one that flags ordinary business language."],
  ["Can I use these tools if I'm not an InboxJoy customer?", "Yes. Both tools are free, need no signup, and work for any email you're drafting — cold outreach, newsletters, or internal copy."],
  ["Once my subject line is ready, how do I actually send the email?", "Connect Gmail or Outlook to InboxJoy in one click, import leads by CSV, and let AI draft the full sequence around your reviewed subject line and merge tags. Sending windows, per-mailbox caps, and a warm-up ramp starting at 8 sends a day control the pace, and replies automatically stop further follow-ups."],
] as const;

export default function SubjectLineCheckerPage() {
  return (
    <MarketingPage>
      <PageHero kicker="Free subject line checker" title={<>Make the first line<br />earn the open.</>} description="Paste a subject line for instant, rules-based feedback on length, personalization, spam language, questions, and urgency. Nothing is sent to a server." />
      <Breadcrumbs crumbs={[["Home", "/"], ["Free tools", "/free-tools"], ["Subject line checker", "/free-tools/subject-line-checker"]]} />
      <JsonLd data={webApplicationJsonLd({ name: "Email Subject Line Checker", path: "/free-tools/subject-line-checker", description })} />

      <section className="v2-section">
        <SectionHeading eyebrow="Quick email deliverability test" title="Score your subject line before you send" description="Run a free, rules-based email deliverability test on length, spam language, personalization, and urgency." />
        <SubjectLineChecker />
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Three steps" title="How to use the subject line checker" description="No signup, no install — just paste and edit." />
        <div className="pages-card-grid">
          <article className="pages-step-card"><span>01</span><h3>Paste your draft subject line</h3><p>Type or paste the exact subject line you're planning to send into the input box above. The checker analyzes it as you type, with no need to click a "submit" button.</p></article>
          <article className="pages-step-card"><span>02</span><h3>Read each rule's feedback</h3><p>The score breaks down into five checks — length, spam language, personalization, question usage, and urgency — each with a short explanation of why it helped or hurt the score.</p></article>
          <article className="pages-step-card"><span>03</span><h3>Edit and re-check</h3><p>Adjust the line based on the feedback and watch the score update live. Aim for a strong starting point, then trust your judgment on the specific context of the email.</p></article>
        </div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Under the hood" title="What the checker scores and why it matters" description="Every subject line starts at 100 points. The score subtracts points for patterns that are statistically more likely to hurt opens or trip spam filters." />
        <div className="pages-card-grid">
          <article className="pages-info-card"><span>1</span><h3>Length (25–50 characters)</h3><p>Most inbox previews show roughly 40–60 characters before truncating, and mobile screens cut off even sooner. Lines between 25 and 50 characters keep the full idea visible. Under 15 characters costs the most points because it's often too vague to justify an open; over 60 characters is penalized for likely truncation.</p></article>
          <article className="pages-info-card"><span>2</span><h3>Spam-trigger language</h3><p>The checker scans for a short list of phrases long associated with promotional or low-quality email — things like "100% free," "act now," "guaranteed," and "winner." Each match costs points, up to a capped penalty, because stacking several of these phrases reads as a mass blast rather than a real message from a person.</p></article>
          <article className="pages-info-card"><span>3</span><h3>Personalization</h3><p>The checker looks for a supported merge tag — {"{{firstName}}"}, {"{{company}}"}, or {"{{title}}"} (or the bracketed equivalents) — anywhere in the line. Personalized subject lines signal a real, specific message written for one person. This one is optional and only costs a small deduction when missing, since not every strong subject line needs a name in it.</p></article>
          <article className="pages-info-card"><span>4</span><h3>Question usage</h3><p>Exactly one question mark can make a subject line feel conversational and prompt a reply-style reaction. Zero questions is fine too — a direct, specific statement works just as well. More than one question mark loses points because stacked questions tend to read as pressure rather than curiosity.</p></article>
          <article className="pages-info-card"><span>5</span><h3>Urgency language</h3><p>Words like "urgent," "asap," "deadline," "expires," and "last chance" are checked separately from the spam list because they're common in legitimate emails too. A single urgency word costs a small deduction as a nudge to confirm the deadline is real; two or more compounds the penalty since stacked urgency reads as manufactured pressure.</p></article>
        </div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Before and after" title="Best practices with concrete examples" description="The rules above map directly to real edits. Here's what a stronger rewrite typically looks like." />
        <div className="pages-split">
          <div className="pages-split-copy">
            <div className="v2-stripes" />
            <h3>Subject lines that tend to score well</h3>
            <p>Specific, personalized, and honest about the ask — these examples stay in the 25–50 character range with at most one question mark and no manufactured urgency.</p>
            <CheckList items={[
              "\"Quick question about {{company}}'s onboarding flow\" — specific, personalized, one clear topic",
              "\"{{firstName}}, worth 10 minutes next week?\" — direct ask, real personalization, single question",
              "\"Notes from your {{company}} demo\" — concrete and relevant, no pressure language",
              "\"Following up on outreach automation\" — plain statement, no filler words",
            ]} />
          </div>
          <article className="pages-fair-card">
            <span>Avoid subject lines like this</span>
            <h3>Vague, pressured, or promotional phrasing</h3>
            <p><b>"ACT NOW: 100% free consultation, limited time!!"</b> — stacks two spam-trigger phrases and forced urgency, and the exclamation marks compound the promotional feel.</p>
            <p><b>"Hi"</b> — under 15 characters with no context. Technically opens the message, but gives the recipient no reason to click before deleting.</p>
            <p><b>"Are you free? Can we talk? Is now good??"</b> — three question marks reads as pressure, and the score reflects it.</p>
          </article>
        </div>
      </section>

      <FaqSection items={faqs} title="Subject line checker questions" />
      <JsonLd data={faqPageJsonLd(faqs)} />

      <RelatedPages
        eyebrow="More free tools"
        title="Keep editing before you send"
        description="Check the body copy next, or see every free tool in one place."
        links={[
          { href: "/free-tools/spam-word-checker", label: "Interactive tool", title: "Spam word checker", description: "Paste an email body to highlight known trigger phrases and see a low, medium, and high-severity count.", cta: "Scan email copy" },
          { href: "/free-tools", label: "Free tools hub", title: "All free email tools", description: "Browse every rules-based, browser-only checker InboxJoy offers.", cta: "See all tools" },
          { href: "/docs/campaigns", label: "Docs", title: "Create and manage a campaign", description: "See how a reviewed subject line becomes a full AI-drafted sequence with merge tags.", cta: "Read the guide" },
        ]}
      />

      <FinalCta title="Ready to turn the subject line into a sequence?" description="Get the $79 lifetime license, or self-host InboxJoy free." />
      <SiteFooter />
    </MarketingPage>
  );
}
