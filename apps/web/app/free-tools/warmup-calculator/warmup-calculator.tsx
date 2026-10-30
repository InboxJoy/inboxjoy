"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

const MAX_RAMP_DAYS = 400;

type RampRow = { day: number; allowed: number };

function clampNumber(value: number, min: number, fallback: number) {
  if (!Number.isFinite(value) || value < min) return fallback;
  return value;
}

function buildRamp(start: number, growthPercent: number, cap: number) {
  const growth = 1 + Math.max(0, growthPercent) / 100;
  const rows: RampRow[] = [];
  let reachedFullOn: number | null = null;

  for (let day = 0; day <= MAX_RAMP_DAYS; day += 1) {
    const raw = day === 0 ? start : start * growth ** day;
    const allowed = Math.min(cap, Math.max(start, Math.round(raw)));
    rows.push({ day, allowed });
    if (allowed >= cap) {
      reachedFullOn = day;
      break;
    }
  }

  return { rows, reachedFullOn };
}

function useWarmupCalculator() {
  const [cap, setCap] = useState(35);
  const [mailboxes, setMailboxes] = useState(5);
  const [startVolume, setStartVolume] = useState(8);
  const [growthPercent, setGrowthPercent] = useState(15);
  const [desiredTotal, setDesiredTotal] = useState(500);
  const [helperCap, setHelperCap] = useState(35);

  const result = useMemo(() => {
    const safeCap = Math.max(1, clampNumber(cap, 1, 35));
    const safeStart = Math.max(1, Math.min(clampNumber(startVolume, 1, 8), safeCap));
    const safeGrowth = Math.max(1, clampNumber(growthPercent, 1, 15));
    const safeMailboxes = Math.max(1, Math.round(clampNumber(mailboxes, 1, 5)));

    const { rows, reachedFullOn } = buildRamp(safeStart, safeGrowth, safeCap);
    const totalSendsDuringRamp = rows.reduce((sum, row) => sum + row.allowed, 0);
    const combinedCapacity = safeCap * safeMailboxes;

    const safeDesiredTotal = Math.max(0, clampNumber(desiredTotal, 0, 500));
    const safeHelperCap = Math.max(1, clampNumber(helperCap, 1, 35));
    const mailboxesNeeded = safeDesiredTotal > 0 ? Math.ceil(safeDesiredTotal / safeHelperCap) : 0;

    return {
      cap: safeCap,
      start: safeStart,
      growth: safeGrowth,
      mailboxes: safeMailboxes,
      rows,
      daysToFull: reachedFullOn,
      totalSendsDuringRamp,
      combinedCapacity,
      desiredTotal: safeDesiredTotal,
      helperCap: safeHelperCap,
      mailboxesNeeded,
    };
  }, [cap, mailboxes, startVolume, growthPercent, desiredTotal, helperCap]);

  return {
    cap, setCap,
    mailboxes, setMailboxes,
    startVolume, setStartVolume,
    growthPercent, setGrowthPercent,
    desiredTotal, setDesiredTotal,
    helperCap, setHelperCap,
    result,
  };
}

export function WarmupCalculator() {
  const state = useWarmupCalculator();
  const [showAllRows, setShowAllRows] = useState(false);
  const { result } = state;

  const visibleRows = showAllRows ? result.rows : result.rows.slice(0, 30);
  const hiddenCount = result.rows.length - visibleRows.length;

  return (
    <div className="pages-tool-shell">
      <div className="pages-tool-input">
        <label htmlFor="calc-cap">Warm-up ramp inputs</label>
        <div className="calc-field-grid">
          <label htmlFor="calc-cap">
            Target daily sends per mailbox
            <input id="calc-cap" type="number" min={1} max={500} value={state.cap} onChange={(event) => state.setCap(Number(event.target.value))} />
          </label>
          <label htmlFor="calc-mailboxes">
            Number of mailboxes
            <input id="calc-mailboxes" type="number" min={1} max={500} value={state.mailboxes} onChange={(event) => state.setMailboxes(Number(event.target.value))} />
          </label>
          <label htmlFor="calc-start">
            Starting volume (day 0)
            <input id="calc-start" type="number" min={1} max={200} value={state.startVolume} onChange={(event) => state.setStartVolume(Number(event.target.value))} />
          </label>
          <label htmlFor="calc-growth">
            Daily growth rate (%)
            <input id="calc-growth" type="number" min={1} max={100} value={state.growthPercent} onChange={(event) => state.setGrowthPercent(Number(event.target.value))} />
          </label>
        </div>
        <div className="pages-input-meta"><span>Calculated locally in your browser</span><span>Defaults match InboxJoy&rsquo;s ramp</span></div>

        <div className="calc-field-grid" style={{ marginTop: 24 }}>
          <label htmlFor="calc-desired-total">
            Desired total daily sends (all mailboxes)
            <input id="calc-desired-total" type="number" min={0} max={100000} value={state.desiredTotal} onChange={(event) => state.setDesiredTotal(Number(event.target.value))} />
          </label>
          <label htmlFor="calc-helper-cap">
            Safe per-mailbox cap for that target
            <input id="calc-helper-cap" type="number" min={1} max={500} value={state.helperCap} onChange={(event) => state.setHelperCap(Number(event.target.value))} />
          </label>
        </div>
        <div className="pages-input-meta"><span>Used for the &ldquo;mailboxes needed&rdquo; result</span><span></span></div>
      </div>

      <aside className="pages-tool-result" aria-live="polite">
        <div className="pages-score">
          <strong>{result.daysToFull ?? `${MAX_RAMP_DAYS}+`}</strong>
          <span><b>Days until full speed</b><small>From day 0 at {result.start}/day to {result.cap}/day per mailbox</small></span>
        </div>

        <div className="pages-trigger-summary">
          <div><strong>{result.totalSendsDuringRamp.toLocaleString()}</strong><span>Sends during ramp</span></div>
          <div><strong>{result.combinedCapacity.toLocaleString()}</strong><span>Combined cap once warm</span></div>
          <div><strong>{result.mailboxesNeeded.toLocaleString()}</strong><span>Mailboxes needed</span></div>
        </div>

        <div className="calc-table-wrap">
          <table className="calc-table">
            <thead><tr><th>Day</th><th>Allowed sends</th></tr></thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr key={row.day}><td>{row.day}</td><td>{row.allowed.toLocaleString()}{row.allowed >= result.cap ? " (full speed)" : ""}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        {hiddenCount > 0 ? (
          <button type="button" className="calc-show-more" onClick={() => setShowAllRows(true)}>Show all {result.rows.length} days</button>
        ) : result.rows.length > 30 ? (
          <button type="button" className="calc-show-more" onClick={() => setShowAllRows(false)}>Show fewer rows</button>
        ) : null}

        <p className="pages-tool-soft-cta">
          Mailboxes needed = {result.desiredTotal.toLocaleString()} desired sends ÷ {result.helperCap}/day safe cap, rounded up. <Link href="/app/signup?plan=lifetime">Get the InboxJoy lifetime license</Link> to run this ramp automatically across every mailbox you connect.
        </p>
      </aside>
    </div>
  );
}
