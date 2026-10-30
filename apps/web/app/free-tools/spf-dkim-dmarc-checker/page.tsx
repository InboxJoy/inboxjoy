import type { Metadata } from "next";
import { Breadcrumbs, JsonLd, RelatedPages, faqPageJsonLd, webApplicationJsonLd } from "../../_pages/seo";
import { CheckList, FaqSection, FinalCta, MarketingPage, PageHero, SectionHeading, SiteFooter } from "../../_pages/site";
import { DnsChecker } from "./dns-checker";
import "../../pages.css";

const title = "Free SPF, DKIM & DMARC Checker | Email Authentication Test";
const description =
  "Check SPF, DKIM, and DMARC records for any domain in seconds. Free browser-based email authentication test with plain-English fixes.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: "/free-tools/spf-dkim-dmarc-checker" },
};

const faqs = [
  [
    "Does this tool send my domain to a server?",
    "Yes, in a narrower way than that implies. To look up SPF, DKIM, and DMARC records, the tool sends the domain name to a public DNS resolver (Cloudflare or Google), the same kind of lookup any mail server performs before delivering a message. InboxJoy doesn't receive, log, or store the domain or the results — the request goes straight from your browser to the resolver.",
  ],
  [
    "Why does the checker try six different DKIM selectors?",
    "DKIM selectors aren't standardized — each email provider picks its own naming convention, and a domain often ends up with more than one over its lifetime. The tool tries six common defaults (google, selector1, selector2, default, k1, s1) automatically. If none of those match, enter the exact selector from your provider's authentication settings and re-run the check.",
  ],
  [
    "What does it mean if DKIM shows \"not found on common selectors\"?",
    "It means none of the six common selectors returned a key; your provider may use a custom selector, so enter it to check. Selector names vary enough by provider and setup history that a miss on the common list happens even for domains with DKIM configured correctly. Find the real selector in your provider's settings and check again.",
  ],
  [
    "Why did I get two SPF records for the same domain?",
    "This usually happens when a new sending tool's setup guide says to add a TXT record without checking whether one already exists. A domain is only allowed one SPF record — a second one makes SPF evaluation fail everywhere, which behaves the same as having no SPF at all. Merge the include: mechanisms from both into a single record.",
  ],
  [
    "Is p=none good enough for DMARC?",
    "It's a reasonable starting point, since it lets you collect aggregate reports without risking legitimate mail getting blocked by a mistake. It's a starting point on the way to full enforcement — p=none doesn't yet instruct any receiving server to act on a spoofed or failing message. Move to p=quarantine, then p=reject, once the reports confirm every legitimate sending source is accounted for.",
  ],
  [
    "Do I need SPF, DKIM, and DMARC for cold email specifically?",
    "Cold email gets less benefit of the doubt from spam filters than a reply inside an existing thread, which makes authentication matter more. All three records are the baseline mailbox providers check before subject lines, copy, or sending pace even come into play.",
  ],
  [
    "What's the difference between a hard fail (-all) and soft fail (~all) in SPF?",
    "Both mark unauthorized senders as unauthorized. -all tells receivers to reject mail that fails the check outright, while ~all asks them to flag it and leaves the final call to their own spam filtering. ~all works well as a default while you're still confirming every legitimate sending source is included; -all is the stricter setting for once that list is confirmed complete.",
  ],
  [
    "Can a passing check here guarantee inbox placement?",
    "A pass here confirms one specific thing: that a message really did come from a server you authorized. Inbox placement also depends on sender reputation, engagement history, content, and sending volume built up over time, so treat this checker as confirming the authentication baseline, one part of the whole picture.",
  ],
  [
    "Once these records pass, how do I actually start sending?",
    "Connect Gmail, Google Workspace, or Outlook to InboxJoy, and it sends through your connected mailboxes, rotating across as many as you add. Each mailbox gets its own warm-up ramp starting at 8 sends a day, a 7-day bounce rate InboxJoy tracks continuously, and a per-mailbox sending cap, with a mailbox that crosses a 5% bounce rate automatically paused from sending.",
  ],
] as const;

