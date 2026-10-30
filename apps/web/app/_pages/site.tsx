import Link from "next/link";
import { ArrowUpRight, Check } from "lucide-react";
import type { ReactNode } from "react";
import { GithubMark, GithubNavLink } from "@/components/github-mark";
import { Logo } from "@/components/logo";
import { NavAuthLink } from "@/components/nav-auth-link";
import { StickyNav } from "@/components/sticky-nav";
import { AnnouncementBanner } from "@/components/announcement-banner";
import { PRIMARY_CTA_HREF, PRIMARY_CTA_LABEL, SELF_HOST_CTA_LABEL, SELF_HOST_REPO_URL } from "@/lib/site-links";

/** Outbound link to the open-source repository. Opens in a new tab. */
export function SelfHostLink({ className, children = SELF_HOST_CTA_LABEL }: { className?: string; children?: ReactNode }) {
  return (
    <a className={className} href={SELF_HOST_REPO_URL} rel="noopener noreferrer" target="_blank">
      {children}
      <ArrowUpRight aria-hidden="true" size={16} strokeWidth={2.25} />
    </a>
  );
}

/** Pill above the home hero headline: open source, links to the repository in a new tab. */
export function HeroGithubPill() {
  return (
    <a className="v2-hero-github" href={SELF_HOST_REPO_URL} rel="noopener noreferrer" target="_blank">
      <GithubMark size={16} />
      <span>Open source<span className="v2-hero-github-extra"> · Self-host free</span> on GitHub</span>
      <ArrowUpRight aria-hidden="true" size={14} strokeWidth={2.25} />
    </a>
  );
}

export function MarketingPage({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <main className={`v2-page pages-site ${className}`.trim()}>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link href="https://fonts.googleapis.com/css2?family=Google+Sans+Flex:wght@400..800&display=swap" rel="stylesheet" />
      <AnnouncementBanner />
      <StickyNav />
      {children}
    </main>
  );
}

export function SiteNav() {
  return (
    <nav className="v2-nav" aria-label="Primary navigation">
      <Logo className="v2-brand" href="/" variant="white" />
      <div className="v2-nav-links"><Link href="/#features">Features</Link><Link href="/#how-it-works">How it works</Link><Link href="/pricing">Pricing</Link><Link href="/blog/">Blog</Link><Link href="/#questions">FAQs</Link><NavAuthLink /></div>
      <div className="v2-nav-end"><GithubNavLink /><Link className="v2-nav-cta" href={PRIMARY_CTA_HREF}>{PRIMARY_CTA_LABEL}</Link></div>
      <details className="v2-nav-menu"><summary aria-label="Open menu"><span /><span /><span /></summary><div className="v2-nav-menu-panel"><a href="/#features">Features</a><a href="/#how-it-works">How it works</a><Link href="/pricing">Pricing</Link><Link href="/blog/">Blog</Link><a href="/#questions">FAQs</a><GithubNavLink variant="menu" /><NavAuthLink /><Link href={PRIMARY_CTA_HREF}>{PRIMARY_CTA_LABEL}</Link></div></details>
    </nav>
  );
}

export function PageHero({ kicker, title, description, children }: { kicker: string; title: ReactNode; description: string; children?: ReactNode }) {
  return (
    <section className="v2-hero-panel pages-hero-panel">
      <div className="v2-stripes" />
      <div className="v2-hero-glow" />
      <SiteNav />
      <div className="v2-hero-content pages-hero-content">
        <span className="v2-kicker">{kicker}</span>
        <h1>{title}</h1>
        <p className="v2-hero-copy">{description}</p>
        {children}
      </div>
    </section>
  );
}

export function HeroCta({ label = PRIMARY_CTA_LABEL, note = "$79 once, we host it · or self-host free, open source · 30-day money-back guarantee", selfHost = true }: { label?: string; note?: string; selfHost?: boolean }) {
  return (
    <>
      <div className="v2-hero-actions">
        <Link className="v2-primary-cta" href={PRIMARY_CTA_HREF}>{label}</Link>
        {selfHost ? <SelfHostLink className="v2-secondary-cta" /> : null}
      </div>
      <div className="v2-hero-note">{note}</div>
    </>
  );
}

// `eyebrow` is accepted but no longer rendered: section eyebrows were removed sitewide.
export function SectionHeading({ title, description }: { eyebrow?: string; title: ReactNode; description?: string }) {
  return (
    <header className="v2-section-heading">
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
    </header>
  );
}

