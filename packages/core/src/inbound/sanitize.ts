// Postgres rejects U+0000 in both text and jsonb, and jsonb additionally rejects
// an unpaired surrogate escape. A mailbox message that decodes to either would
// otherwise fail to store on every poll and block everything queued behind it.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const NUL = /\u0000/g;

export function sanitizeStoredString(value: string): string {
  return value.replace(LONE_SURROGATE, "�").replace(NUL, "");
}

// Recurses through arrays and plain objects (keys included). Anything else --
// numbers, booleans, null, Dates, Buffers -- is returned untouched.
export function sanitizeStoredStrings<T>(value: T): T {
  if (typeof value === "string") return sanitizeStoredString(value) as T;
  if (Array.isArray(value)) return value.map((item) => sanitizeStoredStrings(item)) as T;
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [sanitizeStoredString(key), sanitizeStoredStrings(item)])) as T;
  }
  return value;
}
