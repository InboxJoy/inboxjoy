"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { leadDisplayName, leadVariablesQuery, type LeadVariablesResponse } from "@/lib/lead-variables";

export type PreviewLead = { id: string; label: string };
type PlainLead = { id: string; email: string; firstName?: string | null; lastName?: string | null };

const OPTION_LIMIT = 20;

function labelFor(lead: { email: string; firstName?: string | null; lastName?: string | null }): string {
  const name = leadDisplayName({ email: lead.email, firstName: lead.firstName ?? null, lastName: lead.lastName ?? null });
  return name === lead.email ? lead.email : `${name} · ${lead.email}`;
}

// Picks the lead an email preview is rendered for. Audience leads come first; any workspace lead is the fallback.
export function PreviewAsLead({ sequenceId, value, onChange }: {
  sequenceId?: string;
  value: PreviewLead | null;
  onChange: (lead: PreviewLead | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<PreviewLead[]>([]);
  const [loading, setLoading] = useState(false);
  const requestRef = useRef(0);

  useEffect(() => {
    if (!sequenceId) return;
    const requestId = ++requestRef.current;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      let found: PreviewLead[] = [];
      try {
        const data = await apiFetch<LeadVariablesResponse>(`/v1/sequences/${sequenceId}/lead-variables?${leadVariablesQuery({ pageSize: OPTION_LIMIT, search: query })}`, {}, "Could not load leads.");
        found = data.leads.map((lead) => ({ id: lead.contactId, label: labelFor(lead) }));
      } catch { /* fall back to workspace leads below */ }
      if (!found.length) {
        try {
          const params = new URLSearchParams({ status: "active", page: "1", pageSize: String(OPTION_LIMIT) });
          if (query.trim()) params.set("q", query.trim());
          const data = await apiFetch<{ leads: PlainLead[] }>(`/v1/leads?${params}`, {}, "Could not load leads.");
          found = data.leads.map((lead) => ({ id: lead.id, label: labelFor(lead) }));
        } catch { found = []; }
      }
      if (requestId !== requestRef.current) return;
      setOptions(found);
      setLoading(false);
    }, query ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [sequenceId, query]);

  if (!sequenceId) return null;
  const choices = value && !options.some((option) => option.id === value.id) ? [value, ...options] : options;

  return <div className="lead-var-preview-as">
    <label>
      <span className="polish-mono-label">Preview as</span>
      <select aria-label="Preview as lead" value={value?.id ?? ""} onChange={(event) => onChange(choices.find((option) => option.id === event.target.value) ?? null)}>
        <option value="">Sample lead (Ada Lovelace)</option>
        {choices.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
    </label>
    <input aria-label="Search leads to preview" className="ph-mask" placeholder="Search leads" type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
    {loading ? <small role="status">Loading leads…</small> : !choices.length && query ? <small role="status">No leads match that search.</small> : null}
  </div>;
}
