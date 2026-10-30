"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

function clamp(value: number, min: number) {
  return Number.isFinite(value) && value >= min ? value : min;
}

function bouncesUntil(thresholdPercent: number, sent: number, currentBounces: number) {
  if (sent <= 0) return null;
  const needed = Math.ceil((thresholdPercent / 100) * sent - currentBounces - 1e-9);
  return Math.max(0, needed);
}

function analyzeBounces(sent: number, hard: number, soft: number) {
  const safeSent = clamp(sent, 0);
  const safeHard = clamp(hard, 0);
  const safeSoft = clamp(soft, 0);
  const totalBounces = safeHard + safeSoft;

  const hardRate = safeSent > 0 ? (safeHard / safeSent) * 100 : 0;
  const softRate = safeSent > 0 ? (safeSoft / safeSent) * 100 : 0;
  const totalRate = safeSent > 0 ? (totalBounces / safeSent) * 100 : 0;

  const tone = hardRate >= 5 ? "bad" : hardRate >= 2 ? "warn" : "good";
  const label = hardRate >= 5 ? "Critical — InboxJoy stops sending from this mailbox" : totalRate >= 2 ? "Degraded — InboxJoy flags this mailbox" : "Healthy";

  const untilDegraded = bouncesUntil(2, safeSent, safeHard);
  const untilCritical = bouncesUntil(5, safeSent, safeHard);

  return { safeSent, safeHard, safeSoft, totalBounces, hardRate, softRate, totalRate, tone, label, untilDegraded, untilCritical };
}

export function BounceRateCalculator() {
  const [sent, setSent] = useState(2500);
  const [hard, setHard] = useState(20);
  const [soft, setSoft] = useState(15);

  const result = useMemo(() => analyzeBounces(sent, hard, soft), [sent, hard, soft]);

  return (
    <div className="pages-tool-shell">
      <div className="pages-tool-input">
        <label htmlFor="calc-sent">Bounce rate inputs</label>
        <div className="calc-field-grid">
          <label htmlFor="calc-sent">
            Emails sent
            <input id="calc-sent" type="number" min={0} max={1000000} value={sent} onChange={(event) => setSent(Number(event.target.value))} />
          </label>
          <label htmlFor="calc-hard">
            Hard bounces
            <input id="calc-hard" type="number" min={0} max={1000000} value={hard} onChange={(event) => setHard(Number(event.target.value))} />
          </label>
          <label htmlFor="calc-soft">
            Soft bounces
            <input id="calc-soft" type="number" min={0} max={1000000} value={soft} onChange={(event) => setSoft(Number(event.target.value))} />
          </label>
        </div>
        <div className="pages-input-meta"><span>Calculated locally in your browser</span><span>{result.totalBounces.toLocaleString()} total bounces of {result.safeSent.toLocaleString()} sent</span></div>
      </div>

      <aside className="pages-tool-result" aria-live="polite">
        <div className="pages-score">
          <strong>{result.totalRate.toFixed(1)}%</strong>
          <span><b>{result.label}</b><small>Total bounce rate (hard + soft)</small></span>
        </div>

        <div className="pages-trigger-summary">
          <div><strong>{result.hardRate.toFixed(2)}%</strong><span>Hard bounce rate</span></div>
          <div><strong>{result.softRate.toFixed(2)}%</strong><span>Soft bounce rate</span></div>
          <div><strong>{result.totalBounces.toLocaleString()}</strong><span>Total bounces</span></div>
        </div>

        <ul className="pages-feedback-list">
          <li data-tone={result.tone}>
            <b>Status:</b> {result.tone === "good" ? "The hard bounce rate stays under InboxJoy's 2% degraded threshold, so the mailbox keeps sending at its full daily cap." : result.tone === "warn" ? "The hard bounce rate sits at or above InboxJoy's 2% degraded threshold, so a connected mailbox at this rate would run at half its daily cap until it recovers." : "The hard bounce rate sits at or above InboxJoy's 5% critical threshold, so a connected mailbox at this rate would stop sending until the 7-day rate drops."}
          </li>
          <li data-tone={result.untilDegraded === 0 ? "warn" : "good"}>
            <b>Until 2% hard bounces (degraded):</b> {result.untilDegraded === null ? "Add an emails-sent value to calculate this." : result.untilDegraded === 0 ? "Already at or above 2%." : `${result.untilDegraded.toLocaleString()} more hard bounce${result.untilDegraded === 1 ? "" : "s"} out of ${result.safeSent.toLocaleString()} sent would cross 2%.`}
          </li>
          <li data-tone={result.untilCritical === 0 ? "bad" : "good"}>
            <b>Until 5% hard bounces (critical):</b> {result.untilCritical === null ? "Add an emails-sent value to calculate this." : result.untilCritical === 0 ? "Already at or above 5%." : `${result.untilCritical.toLocaleString()} more hard bounce${result.untilCritical === 1 ? "" : "s"} out of ${result.safeSent.toLocaleString()} sent would cross 5%.`}
          </li>
        </ul>

        <p className="pages-tool-soft-cta">
          InboxJoy tracks each mailbox&rsquo;s 7-day bounce rate automatically. <Link href="/app/signup?plan=lifetime">Get the InboxJoy lifetime license</Link> to get flagged before a mailbox reaches these thresholds.
        </p>
      </aside>
    </div>
  );
}
