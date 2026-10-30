"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";

type Severity = "high" | "medium" | "low";

const triggerGroups: { severity: Severity; terms: string[] }[] = [
  { severity: "high", terms: ["100% free", "act now", "buy now", "cash bonus", "click here", "congratulations", "earn cash", "free money", "guaranteed", "no obligation", "order now", "risk free", "urgent", "winner"] },
  { severity: "medium", terms: ["apply now", "discount", "exclusive", "free", "instant access", "limited time", "lowest price", "offer", "save big", "special promotion"] },
  { severity: "low", terms: ["amazing", "bonus", "don't miss", "important", "incredible", "opportunity", "please read", "reminder", "trial"] },
];

const allTriggers = triggerGroups.flatMap((group) => group.terms.map((term) => ({ term, severity: group.severity }))).sort((a, b) => b.term.length - a.term.length);

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const source = allTriggers.map(({ term }) => escapeRegExp(term)).join("|");
const scanPattern = new RegExp(`\\b(${source})\\b`, "gi");
const splitPattern = new RegExp(`(\\b(?:${source})\\b)`, "gi");

function severityFor(term: string): Severity {
  return allTriggers.find((trigger) => trigger.term.toLowerCase() === term.toLowerCase())?.severity ?? "low";
}

function analyzeBody(body: string) {
  const matches = body.match(scanPattern) ?? [];
  const uniqueMatches = [...new Set(matches.map((match) => match.toLowerCase()))];
  const counts = { high: 0, medium: 0, low: 0 };
  matches.forEach((match) => { counts[severityFor(match)] += 1; });
  const weighted = counts.high * 3 + counts.medium * 2 + counts.low;
  const label = weighted === 0 ? "No listed triggers found" : weighted <= 3 ? "Light edit suggested" : weighted <= 8 ? "Review the highlighted copy" : "Heavy promotional language";
  return { matches, uniqueMatches, counts, weighted, label };
}

function highlightBody(body: string): ReactNode[] {
  if (!body) return [];
  return body.split(splitPattern).map((part, index) => {
    const matched = allTriggers.some(({ term }) => term.toLowerCase() === part.toLowerCase());
    return matched ? <mark data-severity={severityFor(part)} key={`${part}-${index}`}>{part}</mark> : <span key={`${part}-${index}`}>{part}</span>;
  });
}

export function SpamWordChecker() {
  const [body, setBody] = useState("Hi {{firstName}},\n\nQuick question about {{company}}. We help small teams build a consistent outbound rhythm without adding a heavyweight sales platform.\n\nWorth a short conversation next week?");
  const result = useMemo(() => analyzeBody(body), [body]);
  const highlighted = useMemo(() => highlightBody(body), [body]);
  const wordCount = body.trim() ? body.trim().split(/\s+/).length : 0;

  return (
    <div className="pages-tool-shell">
      <div className="pages-tool-input">
        <label htmlFor="email-body">Email body</label>
        <textarea id="email-body" value={body} onChange={(event) => setBody(event.target.value)} placeholder="Paste your email copy here" />
        <div className="pages-input-meta"><span>Analyzed locally in your browser</span><span>{wordCount} words</span></div>
        <div className="pages-highlight-output" aria-label="Highlighted email copy">{highlighted.length ? highlighted : "Your highlighted copy will appear here."}</div>
      </div>
      <aside className="pages-tool-result" aria-live="polite">
        <div className="pages-score"><strong>{result.matches.length}</strong><span><b>{result.label}</b><small>Total trigger matches</small></span></div>
        <div className="pages-trigger-summary"><div><strong>{result.counts.high}</strong><span>High</span></div><div><strong>{result.counts.medium}</strong><span>Medium</span></div><div><strong>{result.counts.low}</strong><span>Low</span></div></div>
        {result.uniqueMatches.length ? <><p className="pages-empty-state">Matched phrases:</p><div className="pages-match-list">{result.uniqueMatches.map((match) => <span key={match}>{match} · {severityFor(match)}</span>)}</div></> : <p className="pages-empty-state">No phrase from this tool&apos;s trigger list appears in the current copy.</p>}
        <p className="pages-tool-soft-cta">Context matters, and no word list can predict inbox placement. When the copy is ready, <Link href="/app/signup?plan=lifetime">get the InboxJoy lifetime license</Link> to build the sequence and control the sending pace.</p>
      </aside>
    </div>
  );
}
