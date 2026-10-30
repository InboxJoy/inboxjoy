import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { getEdition } from "@/lib/edition";
import { editionFeatures } from "@/lib/edition-features";

// The affiliate program belongs to the hosted edition; self-host has no such
// page. Read per request: the /app layout renders dynamically.
export default function AffiliateLayout({ children }: { children: ReactNode }) {
  if (!editionFeatures(getEdition()).affiliate) notFound();
  return children;
}
