"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { GithubNavLink } from "@/components/github-mark";
import { Logo } from "@/components/logo";
import { NavAuthLink } from "@/components/nav-auth-link";
import { ANNOUNCEMENT_HEIGHT_EVENT } from "@/components/announcement-banner";
import { PRIMARY_CTA_HREF, PRIMARY_CTA_LABEL } from "@/lib/site-links";

const LINKS = [
  { href: "/#features", label: "Features" },
  { href: "/#how-it-works", label: "How it works" },
  { href: "/pricing", label: "Pricing" },
  { href: "/blog/", label: "Blog" },
  { href: "/#questions", label: "FAQs" },
] as const;

/**
 * The in-hero nav can't be sticky: it lives inside .v2-hero-panel, which clips
 * with overflow: hidden. This is a separate floating bar that fades in once the
 * hero nav has scrolled away.
 */
export function StickyNav() {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      const announcementHeight = document.querySelector<HTMLElement>("[data-announcement-banner]")?.offsetHeight ?? 0;
      setShown(window.scrollY > 260 + announcementHeight);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener(ANNOUNCEMENT_HEIGHT_EVENT, onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener(ANNOUNCEMENT_HEIGHT_EVENT, onScroll);
    };
  }, []);

  return (
    <div className={`v2-sticky-nav${shown ? " is-shown" : ""}`} aria-hidden={!shown}>
      <nav aria-label="Sticky navigation">
        <Logo className="v2-sticky-brand" href="/" size="sm" tabIndex={shown ? 0 : -1} variant="white" />
        <div className="v2-sticky-links">
          {LINKS.map((link) => <Link key={link.href} href={link.href} tabIndex={shown ? 0 : -1}>{link.label}</Link>)}
        </div>
        <div className="v2-sticky-actions">
          <NavAuthLink tabIndex={shown ? 0 : -1} />
          <GithubNavLink tabIndex={shown ? 0 : -1} />
          <Link className="v2-sticky-cta" href={PRIMARY_CTA_HREF} tabIndex={shown ? 0 : -1}>{PRIMARY_CTA_LABEL}</Link>
        </div>
      </nav>
    </div>
  );
}
