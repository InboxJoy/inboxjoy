"use client";

import { createContext, useContext, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import type { Edition } from "@/lib/edition";
import { editionFeatures, isMarketingPath, type EditionFeatures } from "@/lib/edition-features";

const EditionContext = createContext<Edition | null>(null);

// Mounted by the /app and /docs layouts (components/edition-scope.tsx), which
// read the edition from the environment on every request (never at build time:
// one image serves both editions). Marketing pages are static and outside it.
export function EditionProvider({ edition, children }: { edition: Edition; children: ReactNode }) {
  return <EditionContext.Provider value={edition}>{children}</EditionContext.Provider>;
}

export function useEdition(): Edition {
  const edition = useContext(EditionContext);
  if (!edition) throw new Error("useEdition must be used inside EditionProvider.");
  return edition;
}

export function useEditionFeatures(): EditionFeatures {
  return editionFeatures(useEdition());
}

// Renders its children on marketing and legal routes only. Those are cloud by
// construction (self-host redirects them to /app in proxy.ts), which lets the
// static root layout mount cloud-only extras there without reading the edition.
export function MarketingRoutesOnly({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return pathname && isMarketingPath(pathname) ? children : null;
}
