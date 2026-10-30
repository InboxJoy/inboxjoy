import Link from "next/link";
import { DOC_PAGES } from "./_data";

export function DocsPager({ currentHref }: { currentHref: string }) {
  const currentIndex = DOC_PAGES.findIndex((page) => page.href === currentHref);
  const previous = currentIndex > 0 ? DOC_PAGES[currentIndex - 1] : undefined;
  const next = currentIndex >= 0 && currentIndex < DOC_PAGES.length - 1 ? DOC_PAGES[currentIndex + 1] : undefined;

  return (
    <nav className="docs-pager" aria-label="Previous and next documentation pages">
      {previous ? (
        <Link href={previous.href} rel="prev">
          <span>Previous</span>
          <strong>← {previous.label}</strong>
        </Link>
      ) : <span />}
      {next ? (
        <Link href={next.href} rel="next">
          <span>Next</span>
          <strong>{next.label} →</strong>
        </Link>
      ) : <span />}
    </nav>
  );
}
