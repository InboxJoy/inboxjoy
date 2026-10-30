"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button, StatusBadge } from "@inboxjoy/ui";
import { apiErrorMessage, apiFetch } from "@/lib/api";
import {
  adjustCoverage,
  rollbackCoverage,
  leadDisplayName,
  leadVariablesQuery,
  sourceLabel,
  truncateValue,
  variableToken,
  variableUpdateValue,
  withEditedVariable,
  MAX_VARIABLE_VALUE_LENGTH,
  type LeadVariableRow,
  type LeadVariablesFilter,
  type LeadVariablesResponse,
  type VariableCoverage,
} from "@/lib/lead-variables";

type SaveResult = { sequenceId: string; updated: number; notFound: string[]; enrolled: number; rerendered: number; stillMissing: Array<{ email: string; missing: string[] }> };
export type LeadVariablesView = { filter: LeadVariablesFilter; variable?: string };

const PAGE_SIZE = 50;
const FILTERS: Array<{ id: LeadVariablesFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "missing", label: "Missing" },
];

function saveNotice(result: SaveResult): string {
  const parts = ["Saved."];
  if (result.enrolled > 0) parts.push(`${result.enrolled.toLocaleString()} ${result.enrolled === 1 ? "lead" : "leads"} added to the campaign.`);
  if (result.rerendered > 0) parts.push(`${result.rerendered.toLocaleString()} queued ${result.rerendered === 1 ? "email" : "emails"} updated.`);
  return parts.join(" ");
}

