import Link from "next/link";
import { RouteCard } from "./site";

const siteUrl = "https://inboxjoy.online";

export function JsonLd({ data }: { data: object | object[] }) {
  const blocks = Array.isArray(data) ? data : [data];
  return (
    <>
      {blocks.map((block, index) => (
        <script key={index} type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(block) }} />
      ))}
    </>
  );
}

export function faqPageJsonLd(faqs: readonly (readonly [string, string])[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map(([question, answer]) => ({
      "@type": "Question",
      name: question,
      acceptedAnswer: { "@type": "Answer", text: answer },
    })),
  };
}

export function webApplicationJsonLd({ name, path, description }: { name: string; path: string; description: string }) {
  return {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name,
    url: `${siteUrl}${path}`,
    description,
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    publisher: { "@id": `${siteUrl}/#organization` },
  };
}

export type Crumb = readonly [label: string, path: string];

export function breadcrumbJsonLd(crumbs: readonly Crumb[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map(([label, path], index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: label,
      item: `${siteUrl}${path}`,
    })),
  };
}

/** Visible breadcrumb trail + matching BreadcrumbList JSON-LD. Pass the full trail starting at Home. */
export function Breadcrumbs({ crumbs }: { crumbs: readonly Crumb[] }) {
  return (
    <>
      <JsonLd data={breadcrumbJsonLd(crumbs)} />
      <nav className="pages-breadcrumbs" aria-label="Breadcrumb">
        <ol>
          {crumbs.map(([label, path], index) => (
            <li key={path}>
              {index < crumbs.length - 1 ? <Link href={path}>{label}</Link> : <span aria-current="page">{label}</span>}
            </li>
          ))}
        </ol>
      </nav>
    </>
  );
}

export type RelatedLink = { href: string; label: string; title: string; description: string; cta: string };

/** "Related X" cross-link module — sibling pages within the same archetype. */
export function RelatedPages({ title, description, links }: { eyebrow?: string; title: string; description?: string; links: readonly RelatedLink[] }) {
  return (
    <section className="v2-section pages-related">
      <header className="v2-section-heading">
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </header>
      <div className="pages-card-grid">
        {links.map((link) => (
          <RouteCard key={link.href} {...link} />
        ))}
      </div>
    </section>
  );
}
