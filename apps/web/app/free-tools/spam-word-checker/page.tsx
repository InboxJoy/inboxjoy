import type { Metadata } from "next";
import { Breadcrumbs, JsonLd, RelatedPages, faqPageJsonLd, webApplicationJsonLd } from "../../_pages/seo";
import { CheckList, FaqSection, FinalCta, MarketingPage, PageHero, SectionHeading, SiteFooter } from "../../_pages/site";
import { SpamWordChecker } from "./spam-word-checker";
import "../../pages.css";

const title = "Free Email Spam Word Checker | InboxJoy";
const description =
  "Paste email copy to highlight common spam-trigger words and see low, medium, and high-severity counts in a free browser-based checker.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: "/free-tools/spam-word-checker" },
};

const faqs = [
  ["Does this tool send my email copy to a server?", "No. The spam word checker runs entirely in your browser using JavaScript. Nothing you paste is transmitted, logged, or stored anywhere — refresh the page and it's gone."],
  ["What do the high, medium, and low severity tiers mean?", "High-tier phrases like \"act now\" and \"free money\" are the ones most strongly associated with mass promotional email and count 3 points each. Medium-tier phrases like \"limited time\" and \"discount\" appear in legitimate marketing too and count 2. Low-tier words like \"amazing\" and \"reminder\" count 1 and mostly matter when several cluster in one email."],
  ["Does a clean scan guarantee my email will land in the inbox?", "No. This is a rules-based editing check; inbox placement still depends on sender reputation, mailbox warm-up, authentication records, and recipient engagement — factors no word list can predict."],
  ["Why did a normal-sounding word get flagged?", "The checker matches a fixed list of commonly abused promotional phrases. A flagged word can still be the right choice — judge it in context. \"Free\" inside \"free trial\" reads very differently than \"free money.\" If the sentence sounds like something you'd say on a call, it's probably fine."],
  ["Should I remove every flagged word?", "No. Aim to remove the high-severity matches and any clusters. Stripping every mildly promotional word can leave copy that reads stiff and vague — clarity converts better than a perfect score."],
  ["Do spam trigger words still matter for modern filters?", "Less than they used to. Gmail and Outlook rely mostly on sender reputation and engagement signals. Word choice matters because copy that reads like a mass blast earns fewer replies and more spam reports, which is what actually damages reputation over time."],
  ["How often is the trigger word list updated?", "The list covers well-known, persistently abused phrases and is reviewed periodically. It's intentionally conservative — a short, high-confidence list beats a bloated one that flags ordinary business language."],
  ["Can I use this tool if I'm not an InboxJoy customer?", "Yes. It's free, needs no signup, and works for any email you're drafting — cold outreach, newsletters, or internal copy."],
  ["My copy scans clean — how do I actually send the campaign?", "Connect Gmail or Outlook to InboxJoy in one click, import leads by CSV, and let AI draft the full sequence with merge tags. Sending windows, per-mailbox caps, and a warm-up ramp starting at 8 sends a day control the pace, and replies automatically stop further follow-ups."],
] as const;

