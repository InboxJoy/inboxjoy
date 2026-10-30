import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import "../pages.css";
import { Logo } from "@/components/logo";
import { NavAuthLink } from "@/components/nav-auth-link";
import { DocsNav } from "./docs-nav";
import { AnnouncementBanner } from "@/components/announcement-banner";
import { EditionScope } from "@/components/edition-scope";
import { getRequestEdition } from "@/lib/edition";
import { editionMetadata } from "@/lib/edition-metadata";

// Both editions serve the docs, so they render per request with the running
// server's edition (the root layout is static and edition-agnostic).
export async function generateMetadata(): Promise<Metadata> {
  return editionMetadata(await getRequestEdition());
}

export default async function DocsLayout({ children }: { children: ReactNode }) {
  const edition = await getRequestEdition();
  // Self-host keeps the product docs but has no pricing page or licence offer.
  const cloud = edition === "cloud";
  return (
    <EditionScope edition={edition}>
      <div className="docs-site">
        {cloud ? <AnnouncementBanner /> : null}
        <link href="https://fonts.googleapis.com/css2?family=Google+Sans+Flex:wght@400..800&display=swap" rel="stylesheet" />
        <header className="docs-topbar">
          <div className="docs-topbar-inner">
            <div className="docs-brand-row">
              <Logo className="docs-brand" href="/" size="sm" />
              <span className="docs-product-label">Docs</span>
            </div>
            <nav className="docs-top-links" aria-label="Account links">
              <NavAuthLink />
              {cloud ? <Link href="/pricing">Pricing</Link> : null}
            </nav>
          </div>
        </header>
        <div className="docs-frame">
          <DocsNav />
          <main className="docs-main">
            <div className="docs-content">{children}</div>
          </main>
        </div>
      </div>
    </EditionScope>
  );
}
