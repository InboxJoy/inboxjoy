"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

type Tone = "pass" | "warn" | "fail";

type RecordResult = {
  key: string;
  title: string;
  tone: Tone;
  summary: string;
  raw: string | null;
  detail: string;
  fix: string;
};

const commonSelectors = ["google", "selector1", "selector2", "default", "k1", "s1"];

function normalizeDomain(input: string): string {
  let value = input.trim().toLowerCase();
  value = value.replace(/^mailto:/, "");
  value = value.replace(/^https?:\/\//, "");
  if (value.includes("@")) value = value.split("@").pop() ?? value;
  value = value.split(/[/?#]/)[0] ?? value;
  value = value.replace(/:\d+$/, "");
  value = value.replace(/\.$/, "");
  return value;
}

function normalizeSelector(input: string): string | null {
  const value = input.trim().toLowerCase().replace(/\._domainkey.*$/, "");
  const cleaned = value.replace(/[^a-z0-9._-]/g, "");
  return cleaned || null;
}

const domainPattern = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

function joinTxt(raw: string): string {
  return raw
    .split('" "')
    .map((chunk) => chunk.replace(/^"/, "").replace(/"$/, ""))
    .join("")
    .replace(/\\"/g, '"');
}

async function dohQuery(name: string): Promise<string[]> {
  const urls = [
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`,
    `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=TXT`,
  ];
  let lastError: Error | null = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { accept: "application/dns-json" } });
      if (!res.ok) throw new Error(`DNS resolver returned status ${res.status}`);
      const json = (await res.json()) as { Answer?: { type: number; data: string }[] };
      const answers = json.Answer ?? [];
      return answers.filter((entry) => entry.type === 16).map((entry) => joinTxt(entry.data));
    } catch (err) {
      lastError = err instanceof Error ? err : new Error("DNS lookup failed");
    }
  }
  throw lastError ?? new Error("DNS lookup failed");
}

function parseTags(raw: string): Record<string, string> {
  const tags: Record<string, string> = {};
  raw.split(";").forEach((part) => {
    const trimmed = part.trim();
    if (!trimmed) return;
    const eq = trimmed.indexOf("=");
    if (eq === -1) return;
    const key = trimmed.slice(0, eq).trim().toLowerCase();
    const value = trimmed.slice(eq + 1).trim();
    if (key) tags[key] = value;
  });
  return tags;
}

function analyzeSpf(records: string[]): RecordResult {
  const spfRecords = records.filter((record) => /^v=spf1(\s|$)/i.test(record.trim()));

  if (!spfRecords.length) {
    return {
      key: "spf",
      title: "SPF",
      tone: "fail",
      summary: "No SPF record found",
      raw: null,
      detail:
        "No TXT record starting with v=spf1 exists at the domain root. Without SPF, receiving servers have no list of which services are allowed to send mail as this domain.",
      fix: "Add a TXT record at the domain root, for example v=spf1 include:_spf.google.com ~all for Google Workspace, or v=spf1 include:spf.protection.outlook.com ~all for Microsoft 365.",
    };
  }

  if (spfRecords.length > 1) {
    return {
      key: "spf",
      title: "SPF",
      tone: "fail",
      summary: `${spfRecords.length} SPF records found — only one is allowed`,
      raw: spfRecords.join("\n"),
      detail:
        "A domain is only allowed one SPF record. Two or more make SPF evaluation return a permanent error for every receiving server, which behaves the same as having no SPF at all.",
      fix: "Combine every include: mechanism from both records into a single v=spf1 line, then delete the extra TXT record.",
    };
  }

  const raw = spfRecords[0]!;
  const lookupCount = (raw.match(/\b(include|a|mx|ptr|exists|redirect)(:|(?=\s|$))/gi) ?? []).length;
  const usesGoogle = /_spf\.google\.com/i.test(raw);
  const usesMicrosoft = /spf\.protection\.outlook\.com/i.test(raw);

  let tone: Tone = "pass";
  let allNote: string;
  if (/-all\s*$/i.test(raw)) {
    allNote = "Ends in -all (hard fail), the strictest setting — servers that fail the SPF check are rejected outright.";
  } else if (/~all\s*$/i.test(raw)) {
    allNote =
      "Ends in ~all (soft fail), a widely used default that flags unauthorized senders for spam filtering without hard-rejecting them.";
  } else if (/\?all\s*$/i.test(raw)) {
    tone = "warn";
    allNote = "Ends in ?all (neutral), which tells receivers not to enforce the SPF check at all, weakening the protection it offers.";
  } else if (/\+all\s*$/i.test(raw)) {
    tone = "fail";
    allNote = "Ends in +all, which allows any server on the internet to send as this domain and will badly hurt deliverability.";
  } else {
    tone = "warn";
    allNote = "No recognizable all mechanism (-all, ~all, or ?all) was found at the end of the record.";
  }

  let lookupNote = "";
  if (lookupCount > 10) {
    if (tone === "pass") tone = "warn";
    lookupNote = ` This record uses about ${lookupCount} DNS-lookup mechanisms, over the 10-lookup limit most receiving servers enforce, so it may be treated as a permanent error.`;
  }

  const providerNote = usesGoogle
    ? " Includes Google Workspace's SPF range (_spf.google.com)."
    : usesMicrosoft
      ? " Includes Microsoft 365's SPF range (spf.protection.outlook.com)."
      : "";

  return {
    key: "spf",
    title: "SPF",
    tone,
    summary: tone === "pass" ? "Valid SPF record" : tone === "warn" ? "SPF record needs attention" : "SPF record misconfigured",
    raw,
    detail: `${allNote}${lookupNote}${providerNote}`,
    fix:
      tone === "pass"
        ? "No action needed."
        : lookupCount > 10
          ? "Flatten nested includes or remove unused ones to bring the DNS-lookup count to 10 or fewer."
          : "Update the record to end in ~all (or -all once every legitimate sending source is confirmed) instead of ?all or +all.",
  };
}

function analyzeDmarc(records: string[]): RecordResult {
  const dmarcRecords = records.filter((record) => /^v=dmarc1(\s|;)/i.test(record.trim()));

  if (!dmarcRecords.length) {
    return {
      key: "dmarc",
      title: "DMARC",
      tone: "fail",
      summary: "No DMARC record found",
      raw: null,
      detail:
        "No TXT record starting with v=DMARC1 exists at _dmarc.<domain>. Without DMARC, there is no policy telling receiving servers what to do with mail that fails SPF or DKIM, and Google and Yahoo's 2024 bulk-sender rules expect one from any domain sending meaningful volume.",
      fix: "Add a TXT record at _dmarc.yourdomain.com: v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com — start at p=none to monitor, then move to quarantine or reject.",
    };
  }

  const raw = dmarcRecords[0]!;
  const tags = parseTags(raw);
  const p = tags.p?.toLowerCase();
  const hasRua = Boolean(tags.rua);
  const pct = tags.pct ?? "100";
  const sp = tags.sp?.toLowerCase();

  let tone: Tone;
  let policyNote: string;
  if (p === "reject" || p === "quarantine") {
    tone = "pass";
    policyNote = `Policy is p=${p}, which tells receivers to act on mail that fails authentication.`;
  } else if (p === "none") {
    tone = "warn";
    policyNote = "Policy is p=none — DMARC is in monitor-only mode and isn't yet protecting the domain from spoofing.";
  } else {
    tone = "fail";
    policyNote = "The p= tag is missing or set to an invalid value, which most receivers treat the same as having no DMARC policy.";
  }

  const ruaNote = hasRua
    ? " Aggregate reports (rua) are configured, so failures stay visible over time."
    : " No rua reporting address is set, so authentication failures won't be visible anywhere.";
  const pctNote = pct !== "100" ? ` The policy currently applies to only ${pct}% of mail (pct=${pct}).` : "";
  const spNote = sp ? ` Subdomain policy is explicitly set to sp=${sp}.` : "";

  return {
    key: "dmarc",
    title: "DMARC",
    tone,
    summary:
      tone === "pass" ? `DMARC enforced at p=${p}` : tone === "warn" ? "DMARC set to monitor-only (p=none)" : "DMARC record invalid",
    raw,
    detail: `${policyNote}${ruaNote}${pctNote}${spNote}`,
    fix:
      tone === "pass"
        ? hasRua
          ? "No action needed."
          : "Add rua=mailto:dmarc@yourdomain.com to start receiving aggregate failure reports."
        : tone === "warn"
          ? "Once a few weeks of rua reports show no legitimate mail failing, move to p=quarantine and then p=reject."
          : "Fix the p= tag so it's exactly one of none, quarantine, or reject — for example v=DMARC1; p=quarantine; rua=mailto:dmarc@yourdomain.com.",
  };
}

function isRevokedDkim(record: string): boolean {
  if (!/v=dkim1/i.test(record) && !/p=/i.test(record)) return false;
  const tags = parseTags(record);
  return "p" in tags && tags.p === "";
}

async function analyzeDkim(domain: string, customSelector: string | null): Promise<RecordResult> {
  const selectors = customSelector ? [customSelector, ...commonSelectors.filter((selector) => selector !== customSelector)] : commonSelectors;

  const settled = await Promise.allSettled(
    selectors.map(async (selector) => ({ selector, records: await dohQuery(`${selector}._domainkey.${domain}`) })),
  );

  const checked = settled
    .filter((result): result is PromiseFulfilledResult<{ selector: string; records: string[] }> => result.status === "fulfilled")
    .map((result) => result.value);

  const found = checked.filter((entry) => entry.records.some((record) => /v=dkim1|(^|;)\s*p=/i.test(record)));

  if (!found.length) {
    return {
      key: "dkim",
      title: "DKIM",
      tone: "warn",
      summary: "Not found on common selectors — enter your selector",
      raw: null,
      detail: `Checked selectors: ${selectors.join(", ")}. DKIM selectors are set by your email provider and vary widely, so a miss here doesn't necessarily mean DKIM is missing.`,
      fix: "Find your DKIM selector in your email provider's authentication settings (Google Workspace admin console, Microsoft 365 admin center, or your ESP's domain settings), enter it above, and re-run the check.",
    };
  }

  const revoked = found.filter((entry) => entry.records.some((record) => isRevokedDkim(record)));
  const active = found.filter((entry) => !revoked.includes(entry));

  if (active.length) {
    return {
      key: "dkim",
      title: "DKIM",
      tone: "pass",
      summary: `Active DKIM key found on selector "${active[0]!.selector}"`,
      raw: active.map((entry) => `${entry.selector}._domainkey: ${entry.records.join(" ")}`).join("\n"),
      detail: `${active.length} selector${active.length > 1 ? "s" : ""} publish an active public key. Checked: ${selectors.join(", ")}.`,
      fix: "No action needed. Rotate the key periodically and keep the matching private key restricted to your sending provider.",
    };
  }

  return {
    key: "dkim",
    title: "DKIM",
    tone: "warn",
    summary: `DKIM key on selector "${revoked[0]!.selector}" is revoked (empty p=)`,
    raw: revoked.map((entry) => `${entry.selector}._domainkey: ${entry.records.join(" ")}`).join("\n"),
    detail: "An empty p= tag means the key was intentionally revoked. Mail signed with this selector will fail DKIM verification.",
    fix: "Generate a new DKIM key in your email provider's settings and publish the new selector, or switch signing to an active selector.",
  };
}

function toneLabel(tone: Tone) {
  return tone === "pass" ? "Pass" : tone === "warn" ? "Warning" : "Fail";
}

function RecordCard({ result }: { result: RecordResult }) {
  return (
    <article className="dns-check-record" data-tone={result.tone}>
      <header className="dns-check-record-header">
        <h3>{result.title}</h3>
        <span className="dns-check-status" data-tone={result.tone}>
          {toneLabel(result.tone)}
        </span>
      </header>
      <p className="dns-check-summary">{result.summary}</p>
      {result.raw ? <pre className="dns-check-raw">{result.raw}</pre> : null}
      <p className="dns-check-detail">{result.detail}</p>
      <p className="dns-check-fix">
        <b>Fix:</b> {result.fix}
      </p>
    </article>
  );
}

export function DnsChecker() {
  const [domainInput, setDomainInput] = useState("");
  const [selectorInput, setSelectorInput] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [checkedDomain, setCheckedDomain] = useState<string | null>(null);
  const [results, setResults] = useState<RecordResult[] | null>(null);

  async function runCheck(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = normalizeDomain(domainInput);

    if (!domainPattern.test(normalized)) {
      setStatus("error");
      setError("Enter a valid domain, like acme.com or you@acme.com.");
      setResults(null);
      return;
    }

    setStatus("loading");
    setError(null);
    setCheckedDomain(normalized);

    try {
      const [spfRecords, dmarcRecords, dkim] = await Promise.all([
        dohQuery(normalized),
        dohQuery(`_dmarc.${normalized}`),
        analyzeDkim(normalized, normalizeSelector(selectorInput)),
      ]);
      setResults([analyzeSpf(spfRecords), analyzeDmarc(dmarcRecords), dkim]);
      setStatus("done");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Lookup failed. The DNS resolver may be unreachable — try again in a moment.");
      setResults(null);
    }
  }

  return (
    <div className="pages-tool-shell">
      <div className="pages-tool-input">
        <form onSubmit={runCheck}>
          <label htmlFor="dns-domain">Domain</label>
          <input
            id="dns-domain"
            value={domainInput}
            onChange={(event) => setDomainInput(event.target.value)}
            placeholder="acme.com or you@acme.com"
            autoComplete="off"
            spellCheck={false}
          />
          <label htmlFor="dns-selector" className="dns-check-selector-label">
            DKIM selector (optional)
          </label>
          <input
            id="dns-selector"
            value={selectorInput}
            onChange={(event) => setSelectorInput(event.target.value)}
            placeholder="e.g. google, selector1"
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit" className="dns-check-submit" disabled={status === "loading"}>
            {status === "loading" ? "Checking records…" : "Check SPF, DKIM & DMARC"}
          </button>
        </form>
        <div className="pages-input-meta">
          <span>Looked up via a public DNS resolver</span>
          <span>{checkedDomain ?? "no domain checked yet"}</span>
        </div>
        {status === "error" && error ? <p className="dns-check-error">{error}</p> : null}
      </div>
      <aside className="pages-tool-result" aria-live="polite">
        {status === "idle" ? (
          <p className="pages-empty-state">Enter a domain and run a check to see SPF, DKIM, and DMARC status.</p>
        ) : null}
        {status === "loading" ? <p className="pages-empty-state">Querying SPF, DKIM, and DMARC records…</p> : null}
        {results ? (
          <div className="dns-check-records">
            {results.map((result) => (
              <RecordCard key={result.key} result={result} />
            ))}
          </div>
        ) : null}
        <p className="pages-tool-soft-cta">
          Lookups query a public DNS resolver (Cloudflare or Google) directly from your browser, which is the only place your domain name
          is sent — InboxJoy doesn't receive, log, or store it. Once records pass, <Link href="/app/signup?plan=lifetime">get the InboxJoy lifetime license</Link> to
          send from a warmed-up, rotating pool of mailboxes.
        </p>
      </aside>
    </div>
  );
}
