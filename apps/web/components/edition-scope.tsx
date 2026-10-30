import type { ReactNode } from "react";
import { AffiliateRefCapture } from "@/components/affiliate-ref-capture";
import { EditionProvider } from "@/components/edition-provider";
import { PiqoAnalytics } from "@/components/piqo-analytics";
import type { Edition } from "@/lib/edition";
import { editionFeatures } from "@/lib/edition-features";

const siteUrl = "https://inboxjoy.online";

const organizationJsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  "@id": `${siteUrl}/#organization`,
  name: "InboxJoy",
  url: siteUrl,
  logo: `${siteUrl}/brand/icon-256x256.png`,
};

const websiteJsonLd = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  "@id": `${siteUrl}/#website`,
  name: "InboxJoy",
  url: siteUrl,
  publisher: { "@id": `${siteUrl}/#organization` },
  inLanguage: "en-US",
};

// The hosted site's commercial layer: its JSON-LD, ?ref= capture and Piqo.
// Self-host gets none of it.
export function HostedSiteExtras({ edition }: { edition: Edition }) {
  const features = editionFeatures(edition);
  return <>
    {features.marketingSite ? <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(websiteJsonLd) }} />
    </> : null}
    {features.affiliate ? <AffiliateRefCapture /> : null}
    {features.piqo ? <PiqoAnalytics /> : null}
  </>;
}

// Wraps the pages both editions serve (/app and /docs), whose layouts read the
// edition per request with getRequestEdition(). Marketing pages stay static
// without it: only cloud serves them (proxy.ts), so the root layout mounts
// their extras as cloud.
export function EditionScope({ edition, children }: { edition: Edition; children: ReactNode }) {
  return (
    <EditionProvider edition={edition}>
      <HostedSiteExtras edition={edition} />
      {children}
    </EditionProvider>
  );
}