// Table of audience leads with one column per custom variable. Click a cell to edit it; an empty value removes it.
export function LeadVariablesDialog({ sequenceId, initialView, onClose, onChanged }: {
  sequenceId: string;
  initialView?: LeadVariablesView;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [filter, setFilter] = useState<LeadVariablesFilter>(initialView?.filter ?? "all");
  const [variable, setVariable] = useState(initialView?.variable ?? "");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [data, setData] = useState<LeadVariablesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<{ contactId: string; name: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const requestRef = useRef(0);
  const editingRef = useRef(editing);
  const onCloseRef = useRef(onClose);
  editingRef.current = editing;
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !editingRef.current) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { setSearch(searchInput); setPage(1); }, searchInput === search ? 0 : 300);
    return () => window.clearTimeout(timer);
  }, [searchInput, search]);

  useEffect(() => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError("");
    void apiFetch<LeadVariablesResponse>(`/v1/sequences/${sequenceId}/lead-variables?${leadVariablesQuery({ filter, variable, page, pageSize: PAGE_SIZE, search })}`, {}, "Could not load lead variables.")
      .then((next) => { if (requestId === requestRef.current) setData(next); })
      .catch((reason) => { if (requestId === requestRef.current) setError(apiErrorMessage(reason, "Could not load lead variables.")); })
      .finally(() => { if (requestId === requestRef.current) setLoading(false); });
  }, [sequenceId, filter, variable, page, search, reload]);

  const variables: VariableCoverage[] = data?.variables ?? [];
  const names = variables.map((entry) => entry.name);
  const shownNames = variable && names.includes(variable) ? [variable] : names;
  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const chooseFilter = (next: LeadVariablesFilter) => { setFilter(next); setPage(1); setEditing(null); };

  const startEdit = (row: LeadVariableRow, name: string) => {
    if (saving) return;
    setEditing({ contactId: row.contactId, name });
    setDraft(row.values[name]?.value ?? "");
    setNotice("");
  };

  const patchRow = (contactId: string, update: (row: LeadVariableRow) => LeadVariableRow, coverage?: (current: VariableCoverage[], before: LeadVariableRow, after: LeadVariableRow) => VariableCoverage[]) => {
    setData((current) => {
      if (!current) return current;
      const before = current.leads.find((lead) => lead.contactId === contactId);
      if (!before) return current;
      const after = update(before);
      return { ...current, leads: current.leads.map((lead) => lead.contactId === contactId ? after : lead), variables: coverage ? coverage(current.variables, before, after) : current.variables };
    });
  };

  const save = async (row: LeadVariableRow, name: string, text: string) => {
    if (saving) return;
    if (text.trim() === (row.values[name]?.value ?? "").trim()) { setEditing(null); return; }
    const edited = withEditedVariable(row, name, text, names);
    setSaving(true);
    setEditing(null);
    setError("");
    patchRow(row.contactId, () => edited, adjustCoverage);
    try {
      const result = await apiFetch<SaveResult>(`/v1/sequences/${sequenceId}/lead-variables`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ leads: [{ contactId: row.contactId, variables: { [name]: variableUpdateValue(text) } }] }),
      }, "Could not save this value.");
      if (result.notFound?.includes(row.contactId)) throw new Error("That lead is no longer available.");
      setNotice(saveNotice(result));
      setReload((current) => current + 1);
      onChanged?.();
    } catch (reason) {
      patchRow(row.contactId, () => row, (current, before) => rollbackCoverage(current, row, before));
      setError(apiErrorMessage(reason, "Could not save this value. The previous value is back."));
    } finally {
      setSaving(false);
    }
  };

  const host = document.querySelector<HTMLElement>(".app-shell") ?? document.body;
  return createPortal(<div className="leads-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section aria-labelledby="lead-variables-title" aria-modal="true" className="leads-modal leads-modal--variables" ref={dialogRef} role="dialog">
      <header className="leads-modal-header">
        <div><p className="ij-eyebrow">Variables</p><h2 id="lead-variables-title">Lead variables</h2><p>Each lead needs a value for every custom variable before this campaign sends. Click a value to edit it.</p></div>
        <button aria-label="Close lead variables" ref={closeRef} type="button" onClick={onClose}>✕</button>
      </header>

      <div className="lead-var-toolbar">
        <div aria-label="Lead filter" className="leads-modal-tabs" role="tablist">
          {FILTERS.map((item) => <button aria-selected={filter === item.id} key={item.id} role="tab" tabIndex={filter === item.id ? 0 : -1} type="button" onClick={() => chooseFilter(item.id)} onKeyDown={(event) => {
            if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); chooseFilter(item.id === "all" ? "missing" : "all"); }
          }}>{item.label}</button>)}
        </div>
        <input aria-label="Search leads" className="lead-var-search ph-mask" placeholder="Search by name or email" type="search" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} />
        {names.length > 1 ? <select aria-label="Variable" className="lead-var-variable-select" value={variable} onChange={(event) => { setVariable(event.target.value); setPage(1); setEditing(null); }}><option value="">All variables</option>{names.map((name) => <option key={name} value={name}>{variableToken(name)}</option>)}</select> : null}
      </div>

      {error ? <p className="leads-modal-error" role="alert">{error}</p> : null}
      {notice ? <p className="lead-var-notice" role="status">{notice}</p> : null}

      <div aria-busy={loading} className={`lead-var-table-wrap${loading && data ? " is-loading" : ""}`}>
        {!data && loading ? <p className="lead-var-state" role="status">Loading leads…</p> : null}
        {!data && !loading && error ? <div className="lead-var-state"><Button variant="ghost" onClick={() => setReload((current) => current + 1)}>Try again</Button></div> : null}
        {data && !data.leads.length ? <p className="lead-var-state">{filter === "missing" ? "Every lead has its values. Nothing is missing." : search ? "No leads match that search." : "No leads in this campaign's audience yet."}</p> : null}
        {data && data.leads.length ? <table className="lead-var-table">
          <thead><tr><th scope="col">Lead</th>{shownNames.map((name) => <th key={name} scope="col"><code>{variableToken(name)}</code></th>)}</tr></thead>
          <tbody>
            {data.leads.map((row) => <tr key={row.contactId}>
              <th className="lead-var-lead ph-mask" scope="row"><strong>{leadDisplayName(row)}</strong>{leadDisplayName(row) !== row.email ? <small>{row.email}</small> : null}</th>
              {shownNames.map((name) => {
                const cell = row.values[name] ?? null;
                const isEditing = editing?.contactId === row.contactId && editing.name === name;
                return <td className={cell ? undefined : "is-missing"} key={name}>
                  {isEditing ? <div className="lead-var-edit">
                    <textarea aria-label={`Value for ${variableToken(name)} for ${leadDisplayName(row)}`} autoFocus maxLength={MAX_VARIABLE_VALUE_LENGTH} placeholder={`Value for ${variableToken(name)}`} rows={3} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
                      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEditing(null); }
                      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(row, name, draft); }
                    }} />
                    <small>Saved for this campaign. Leave empty to remove it.</small>
                    <div><Button disabled={saving} onClick={() => void save(row, name, draft)}>Save</Button><Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button></div>
                  </div> : <button className={`lead-var-cell${cell ? "" : " lead-var-cell--missing"}`} disabled={saving} title={cell ? cell.value : `Add a value for ${variableToken(name)}`} type="button" onClick={() => startEdit(row, name)}>
                    {cell ? <><span className="lead-var-cell__value ph-mask">{truncateValue(cell.value, 90)}</span><span className="lead-var-source">{sourceLabel(cell.source)}</span></> : <><StatusBadge tone="warning">Missing</StatusBadge><span className="lead-var-source">Add value</span></>}
                  </button>}
                </td>;
              })}
            </tr>)}
          </tbody>
        </table> : null}
      </div>

      {data && total > 0 ? <div className="campaign-contacts-pagination lead-var-pagination">
        <span>{total.toLocaleString()} {total === 1 ? "lead" : "leads"} · page {data.page} of {totalPages}</span>
        <div><Button variant="ghost" disabled={data.page <= 1 || loading} onClick={() => setPage(data.page - 1)}>Previous</Button><Button variant="ghost" disabled={data.page >= totalPages || loading} onClick={() => setPage(data.page + 1)}>Next</Button></div>
      </div> : null}
    </section>
  </div>, host);
}
