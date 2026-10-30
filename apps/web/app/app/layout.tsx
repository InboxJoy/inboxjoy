import type { Metadata } from "next";
import type { ReactNode } from "react";
import { EditionScope } from "@/components/edition-scope";
import { getRequestEdition } from "@/lib/edition";
import { editionMetadata } from "@/lib/edition-metadata";

// The product, its sign-in pages and OAuth consent. Both editions serve them,
// so they render per request with the running server's edition (the root
// layout is static and edition-agnostic).
export async function generateMetadata(): Promise<Metadata> {
  return editionMetadata(await getRequestEdition());
}

export default async function AppLayout({ children }: { children: ReactNode }) {
  return <EditionScope edition={await getRequestEdition()}>{children}</EditionScope>;
}
