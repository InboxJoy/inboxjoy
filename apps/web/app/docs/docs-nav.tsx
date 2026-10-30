"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DOC_GROUPS, DOC_OVERVIEW } from "./_data";

function NavLinks({ pathname }: { pathname: string }) {
  const normalizedPathname = pathname.replace(/\/$/, "") || "/";

  return (
    <>
      <Link className={normalizedPathname === DOC_OVERVIEW.href ? "docs-nav-active" : undefined} href={DOC_OVERVIEW.href}>
        {DOC_OVERVIEW.label}
      </Link>
      {DOC_GROUPS.map((group) => (
        <div className="docs-nav-group" key={group.title}>
          <p>{group.title}</p>
          {group.pages.map((page) => (
            <Link className={normalizedPathname === page.href ? "docs-nav-active" : undefined} href={page.href} key={page.href}>
              {page.label}
            </Link>
          ))}
        </div>
      ))}
    </>
  );
}

export function DocsNav() {
  const pathname = usePathname();
  const normalizedPathname = pathname.replace(/\/$/, "") || "/";
  const activePage = [DOC_OVERVIEW, ...DOC_GROUPS.flatMap((group) => group.pages)].find((page) => page.href === normalizedPathname);

  return (
    <>
      <aside className="docs-sidebar" aria-label="Documentation navigation">
        <nav className="docs-nav">
          <NavLinks pathname={pathname} />
        </nav>
      </aside>
      <details className="docs-mobile-nav">
        <summary>
          <span>Documentation</span>
          <strong>{activePage?.label ?? "Browse"}</strong>
        </summary>
        <nav className="docs-nav" aria-label="Documentation navigation">
          <NavLinks pathname={pathname} />
        </nav>
      </details>
    </>
  );
}