export default function SpfDkimDmarcCheckerPage() {
  return (
    <MarketingPage>
      <PageHero
        kicker="Free SPF, DKIM & DMARC checker"
        title={
          <>
            Test your domain&apos;s
            <br />
            email authentication.
          </>
        }
        description="Enter a domain to check its SPF, DKIM, and DMARC records instantly. Lookups run through a public DNS resolver (Cloudflare or Google) straight from your browser — no signup, and nothing stored on our side."
      />
      <Breadcrumbs
        crumbs={[
          ["Home", "/"],
          ["Free tools", "/free-tools"],
          ["SPF, DKIM & DMARC checker", "/free-tools/spf-dkim-dmarc-checker"],
        ]}
      />
      <JsonLd data={webApplicationJsonLd({ name: "SPF, DKIM & DMARC Checker", path: "/free-tools/spf-dkim-dmarc-checker", description })} />

      <section className="v2-section">
        <SectionHeading
          eyebrow="Quick email authentication test"
          title="Check your domain's SPF, DKIM, and DMARC records"
          description="Enter a domain to pull its live DNS records and see a pass, warning, or fail status for each authentication method, with a plain-English fix for anything that needs attention."
        />
        <DnsChecker />
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Three steps" title="How to use the SPF, DKIM & DMARC checker" description="No signup, no install — just enter a domain." />
        <div className="pages-card-grid">
          <article className="pages-step-card">
            <span>01</span>
            <h3>Enter your sending domain</h3>
            <p>Type the domain you send email from, like acme.com, or paste a full email address such as you@acme.com and the tool extracts the domain automatically.</p>
          </article>
          <article className="pages-step-card">
            <span>02</span>
            <h3>Add your DKIM selector if you have it</h3>
            <p>DKIM selectors vary by provider, so the checker tries six common ones (google, selector1, selector2, default, k1, s1) automatically. When none of those match, enter the exact selector from your provider's settings for an accurate reading.</p>
          </article>
          <article className="pages-step-card">
            <span>03</span>
            <h3>Read each record's status and fix</h3>
            <p>Each of the three records gets a pass, warning, or fail card with the raw DNS value and a next step in plain English. Publish the suggested change with your DNS provider, then re-run the check to confirm it took effect.</p>
          </article>
        </div>
      </section>

      <section className="v2-section">
        <SectionHeading
          eyebrow="Under the hood"
          title="What SPF, DKIM, and DMARC actually do"
          description="Three separate DNS records work together to prove a message really came from a server you authorized."
        />
        <div className="pages-card-grid">
          <article className="pages-info-card">
            <span>1</span>
            <h3>SPF — Sender Policy Framework</h3>
            <p>SPF publishes the list of servers and services allowed to send email on a domain's behalf, as a single TXT record at the domain root. A receiving server checks whether the sending IP appears on that list. A missing SPF record, or one that leaves out the actual sending service, gives receivers a real reason to distrust the message.</p>
          </article>
          <article className="pages-info-card">
            <span>2</span>
            <h3>DKIM — DomainKeys Identified Mail</h3>
            <p>DKIM attaches a cryptographic signature to each outgoing message, generated with a private key the sending provider holds and verified against a public key published as a DNS TXT record at a selector-specific address. A valid signature confirms the message wasn't altered in transit and genuinely originated from a server the provider controls.</p>
          </article>
          <article className="pages-info-card">
            <span>3</span>
            <h3>DMARC — Domain-based Message Authentication</h3>
            <p>DMARC sits on top of SPF and DKIM. It publishes a policy — monitor, quarantine, or reject — telling receiving servers what to do with mail that fails both checks, plus where to send reports about those failures. A domain can have flawless SPF and DKIM and still leave open the exact spoofing gap DMARC is built to close.</p>
          </article>
        </div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Why it matters for outreach" title="Cold email leans on authentication harder than most email" />
        <div className="pages-split">
          <div className="pages-split-copy">
            <div className="v2-stripes" />
            <h3>A message a recipient didn't ask for starts with less trust</h3>
            <p>A reply inside an existing thread already has context working in its favor. A cold email arrives cold, so mailbox providers lean more heavily on technical signals to decide whether the domain sending it is trustworthy. SPF, DKIM, and DMARC are the first three signals checked, ahead of anything about subject lines, copy, or sending pace.</p>
            <CheckList
              items={[
                "SPF confirms the sending service is authorized for this domain",
                "DKIM confirms the message wasn't altered in transit",
                "DMARC tells receivers what to do when either check fails",
                "All three together are the baseline for domain trust, at any sending volume",
              ]}
            />
          </div>
          <article className="pages-fair-card">
            <span>Context</span>
            <h3>The 2024 bulk sender rules raised the bar</h3>
            <p>In 2024, Google and Yahoo tightened their requirements for bulk senders: domains sending meaningful volume to Gmail and Yahoo addresses need valid SPF and DKIM, a DMARC policy published at the domain, a low spam complaint rate, and a one-click unsubscribe option on marketing mail.</p>
            <p>Most cold outreach runs well under the volume threshold that triggers strict enforcement of those rules, and the same three records still help any sender, at any volume, stay out of the spam folder and keep the domain from being spoofed by someone else.</p>
          </article>
        </div>
      </section>

      <section className="v2-section">
        <SectionHeading eyebrow="Common fixes" title="Fixing the failures this checker finds" description="Every result maps to a specific, publishable DNS change." />
        <div className="pages-split">
          <div className="pages-split-copy">
            <div className="v2-stripes" />
            <h3>Records that typically pass</h3>
            <p>These are the shapes a passing SPF, DMARC, and DKIM setup tends to take. Adjust the include: or provider name to match the actual sending source.</p>
            <CheckList
              items={[
                "v=spf1 include:_spf.google.com ~all — a single SPF record authorizing Google Workspace, soft-failing anyone else",
                "v=DMARC1; p=quarantine; rua=mailto:dmarc@yourdomain.com; pct=100 — an enforced DMARC policy with reporting turned on",
                "An active DKIM key on the selector your provider actually signs with, found on the first check",
              ]}
            />
          </div>
          <article className="pages-fair-card">
            <span>Worth fixing first</span>
            <h3>The most common failures</h3>
            <p><b>Two SPF records at once.</b> Usually happens after adding a new sending tool without checking for an existing record first. Merge every include: into one line and delete the extra record — SPF allows exactly one.</p>
            <p><b>DMARC stuck at p=none.</b> This only monitors; it doesn't stop a spoofed message from reaching an inbox. Once a few weeks of rua reports show no legitimate mail failing, move to p=quarantine and then p=reject.</p>
            <p><b>DKIM missing because the wrong selector was checked.</b> Every provider names its selector differently. Check your email provider's authentication settings for the exact name, then enter it in the tool above.</p>
          </article>
        </div>
      </section>

      <FaqSection items={faqs} title="SPF, DKIM & DMARC questions" />
      <JsonLd data={faqPageJsonLd(faqs)} />

      <RelatedPages
        eyebrow="More free tools"
        title="Keep the send healthy end to end"
        description="Check the copy next, or see how a connected inbox sends once authentication passes."
        links={[
          { href: "/free-tools/spam-word-checker", label: "Interactive tool", title: "Spam word checker", description: "Paste an email body to highlight known trigger phrases and see a low, medium, and high-severity count.", cta: "Scan email copy" },
          { href: "/free-tools/subject-line-checker", label: "Interactive tool", title: "Subject line checker", description: "Score a subject line for length, spam-trigger words, personalization, question usage, and urgency.", cta: "Score a subject line" },
          { href: "/docs/connect-inbox", label: "Docs", title: "Connect your inbox", description: "See how to connect Gmail, Google Workspace, or Outlook and start warming up a mailbox for sending.", cta: "Read the guide" },
        ]}
      />

      <FinalCta title="Ready to send once your domain checks out?" description="Get the $79 lifetime license, or self-host InboxJoy free." />
      <SiteFooter />
    </MarketingPage>
  );
}
