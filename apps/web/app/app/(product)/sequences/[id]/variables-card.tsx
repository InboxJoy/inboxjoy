"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Card, StatusBadge } from "@inboxjoy/ui";
import { apiErrorMessage, apiFetch } from "@/lib/api";
import { coverageLabel, coveragePercent, coverageStatus, leadVariablesQuery, variableToken, type LeadVariablesResponse } from "@/lib/lead-variables";
import type { LeadVariablesView } from "../lead-variables-dialog";

// Coverage of each custom variable across the campaign's audience. Renders nothing when the steps use only built-in variables.
export function VariablesCard({ sequenceId, refreshToken = 0, onOpen }: { sequenceId: string; refreshToken?: number; onOpen: (view: LeadVariablesView) => void }) {
  const [data, setData] = useState<Pick<LeadVariablesResponse, "variables" | "audienceTotal"> | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const requestRef = useRef(0);

  const load = () => {
    const requestId = ++requestRef.current;
    setError("");
    apiFetch<LeadVariablesResponse>(`/v1/sequences/${sequenceId}/lead-variables?${leadVariablesQuery({ pageSize: 1 })}`, {}, "Could not load variable coverage.")
      .then((next) => { if (requestId === requestRef.current) setData({ variables: next.variables, audienceTotal: next.audienceTotal }); })
      .catch((reason) => { if (requestId === requestRef.current) setError(apiErrorMessage(reason, "Could not load variable coverage.")); })
      .finally(() => { if (requestId === requestRef.current) setLoading(false); });
  };

  useEffect(() => { setLoading(true); load(); }, [sequenceId]);
  useEffect(() => { if (refreshToken > 0) load(); }, [refreshToken]);

  if (error && !data) return <Card className="lead-var-card"><div className="lead-var-card__head"><div><h2>Variables</h2></div></div><p className="lead-var-state" role="alert">{error}</p><div><Button variant="ghost" onClick={() => { setLoading(true); load(); }}>Try again</Button></div></Card>;
  if (loading || !data || !data.variables.length) return null;

  const { variables, audienceTotal } = data;
  const missingTotal = variables.reduce((sum, entry) => sum + entry.missing, 0);

  return <Card className="lead-var-card">
    <div className="lead-var-card__head">
      <div><h2>Variables</h2><p>{missingTotal > 0 ? "Fill the missing values so every lead can receive this campaign." : "Every lead has a value for each custom variable."}</p></div>
      <Button variant="secondary" onClick={() => onOpen({ filter: "all" })}>View leads</Button>
    </div>
    <ul aria-label="Custom variables used in this campaign" className="lead-var-list">
      {variables.map((entry) => {
        const status = coverageStatus(entry.missing);
        const percent = coveragePercent(entry.ready, audienceTotal);
        return <li className="lead-var-row" key={entry.name}>
          <button className="lead-var-row__name" title={entry.missing > 0 ? "Show leads missing this value" : "Show leads"} type="button" onClick={() => onOpen({ filter: entry.missing > 0 ? "missing" : "all", variable: entry.name })}><code className="lead-var-chip lead-var-chip--custom">{variableToken(entry.name)}</code></button>
          <span className="lead-var-row__count">{coverageLabel(entry.ready, audienceTotal)}</span>
          <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
          <div aria-hidden="true" className="lead-var-meter"><span style={{ width: `${percent}%` }} /></div>
        </li>;
      })}
    </ul>
    {audienceTotal === 0 ? <p className="lead-var-state">Add leads to this campaign&apos;s audience to see coverage.</p> : null}
  </Card>;
}