export function FaqSection({ items, title = "Common questions" }: { items: readonly (readonly [string, string])[]; title?: string }) {
  return (
    <section className="v2-faq pages-faq">
      <h2>{title}</h2>
      <div>{items.map(([question, answer], index) => <details key={question} open={index === 0}><summary><b>{question}</b><span>+</span></summary><p>{answer}</p></details>)}</div>
    </section>
  );
}

export function FinalCta({ title, description, label = PRIMARY_CTA_LABEL, selfHost = true }: { title: string; description: string; label?: string; selfHost?: boolean }) {
  return (
    <section className="v2-final-section">
      <div>
        <div className="v2-stripes" />
        <h2>{title}</h2>
        <p>{description}</p>
        <div className="v2-final-actions">
          <Link href={PRIMARY_CTA_HREF}>{label}</Link>
          {selfHost ? <SelfHostLink className="v2-secondary-cta" /> : null}
        </div>
      </div>
    </section>
  );
}

export function SiteFooter() {
  return (
    <footer className="v2-footer-rich">
      <div className="v2-footer-cols">
        <div className="v2-footer-brand">
          <Logo className="v2-footer-mark" href="/" variant="white" />
          <p>Stupidly simple email outreach. Connect your inbox, let AI draft the sequence, and follow up until someone replies.</p>
        </div>
        <div className="v2-footer-col">
          <h3>Product</h3>
          <Link href="/#features">Features</Link>
          <Link href="/#how-it-works">How it works</Link>
          <Link href="/blog/">Blog</Link>
          <Link href="/docs">Docs</Link>
          <Link href="/#questions">FAQs</Link>
        </div>
        <div className="v2-footer-col">
          <h3>Use cases</h3>
          <Link href="/use-cases/founders">For founders</Link>
          <Link href="/use-cases/sales-teams">For sales teams</Link>
          <Link href="/use-cases/agencies">For agencies</Link>
          <Link href="/use-cases/saas">Cold email for SaaS</Link>
          <Link href="/use-cases/recruiting">Cold email for recruiters</Link>
          <Link href="/use-cases/consulting">Cold email for consultants</Link>
          <Link href="/use-cases/real-estate">Real estate cold email</Link>
          <Link href="/use-cases">All use cases</Link>
        </div>
        <div className="v2-footer-col">
          <h3>Compare</h3>
          <Link href="/alternatives/mailshake">Mailshake alternative</Link>
          <Link href="/alternatives/instantly">Instantly alternative</Link>
          <Link href="/alternatives/smartlead">Smartlead alternative</Link>
          <Link href="/alternatives/lemlist">Lemlist alternative</Link>
          <Link href="/alternatives/apollo">Apollo alternative</Link>
          <Link href="/alternatives/woodpecker">Woodpecker alternative</Link>
          <Link href="/alternatives">All comparisons</Link>
        </div>
        <div className="v2-footer-col">
          <h3>Free tools</h3>
          <Link href="/free-tools/subject-line-checker">Subject line checker</Link>
          <Link href="/free-tools/spam-word-checker">Spam word checker</Link>
          <Link href="/free-tools/spf-dkim-dmarc-checker">SPF, DKIM & DMARC checker</Link>
          <Link href="/free-tools/warmup-calculator">Warmup calculator</Link>
          <Link href="/free-tools/bounce-rate-calculator">Bounce rate calculator</Link>
          <Link href="/free-tools">All free tools</Link>
        </div>
      </div>

      <div className="v2-footer-legal">
        <span>© {new Date().getFullYear()}. All rights reserved.</span>
        <span><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link><NavAuthLink /></span>
      </div>

    </footer>
  );
}

export function CheckList({ items }: { items: readonly string[] }) {
  return <ul className="pages-check-list">{items.map((item) => <li key={item}><i><Check aria-hidden="true" size={11} strokeWidth={3} /></i><span>{item}</span></li>)}</ul>;
}

export function RouteCard({ href, label, title, description, cta }: { href: string; label: string; title: string; description: string; cta: string }) {
  return (
    <article className="pages-route-card">
      <span>{label}</span>
      <h3>{title}</h3>
      <p>{description}</p>
      <Link href={href}>{cta} <i>→</i></Link>
    </article>
  );
}
