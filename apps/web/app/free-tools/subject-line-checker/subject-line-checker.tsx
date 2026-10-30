"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

const spamTriggers = ["100% free", "act now", "buy now", "cash bonus", "click here", "congratulations", "free money", "guaranteed", "limited time", "no obligation", "risk free", "urgent", "winner"];
const urgencyWords = ["act now", "asap", "deadline", "ending", "expires", "final chance", "last chance", "limited time", "now", "today", "urgent"];
const personalizationPattern = /\{\{\s*(firstName|company|title)\s*\}\}|\[(first name|company|title)\]/i;

type Feedback = { label: string; message: string; tone: "good" | "warn" | "bad" };

function countMatches(value: string, terms: string[]) {
  const normalized = value.toLowerCase();
  return terms.filter((term) => normalized.includes(term));
}

function analyzeSubject(subject: string) {
  const clean = subject.trim();
  const length = clean.length;
  const spamMatches = countMatches(clean, spamTriggers);
  const urgencyMatches = countMatches(clean, urgencyWords);
  const questionCount = (clean.match(/\?/g) ?? []).length;
  const hasPersonalization = personalizationPattern.test(clean);
  const feedback: Feedback[] = [];
  let score = 100;

  if (!clean) return { score: 0, label: "Add a subject line", feedback: [] as Feedback[], length, spamMatches, urgencyMatches };

  if (length >= 25 && length <= 50) feedback.push({ label: "Length", message: `${length} characters is a concise, scannable range.`, tone: "good" });
  else if (length >= 15 && length <= 60) { score -= 10; feedback.push({ label: "Length", message: `${length} characters is workable, though 25–50 is a stronger editing target.`, tone: "warn" }); }
  else if (length < 15) { score -= 22; feedback.push({ label: "Length", message: `${length} characters may be too vague to communicate a useful reason to open.`, tone: "warn" }); }
  else { score -= 25; feedback.push({ label: "Length", message: `${length} characters is likely to truncate on smaller screens.`, tone: "bad" }); }

  if (spamMatches.length === 0) feedback.push({ label: "Spam language", message: "No common high-risk trigger phrase was found.", tone: "good" });
  else { score -= Math.min(35, spamMatches.length * 15); feedback.push({ label: "Spam language", message: `Consider replacing: ${spamMatches.join(", ")}.`, tone: spamMatches.length > 1 ? "bad" : "warn" }); }

  if (hasPersonalization) feedback.push({ label: "Personalization", message: "A supported first name, company, or title merge tag is present.", tone: "good" });
  else { score -= 8; feedback.push({ label: "Personalization", message: "Optional: add {{firstName}}, {{company}}, or {{title}} when it makes the subject more specific.", tone: "warn" }); }

  if (questionCount === 1) feedback.push({ label: "Question", message: "One question mark can make the subject feel conversational.", tone: "good" });
  else if (questionCount > 1) { score -= 12; feedback.push({ label: "Question", message: "Multiple question marks can read as pressure. Keep one at most.", tone: "warn" }); }
  else feedback.push({ label: "Question", message: "A question is optional. A direct statement can work just as well when it is specific.", tone: "good" });

  if (urgencyMatches.length === 0) feedback.push({ label: "Urgency", message: "No forced urgency language detected.", tone: "good" });
  else if (urgencyMatches.length === 1 && !spamMatches.includes(urgencyMatches[0]!)) { score -= 5; feedback.push({ label: "Urgency", message: `“${urgencyMatches[0]}” adds pressure. Keep it only if the timing is real.`, tone: "warn" }); }
  else { score -= Math.min(24, urgencyMatches.length * 10); feedback.push({ label: "Urgency", message: `Urgency terms (${urgencyMatches.join(", ")}) can feel promotional unless the deadline is genuine.`, tone: urgencyMatches.length > 1 ? "bad" : "warn" }); }

  const clampedScore = Math.max(0, Math.min(100, score));
  const label = clampedScore >= 85 ? "Strong starting point" : clampedScore >= 65 ? "Worth a quick edit" : "Needs a rewrite";
  return { score: clampedScore, label, feedback, length, spamMatches, urgencyMatches };
}

export function SubjectLineChecker() {
  const [subject, setSubject] = useState("Quick question about {{company}}");
  const result = useMemo(() => analyzeSubject(subject), [subject]);

  return (
    <div className="pages-tool-shell">
      <div className="pages-tool-input">
        <label htmlFor="subject-line">Subject line</label>
        <input id="subject-line" value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="Paste or type a subject line" maxLength={140} />
        <div className="pages-input-meta"><span>Analyzed locally in your browser</span><span>{result.length}/140 characters</span></div>
      </div>
      <aside className="pages-tool-result" aria-live="polite">
        <div className="pages-score"><strong>{result.score}</strong><span><b>{result.label}</b><small>Rules-based score out of 100</small></span></div>
        {result.feedback.length ? <ul className="pages-feedback-list">{result.feedback.map((item) => <li data-tone={item.tone} key={item.label}><b>{item.label}:</b> {item.message}</li>)}</ul> : <p className="pages-empty-state">Type a subject line to see detailed feedback.</p>}
        <p className="pages-tool-soft-cta">A subject line is only one step. <Link href="/app/signup?plan=lifetime">Get the InboxJoy lifetime license</Link> to draft and send the full sequence from Gmail or Outlook.</p>
      </aside>
    </div>
  );
}
