// Pure helpers for the affiliate "ref" query param. Kept dependency-free so the
// referral capture component (apps/web/components/affiliate-ref-capture.tsx) and
// its unit test can both import this without pulling in React.

const REF_CODE_PATTERN = /^[a-z0-9]{4,32}$/;

/**
 * Normalizes a raw `ref` query value into a lowercase affiliate code, or
 * returns null when it does not look like one. Never throws.
 */
export function normalizeRefCode(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const candidate = raw.trim().toLowerCase();
  return REF_CODE_PATTERN.test(candidate) ? candidate : null;
}
