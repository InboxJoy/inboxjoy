import type { Metadata } from "next";
import { Suspense, type ReactNode } from "react";
import { MarketingRoutesOnly } from "@/components/edition-provider";
import { HostedSiteExtras } from "@/components/edition-scope";
import { SessionRecordingGate } from "@/components/session-recording-gate";
import "./globals.css";
import "./marketing.css";

// Edition-agnostic and static, so the marketing site is prerendered. Never read
// the edition here: Next would bake the build machine's value (images are built
// without one, so self-host) into every static page. Only cloud serves the
// marketing and legal pages (proxy.ts sends self-host to /app), so this layout
// describes the hosted site. Pages both editions serve, /app and /docs, read the
// edition per request in their own layouts (getRequestEdition) and wrap
// themselves in EditionScope, which also makes a self-host instance noindex.
const siteUrl = "https://inboxjoy.online";
const siteName = "InboxJoy";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  applicationName: siteName,
  category: "business software",
  creator: siteName,
  publisher: siteName,
  title: {
    default: "InboxJoy — The Simple Email Sequence Tool",
    template: "%s | InboxJoy",
  },
  description: "Email sequencing for Gmail and Outlook. $79 lifetime, or self-host free.",
  alternates: { canonical: "/" },
  icons: {
    icon: [
      { url: "/brand/icon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/brand/icon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/brand/icon-256x256.png", sizes: "256x256", type: "image/png" },
    ],
    apple: [{ url: "/brand/icon-180x180.png", sizes: "180x180", type: "image/png" }],
  },
  openGraph: {
    siteName,
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <MarketingRoutesOnly><HostedSiteExtras edition="cloud" /></MarketingRoutesOnly>
        <Suspense fallback={null}><SessionRecordingGate /></Suspense>
        {children}
      </body>
    </html>
  );
}