export default function SpamWordCheckerPage() {
  return (
    <MarketingPage>
      <PageHero kicker="Free spam word checker" title={<>Find loaded phrases<br />before you send.</>} description="Paste your email body to highlight common spam-trigger words and phrases by severity. The scan is rules-based, runs in your browser, and is not a deliverability guarantee." />
      <Breadcrumbs crumbs={[["Home", "/"], ["Free tools", "/free-tools"], ["Spam word checker", "/free-tools/spam-word-checker"]]} />
      <JsonLd data={webApplicationJsonLd({ name: "Email Spam Word Checker", path: "/free-tools/spam-word-checker", description })} />

      <section className="v2-section">
        <SectionHeading eyebrow="Free email spam checker" title="Scan your copy for spam-trigger phrases" description="This email spam checker highlights loaded words and phrases by severity so you can edit before you send." />
        <SpamWordChecker />
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Three steps" title="How to use the spam word checker" description="No signup, no install — just paste and read the highlights." />
        <div className="pages-card-grid">
          <article className="pages-step-card"><span>01</span><h3>Paste your full email body</h3><p>Drop the exact copy you're planning to send into the text box above, including your greeting and sign-off. The scan runs live as you type.</p></article>
          <article className="pages-step-card"><span>02</span><h3>Review the highlighted phrases</h3><p>Every match is underlined directly in your copy and tagged by severity — high, medium, or low — so you can see exactly where each flagged word sits in context.</p></article>
          <article className="pages-step-card"><span>03</span><h3>Swap or keep, on purpose</h3><p>Not every match needs to go. Use the severity and the surrounding sentence to decide, then re-check after editing to confirm the count dropped.</p></article>
        </div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Under the hood" title="What the checker scores and why it matters" description="The checker matches your copy against three severity tiers, then combines them into a single weighted total: high matches count 3 points, medium count 2, and low count 1." />
        <p className="pages-empty-state">Spam filters at Gmail, Outlook, and other providers weigh far more than word choice — sender reputation, authentication records, and recipient engagement all matter more than any single phrase. What a word list like this one is genuinely good for is catching the copy that reads as a mass blast to a human reader, which is often the same copy that trains a filter to distrust the sender over time. Editing out avoidable trigger phrases is a small, cheap step that removes one variable before you focus on the factors that actually move the needle, like warm-up pace and list quality.</p>
        <div className="pages-card-grid">
          <article className="pages-info-card"><span>High</span><h3>Heaviest promotional language</h3><p>Phrases like "100% free," "act now," "buy now," "cash bonus," "click here," "congratulations," "free money," "guaranteed," "no obligation," "risk free," "urgent," and "winner." These are the phrases most strongly associated with mass promotional email and carry the largest weight in the total score.</p></article>
          <article className="pages-info-card"><span>Medium</span><h3>Common promotional filler</h3><p>Phrases like "apply now," "discount," "exclusive," "free," "instant access," "limited time," "lowest price," "offer," "save big," and "special promotion." These show up in legitimate marketing too, so they cost fewer points than the high tier but are still worth a second look.</p></article>
          <article className="pages-info-card"><span>Low</span><h3>Mild attention-grabbers</h3><p>Words like "amazing," "bonus," "don't miss," "important," "incredible," "opportunity," "please read," "reminder," and "trial." Individually these are close to harmless; the checker flags them mainly so a cluster of several in one email doesn't go unnoticed.</p></article>
        </div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Before and after" title="Best practices with concrete examples" description="Trigger words are a prompt to check whether the phrase is doing real work in the sentence." />
        <div className="pages-split">
          <div className="pages-split-copy">
            <div className="v2-stripes" />
            <h3>Copy that tends to scan clean</h3>
            <p>Specific, conversational, and honest about the ask, with almost nothing on the trigger list.</p>
            <CheckList items={[
              "\"Quick question about how {{company}} handles onboarding\" — specific and personal, no trigger phrases",
              "\"Worth a short conversation next week?\" — direct ask, conversational tone",
              "\"Here are the notes from our call\" — concrete and relevant, zero promotional language",
              "\"Let me know if the timing doesn't work\" — respectful close, no manufactured urgency",
            ]} />
          </div>
          <article className="pages-fair-card">
            <span>Common phrases to reconsider</span>
            <h3>Swaps that lower the trigger count</h3>
            <p><b>"Act now — 100% free, guaranteed results!"</b> → "Happy to share results from a recent project if useful." Removes three high-severity matches and the exclamation point in one edit.</p>
            <p><b>"Limited time offer, don't miss this exclusive deal"</b> → "This is open through Friday if it's useful to you." Keeps the real deadline, drops the medium-tier promotional framing.</p>
            <p><b>"Amazing opportunity, please read — important reminder"</b> → "Following up in case this got buried." Same intent, none of the low-severity filler.</p>
          </article>
        </div>
        <p className="pages-empty-state">A useful habit: read the flagged sentence out loud. If it still sounds like something you'd say on a call, the phrase is probably fine even if it's on the list. If it only sounds natural in an ad, that's the copy worth rewriting first.</p>
      </section>

      <FaqSection items={faqs} title="Spam word checker questions" />
      <JsonLd data={faqPageJsonLd(faqs)} />

      <RelatedPages
        eyebrow="More free tools"
        title="Keep editing before you send"
        description="Check the subject line next, or see every free tool in one place."
        links={[
          { href: "/free-tools/subject-line-checker", label: "Interactive tool", title: "Subject line checker", description: "Score length, personalization, spam-trigger language, question usage, and urgency with immediate feedback.", cta: "Check a subject line" },
          { href: "/free-tools", label: "Free tools hub", title: "All free email tools", description: "Browse every rules-based, browser-only checker InboxJoy offers.", cta: "See all tools" },
          { href: "/docs/warmup-and-limits", label: "Docs", title: "Manage warm-up and sending limits", description: "See how sending windows, per-mailbox caps, and a warm-up ramp protect the copy you just cleaned up.", cta: "Read the guide" },
        ]}
      />

      <FinalCta title="Ready to turn the copy into a sequence?" description="Get the $79 lifetime license, or self-host InboxJoy free." />
      <SiteFooter />
    </MarketingPage>
  );
}
