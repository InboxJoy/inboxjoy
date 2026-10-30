import { breadcrumbJsonLd, JsonLd, type Crumb } from "../_pages/seo";
import { DOC_PAGES } from "./_data";

/**
 * BreadcrumbList JSON-LD for a docs page: Home -> Docs -> {Page}.
 * Pass "/docs" for the overview page to get Home -> Docs only.
 * Schema only — renders no visible breadcrumb UI.
 */
export function DocsBreadcrumbJsonLd({ href }: { href: string }) {
  const crumbs: readonly Crumb[] =
    href === "/docs"
      ? [["Home", "/"], ["Docs", "/docs"]]
      : [["Home", "/"], ["Docs", "/docs"], [DOC_PAGES.find((page) => page.href === href)?.title ?? href, href]];

  return <JsonLd data={breadcrumbJsonLd(crumbs)} />;
}
